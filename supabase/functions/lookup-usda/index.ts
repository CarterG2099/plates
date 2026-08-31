// lookup-usda — food name search. Despite the name it now queries USDA
// FoodData Central *and* Open Food Facts, and returns unsaved drafts for the
// food form to pre-fill. It never writes to the database; the human reviews and
// saves, the same convention as import-photo.
//
// Two reasons this is a function rather than a browser fetch:
//   - USDA passes its key as a query parameter, and this repo is public. A key
//     committed to docs/ would be scraped. It lives in the USDA_API_KEY secret.
//   - OFF's search endpoint sends no CORS header and 503s a browser User-Agent.
//     Its *barcode* endpoint does neither, which is why that one still runs in
//     the page.
//
// Members only: we check plates.is_member() with the caller's JWT.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  type UsdaFood,
  normaliseUpc,
  rankFoods,
  toDraft,
  unmatchedTerms,
} from "./ranking.ts";

const SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";

// Open Food Facts, searched here rather than from the page. The barcode endpoint
// is browser-callable and still is; search is not.
//
// This is their newer Search-a-licious service, not the legacy
// world.openfoodfacts.org/cgi/search.pl. That one answered every request from
// the Edge Function with a 503 — observed live, not guessed — which read exactly
// like "OFF has no MyProtein" when in fact OFF has 2,322 MyProtein products and
// was simply refusing to talk to us.
const OFF_SEARCH_URL = "https://search.openfoodfacts.org/search";
const OFF_FIELDS = "code,product_name,generic_name,brands,nutriments"
  + ",serving_size,serving_quantity,serving_quantity_unit";
// Raised for brands USDA cannot help with at all. MyProtein is UK-only, so
// every result has to come from OFF, and twelve slots fill up with generic
// protein powders before a specific brand appears.
const OFF_PAGE_SIZE = 30;
// OFF asks for a descriptive agent and throttles anything that omits one.
const OFF_AGENT = "Plates/1.0 (https://plates.cartergividen.com)";
const OFF_TIMEOUT_MS = 9000;

// The search service does not return serving fields — it drops serving_size even
// when you ask for it — so every result came back measured in 100 g. The single
// product endpoint does return them ("1 scoop (31 g)"), and it is the only OFF
// endpoint that answers us at all: both search endpoints on world.openfoodfacts
// .org 503. So the servings are fetched one product at a time, for the handful
// likely to be shown.
//
// Nutriments come back on the same request. The search index carries a reduced
// set of them, which is why a searched food printed a thinner label than the
// same food scanned — the barcode path always went to this endpoint and got
// everything. Asking for both here costs nothing extra and makes the two paths
// agree.
const OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const OFF_ENRICH_LIMIT = 10;
const OFF_ENRICH_TIMEOUT_MS = 4000;

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

type FetchResult = { foods: UsdaFood[] } | { error: string; status?: number };

async function fetchFoods(
  query: string,
  apiKey: string,
  requireAllWords: boolean,
): Promise<FetchResult> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("dataType", DATA_TYPES);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  if (requireAllWords) url.searchParams.set("requireAllWords", "true");

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      // Surface the status rather than a generic failure: 403 means a bad or
      // revoked key, 429 means the hourly quota is spent. Those need different
      // responses from a human.
      return { error: `USDA responded ${res.status}.`, status: res.status };
    }
    const payload = await res.json();
    return { foods: Array.isArray(payload.foods) ? payload.foods : [] };
  } catch (e) {
    return { error: `Could not reach USDA: ${(e as Error).message}` };
  }
}

/**
 * Raw OFF products, unmapped.
 *
 * Deliberately not converted to drafts here: the mapping — serving basis,
 * kJ fallback, sodium in grams — already exists in the client's lookup.js and
 * must stay in one place, or the barcode path and the search path will drift.
 */
async function fetchOff(query: string): Promise<{ products: unknown[]; error: string }> {
  const url = `${OFF_SEARCH_URL}?q=${encodeURIComponent(query)}`
    + `&page_size=${OFF_PAGE_SIZE}&fields=${OFF_FIELDS}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": OFF_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) return { products: [], error: `${res.status}` };

    const payload = await res.json();
    // Search-a-licious calls them hits; the legacy endpoint called them products.
    const hits = Array.isArray(payload?.hits) ? payload.hits : [];
    await enrichServings(hits);
    return { products: hits, error: "" };
  } catch (e) {
    const err = e as Error;
    return { products: [], error: err.name === "AbortError" ? "timed out" : (err.message ?? "failed") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fill in the serving sizes the search service omitted.
 *
 * Best-effort and parallel: a product that fails to enrich keeps its per-100g
 * basis rather than dropping out, which is the same trade the mapping already
 * makes for products that genuinely have no serving recorded.
 */
async function enrichServings(hits: Record<string, unknown>[]): Promise<void> {
  const targets = hits.slice(0, OFF_ENRICH_LIMIT).filter((h) => h?.code);

  await Promise.all(targets.map(async (hit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OFF_ENRICH_TIMEOUT_MS);
    try {
      const url = `${OFF_PRODUCT_URL}/${encodeURIComponent(String(hit.code))}.json`
        + `?fields=serving_size,serving_quantity,serving_quantity_unit,nutriments`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": OFF_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) return;

      const product = (await res.json())?.product;
      if (!product) return;

      for (const key of ["serving_size", "serving_quantity", "serving_quantity_unit"]) {
        if (product[key] != null) hit[key] = product[key];
      }

      // The full set replaces the index's reduced one outright rather than
      // merging: they describe the same product on the same basis, and the
      // product endpoint is the more complete of the two.
      if (product.nutriments && typeof product.nutriments === "object") {
        hit.nutriments = product.nutriments;
      }
    } catch {
      // Keep the un-enriched hit.
    } finally {
      clearTimeout(timer);
    }
  }));
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
  let barcode = "";
  try {
    const body = await req.json();
    query = String(body?.query ?? "").trim();
    barcode = String(body?.barcode ?? "").trim();
  } catch {
    return json({ error: "Expected a JSON body with a query or barcode." }, 400);
  }
  if (!query && !barcode) return json({ error: "Nothing to search for." }, 400);

  const term = barcode || query;
  const multiWord = !barcode && term.split(/\s+/).filter(Boolean).length > 1;

  // Two passes, merged.
  //
  // The default OR-match returns anything containing ANY query word, so
  // "2% milk great value" competes with every food carrying "value" or "milk" —
  // and a specific store-brand product can fall outside the 200 rows we get
  // back. No amount of re-ranking recovers an item that was never fetched.
  //
  // requireAllWords forces AND matching, which finds that exact product but
  // returns nothing when a word lives in a field USDA doesn't match on. Running
  // both and merging gets the strictness without the cliff.
  const passes = [fetchFoods(term, apiKey, false)];
  if (multiWord) passes.push(fetchFoods(term, apiKey, true));

  // Open Food Facts runs alongside, not after. It covers the store brands USDA's
  // manufacturer-submitted set misses, and neither source waits on the other.
  const offPromise = barcode
    ? Promise.resolve({ products: [] as unknown[], error: "" })
    : fetchOff(term);

  const [settled, off] = await Promise.all([Promise.all(passes), offPromise]);

  // A USDA outage must not discard OFF's results — that is the entire reason
  // for asking two sources. Only fail outright when nothing at all came back.
  const usdaDown = settled.every((r) => "error" in r);
  const usdaError = usdaDown ? (settled[0] as { error: string }).error : "";
  if (usdaDown && !off.products.length) {
    return json({ error: usdaError, offError: off.error }, 502);
  }

  // Deduped by fdcId, strict pass first so its hits survive.
  const byId = new Map<number | string, UsdaFood>();
  for (const result of settled.slice().reverse()) {
    if ("error" in result) continue;
    for (const food of result.foods) byId.set(food.fdcId ?? food.description ?? "", food);
  }
  const foods = [...byId.values()];

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
  const ranked = rankFoods(foods, terms, RETURN_LIMIT);

  const unmatched = unmatchedTerms(terms, foods);

  return json({
    query,
    count: ranked.length,
    fetched: foods.length,
    unmatched,
    error: usdaError,
    results: ranked.map(({ food, score }) => ({ ...toDraft(food), score })),
    // Raw, for the client to map with the same code the barcode path uses.
    off: off.products,
    offError: off.error,
  });
});

