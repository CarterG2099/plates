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
const PAGE_SIZE = 15;

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
    calories: pick(nutrients, "calories"),
    protein_g: pick(nutrients, "protein_g"),
    carbs_g: pick(nutrients, "carbs_g"),
    fat_g: pick(nutrients, "fat_g"),
    fiber_g: pick(nutrients, "fiber_g"),
    sodium_mg: pick(nutrients, "sodium_mg"),
    source: "usda",
  };

  return {
    draft,
    missing: REQUIRED.filter((k) => draft[k as keyof typeof draft] == null),
  };
}

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
  try {
    const body = await req.json();
    query = String(body?.query ?? "").trim();
  } catch {
    return json({ error: "Expected a JSON body with a query." }, 400);
  }
  if (!query) return json({ error: "Nothing to search for." }, 400);

  const url = new URL(SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
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
  return json({
    query,
    count: foods.length,
    results: foods.map(toDraft),
  });
});
