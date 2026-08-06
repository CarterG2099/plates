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
const RETURN_LIMIT = 15;

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
 * Search results report per 100 g, so drafts are normalised to a 100 g serving —
 * identical to the Open Food Facts mapping, which keeps one scaling rule in the
 * client rather than one per source.
 */
function toDraft(food: UsdaFood) {
  const nutrients = food.foodNutrients ?? [];
  const brand = (food.brandName || food.brandOwner || "").trim() || null;

  const draft = {
    external_id: food.fdcId ? String(food.fdcId) : null,
    barcode: food.gtinUpc?.trim() || null,
    name: (food.description ?? "").trim() || "Unnamed food",
    brand,
    serving_qty: 100,
    serving_unit: "g",
    calories: pick(nutrients, "calories") ?? kjToKcal(pick(nutrients, "energy_kj")),
    protein_g: pick(nutrients, "protein_g"),
    carbs_g: pick(nutrients, "carbs_g"),
    fat_g: pick(nutrients, "fat_g"),
    fiber_g: pick(nutrients, "fiber_g"),
    sodium_mg: pick(nutrients, "sodium_mg"),
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
 * Rank by how many of the query's words the entry actually accounts for.
 *
 * USDA matches words against the description only, so "great value peanut
 * butter" either OR-matches into noise (Reese's cups, lemonade) or, with
 * requireAllWords, returns nothing at all — because "great" and "value" live in
 * the brand fields, not the description. Scoring across description *and* brand
 * degrades gracefully instead of failing at either extreme.
 */
function scoreAgainst(terms: string[], food: UsdaFood): number {
  const haystack = [food.description, food.brandName, food.brandOwner]
    .filter(Boolean).join(" ").toLowerCase();

  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

// Deliberately no bonus for Branded entries. It was tried and it put Great Value
// Lemonade at the top of a peanut butter search: brand words and food words score
// identically, so any thumb on the scale for brand matches promotes the wrong
// product. Ties fall back to USDA's own order.

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
  const ranked = foods
    .map((food) => ({ food, score: scoreAgainst(terms, food) }))
    .sort((a, b) => b.score - a.score)
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
