// lookup-usda — searches USDA FoodData Central and returns unsaved drafts for
// the food form to pre-fill. It never writes to the database; the human reviews
// and saves, the same convention as import-photo.
//
// This exists as a function rather than a browser fetch for one reason: USDA
// passes its key as a query parameter, and this repo is public. A key committed
// to docs/ would be scraped. It lives in the USDA_API_KEY function secret.
//
// Members only: we check plates.is_member() with the caller's JWT.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

// Branded first — that is the US store-brand coverage Open Food Facts is weakest
// on, which is the whole reason this fallback exists.
const DATA_TYPES = "Branded,SR Legacy,Foundation";
// USDA's own relevance buries specific products under category noise, so we
// fetch its maximum page and re-rank locally. At 40 the actual Great Value
// peanut butter was not even in the fetched set.
const PAGE_SIZE = 200;
const RETURN_LIMIT = 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// FoodData Central nutrient ids. `nutrientNumber` is carried as a fallback
// because the two identifiers are not consistently populated across datasets.
const NUTRIENTS: Record<string, { id: number; number: string }> = {
  calories: { id: 1008, number: "208" },
  // Some entries carry only kilojoules — "Peanut butter, creamy" is one.
  energy_kj: { id: 1062, number: "268" },
  protein_g: { id: 1003, number: "203" },
  carbs_g: { id: 1005, number: "205" },
  fat_g: { id: 1004, number: "204" },
  fiber_g: { id: 1079, number: "291" },
  sodium_mg: { id: 1093, number: "307" },
};

const REQUIRED = ["calories", "protein_g", "carbs_g", "fat_g"];

interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  value?: number;
}

interface UsdaFood {
  fdcId?: number;
  description?: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  dataType?: string;
  foodNutrients?: UsdaNutrient[];
  // Branded foods carry the label serving directly.
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  // Foundation and SR Legacy carry household measures instead — this is where
  // "1 fruit" for a clementine lives.
  foodMeasures?: { gramWeight?: number; disseminationText?: string }[];
}

function pick(nutrients: UsdaNutrient[], key: string): number | null {
  const want = NUTRIENTS[key];
  const hit = nutrients.find(
    (n) => n.nutrientId === want.id || n.nutrientNumber === want.number,
  );
  const value = Number(hit?.value);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * One serving, wherever USDA gives us one.
 *
 * Search results always report nutrients per 100 g, but that is a measurement
 * basis, not a portion. You search for a clementine to log a clementine, so the
 * per-100g figures are scaled onto whatever serving USDA recorded and the food
 * is stored as `1 serving` — matching the Open Food Facts mapping exactly, so
 * one scaling rule serves both sources.
 *
 * Per 100 g remains the fallback for foods with no recorded portion, because
 * there is then nothing to express a serving in.
 */
function servingOf(food: UsdaFood): { grams: number; label: string } | null {
  // Branded: the label serving, but only as a mass or volume. A "1 bar" serving
  // with no weight cannot be scaled from a per-100g figure.
  const size = Number(food.servingSize);
  const unit = (food.servingSizeUnit ?? "").trim().toLowerCase();
  if (Number.isFinite(size) && size > 0 && (unit === "g" || unit === "ml")) {
    return {
      grams: size,
      label: (food.householdServingFullText ?? "").trim() || `${size} ${unit}`,
    };
  }

  // Foundation / SR Legacy: the first household measure, which is the one USDA
  // treats as the primary portion ("1 fruit", "1 cup, sections").
  for (const measure of food.foodMeasures ?? []) {
    const grams = Number(measure.gramWeight);
    if (Number.isFinite(grams) && grams > 0) {
      return {
        grams,
        label: (measure.disseminationText ?? "").trim() || `${grams} g`,
      };
    }
  }

  return null;
}

function toDraft(food: UsdaFood) {
  const nutrients = food.foodNutrients ?? [];
  const brand = (food.brandName || food.brandOwner || "").trim() || null;
  const serving = servingOf(food);

  // Nutrients are per 100 g; a serving is `grams` of that.
  const factor = serving ? serving.grams / 100 : 1;
  const per = (key: string): number | null => {
    const value = pick(nutrients, key);
    return value == null ? null : Math.round(value * factor * 10) / 10;
  };

  const draft = {
    external_id: food.fdcId ? String(food.fdcId) : null,
    barcode: food.gtinUpc?.trim() || null,
    name: (food.description ?? "").trim() || "Unnamed food",
    brand,
    serving_qty: serving ? 1 : 100,
    serving_unit: serving ? "serving" : "g",
    basis: serving ? serving.label : "per 100 g",
    calories: per("calories") ?? kjToKcal(per("energy_kj")),
    protein_g: per("protein_g"),
    carbs_g: per("carbs_g"),
    fat_g: per("fat_g"),
    fiber_g: per("fiber_g"),
    sodium_mg: per("sodium_mg"),
    source: "usda",
  };

  return {
    draft,
    // Branded vs SR Legacy matters at review time: SR Legacy rows are generic
    // reference foods ("Peanut butter, creamy"), Branded rows are a specific
    // product off a shelf.
    dataType: food.dataType ?? null,
    missing: REQUIRED.filter((k) => draft[k as keyof typeof draft] == null),
  };
}

function kjToKcal(kj: number | null): number | null {
  return kj == null ? null : Math.round(kj / 4.184);
}

/**
 * Rank by how well an entry answers the query, not by how many of its words
 * appear somewhere in the text.
 *
 * Counting term hits scored "Milk, reduced fat, 2% milkfat" and "Puddings,
 * chocolate, dry mix, prepared with 2% milk" identically — both contain "milk"
 * and "2%" — and ties fell through to USDA's own order, which is the category
 * noise this function exists to undo. A search for milk returned pudding.
 *
 * Four signals, in rough order of weight:
 *
 *  - The head noun. USDA descriptions name the food first and qualify it after,
 *    so the first word is what the food IS. Milk is milk; pudding *made with*
 *    milk is pudding. This is what separates them.
 *  - Coverage, as a multiplier rather than a bonus. A short description
 *    answering half the query was otherwise beating a long one answering all of
 *    it, which surfaced "Milk Chocolate Candy Bar" for "milk 2%".
 *  - Where the match landed. Description beats brand: "great value" is a brand,
 *    "peanut butter" is the food.
 *  - Padding. Every word not answering the query costs a little, so a tight
 *    description wins over one carrying the terms incidentally.
 */
function scoreAgainst(terms: string[], food: UsdaFood): number {
  const desc = (food.description ?? "").toLowerCase();
  const brand = [food.brandName, food.brandOwner].filter(Boolean).join(" ").toLowerCase();

  const words = desc.split(/[^a-z0-9%.]+/).filter(Boolean);
  const head = words[0] ?? "";
  const tail = words[words.length - 1] ?? "";

  // A term found in the brand is a brand term even when the description repeats
  // it. Otherwise "Great Value Black Tea" earns description credit for "great
  // value" while "2% Reduced Fat Milk" earns only brand credit, and a search for
  // the brand ranks by whether the maker restated it in the product name — which
  // is how searching "great value" returned black tea instead of milk.
  let inDesc = 0;
  let inBrand = 0;
  for (const term of terms) {
    if (brand && brand.includes(term)) inBrand += 1;
    else if (desc.includes(term)) inDesc += 1;
  }

  const matched = inDesc + inBrand;
  if (!matched) return 0;

  let score = inDesc * 12 + inBrand * 5;

  // Where the head noun sits depends on who wrote the name. Branded names are
  // natural English and put it last ("Great Value Whole Milk"); USDA's own
  // descriptions invert it ("Milk, reduced fat"). Only branded rows get the tail
  // checked — on an SR description the last word is a qualifier, and "Puddings,
  // chocolate, dry mix, prepared with 2% milk" ends in "milk".
  const branded = Boolean(brand) || food.dataType === "Branded";
  const heads = branded ? [head, tail] : [head];

  // Brand words cannot earn the bonus: branded descriptions often lead with the
  // brand, so "great" would hand it to "Great Value Sandwich Cookies".
  const headable = terms.filter((t) => !(brand && brand.includes(t)));
  if (headable.some((t) => heads.some((h) => h && (h.startsWith(t) || (t.length > 3 && t.startsWith(h)))))) {
    score += 45;
  }

  score -= Math.min(Math.max(words.length - matched, 0), 14) * 2;

  return Math.max(score, 0) * (matched / terms.length) ** 1.5;
}

// Deliberately no bonus for Branded entries. It was tried and it put Great Value
// Lemonade at the top of a peanut butter search: brand words and food words score
// identically, so any thumb on the scale for brand matches promotes the wrong
// product.

/** Everything far below the best match is noise, however many slots are free. */
const RELEVANCE_FLOOR = 0.28;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: isMember } = await supabase.schema("plates").rpc("is_member");
  if (!isMember) return json({ error: "Not a Plates member." }, 403);

  const apiKey = Deno.env.get("USDA_API_KEY");
  if (!apiKey) {
    return json({ error: "USDA lookup isn't configured yet (missing USDA_API_KEY)." }, 503);
  }

  let query = "";
  let barcode = "";
  try {
    const body = await req.json();
    query = String(body?.query ?? "").trim();
    barcode = String(body?.barcode ?? "").trim();
  } catch {
    return json({ error: "Expected a JSON body with a query or barcode." }, 400);
  }
  if (!query && !barcode) return json({ error: "Nothing to search for." }, 400);

  const url = new URL(SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", barcode || query);
  url.searchParams.set("dataType", DATA_TYPES);
  url.searchParams.set("pageSize", String(PAGE_SIZE));

  let payload: { foods?: UsdaFood[] };
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      // Surface the status rather than a generic failure: 403 means a bad or
      // revoked key, 429 means the hourly quota is spent. Those need different
      // responses from a human.
      return json({ error: `USDA responded ${res.status}.`, status: res.status }, 502);
    }
    payload = await res.json();
  } catch (e) {
    return json({ error: `Could not reach USDA: ${(e as Error).message}` }, 502);
  }

  const foods = Array.isArray(payload.foods) ? payload.foods : [];

  // A barcode is an exact identity, not a relevance problem. Filter to the
  // product that actually carries it rather than ranking near-misses — this is
  // the path that works for store brands, where name search does not.
  if (barcode) {
    const wanted = normaliseUpc(barcode);
    const exact = foods.filter((f) => f.gtinUpc && normaliseUpc(f.gtinUpc) === wanted);
    return json({
      barcode,
      count: exact.length,
      fetched: foods.length,
      results: exact.map((food) => ({ ...toDraft(food), score: null })),
    });
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = foods
    .map((food) => ({ food, score: scoreAgainst(terms, food) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  const ranked = scored
    .filter((r) => r.score >= best * RELEVANCE_FLOOR)
    .slice(0, RETURN_LIMIT);

  return json({
    query,
    count: ranked.length,
    fetched: foods.length,
    results: ranked.map(({ food, score }) => ({ ...toDraft(food), score })),
  });
});

/** UPC-A and EAN-13 differ only by a leading zero; compare them as the same code. */
function normaliseUpc(code: string): string {
  return code.replace(/\D/g, "").replace(/^0+/, "");
}
