// ranking.ts — the pure half of lookup-usda: mapping and ranking, no I/O.
//
// Split out of index.ts so it can be tested. index.ts imports `jsr:` and calls
// Deno.serve at module scope, so importing it from `node --test` fails before a
// single assertion runs. Nothing in here touches the network, Deno, or the
// clock, which is exactly what makes it worth testing.
//
// Deno resolves `./ranking.ts` and Node strips the types on import, so the same
// file serves the function and the suite.

// FoodData Central nutrient ids. `nutrientNumber` is carried as a fallback
// because the two identifiers are not consistently populated across datasets.
export const NUTRIENTS: Record<string, { id: number; number: string }> = {
  calories: { id: 1008, number: "208" },
  // Some entries carry only kilojoules — "Peanut butter, creamy" is one.
  energy_kj: { id: 1062, number: "268" },
  protein_g: { id: 1003, number: "203" },
  carbs_g: { id: 1005, number: "205" },
  fat_g: { id: 1004, number: "204" },
  fiber_g: { id: 1079, number: "291" },
  sodium_mg: { id: 1093, number: "307" },

  // The rest of the label. USDA publishes all of these and the six above were
  // simply all anyone had asked for — which is why a searched food printed a
  // five-row label while the same food scanned printed the full panel.
  saturated_fat_g: { id: 1258, number: "606" },
  trans_fat_g: { id: 1257, number: "605" },
  cholesterol_mg: { id: 1253, number: "601" },
  sugars_g: { id: 2000, number: "269" },
  added_sugars_g: { id: 1235, number: "539" },
  calcium_mg: { id: 1087, number: "301" },
  iron_mg: { id: 1089, number: "303" },
  potassium_mg: { id: 1092, number: "306" },
  // D2 + D3 in micrograms, which is what the label prints.
  vitamin_d_mcg: { id: 1114, number: "328" },
};

/** Everything the label can print, in the order plates.foods stores it. */
export const LABEL_NUTRIENTS = [
  "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "sodium_mg",
  "saturated_fat_g", "trans_fat_g", "cholesterol_mg",
  "sugars_g", "added_sugars_g",
  "vitamin_d_mcg", "calcium_mg", "iron_mg", "potassium_mg",
];

export const REQUIRED = ["calories", "protein_g", "carbs_g", "fat_g"];

/** Everything far below the best match is noise, however many slots are free. */
export const RELEVANCE_FLOOR = 0.28;

export interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  value?: number;
}

export interface UsdaFood {
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

export function pick(nutrients: UsdaNutrient[], key: string): number | null {
  const want = NUTRIENTS[key];
  const hit = nutrients.find(
    (n) => n.nutrientId === want.id || n.nutrientNumber === want.number,
  );
  const value = Number(hit?.value);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function kjToKcal(kj: number | null): number | null {
  return kj == null ? null : Math.round(kj / 4.184);
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
export function servingOf(food: UsdaFood): { grams: number; label: string } | null {
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

/**
 * Undo USDA's shouting.
 *
 * Branded descriptions are stored in caps — "GREAT VALUE, BLACK TEA" — which
 * arrives in the UI as a shouted row. SR Legacy and Foundation descriptions are
 * already sentence case, so only names that are genuinely almost all uppercase
 * are rewritten; anything else is left exactly as USDA wrote it.
 */
export function tidyName(text: string): string {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return text;

  const upper = (text.match(/[A-Z]/g) ?? []).length;
  if (upper / letters.length < 0.8) return text;

  return text.toLowerCase().replace(
    /(^|[\s(\[\/-])([a-z])/g,
    (_, lead: string, c: string) => lead + c.toUpperCase(),
  );
}

export function toDraft(food: UsdaFood) {
  const nutrients = food.foodNutrients ?? [];
  const rawBrand = (food.brandName || food.brandOwner || "").trim();
  const brand = rawBrand ? tidyName(rawBrand) : null;
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
    name: tidyName((food.description ?? "").trim()) || "Unnamed food",
    brand,
    serving_qty: serving ? 1 : 100,
    serving_unit: serving ? "serving" : "g",
    basis: serving ? serving.label : "per 100 g",
    // Every nutrient the label prints, scaled onto the serving like the rest.
    // Named individually before, which is exactly how the extra nine went
    // missing from every searched food.
    ...Object.fromEntries(LABEL_NUTRIENTS.map((k) => [k, per(k)])),
    calories: per("calories") ?? kjToKcal(per("energy_kj")),
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
export function scoreAgainst(terms: string[], food: UsdaFood): number {
  const desc = (food.description ?? "").toLowerCase();
  const brand = [food.brandName, food.brandOwner].filter(Boolean).join(" ").toLowerCase();

  const words = desc.split(/[^a-z0-9%.]+/).filter(Boolean);
  const head = words[0] ?? "";
  const tail = words[words.length - 1] ?? "";

  // Whole words, not substrings. "myprotein".includes("protein") is true, so a
  // substring test classified "protein" as a brand word when searching
  // Myprotein — worth 5 instead of 12, and barred from the head bonus, on a
  // product literally called "Impact Whey Protein".
  const brandWords = brand.split(/[^a-z0-9%.]+/).filter(Boolean);
  const isBrandTerm = (t: string) => brandWords.some((w) => w.startsWith(t));

  // A term found in the brand is a brand term even when the description repeats
  // it. Otherwise "Great Value Black Tea" earns description credit for "great
  // value" while "2% Reduced Fat Milk" earns only brand credit, and a search for
  // the brand ranks by whether the maker restated it in the product name — which
  // is how searching "great value" returned black tea instead of milk.
  let inDesc = 0;
  let inBrand = 0;
  for (const term of terms) {
    if (isBrandTerm(term)) inBrand += 1;
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
  const headable = terms.filter((t) => !isBrandTerm(t));
  if (headable.some((t) => heads.some((h) => h && (h.startsWith(t) || (t.length > 3 && t.startsWith(h)))))) {
    score += 45;
  }

  // Padding punishes a long description that carries the query incidentally.
  // That only makes sense for a description match — on a brand match the other
  // words are the product's own name, not noise. Applying it flat meant a
  // brand-only search scored that brand's products at zero: "myprotein" cost
  // more in padding (-8) than it earned in brand credit (+5).
  const padding = Math.min(Math.max(words.length - matched, 0), 14) * 2;
  score -= padding * (inDesc / matched);

  return Math.max(score, 0) * (matched / terms.length) ** 1.5;
}

// Deliberately no bonus for Branded entries. It was tried and it put Great Value
// Lemonade at the top of a peanut butter search: brand words and food words score
// identically, so any thumb on the scale for brand matches promotes the wrong
// product.

/**
 * Rank, cut the noise, and cap.
 *
 * Kept here rather than inline in the handler so the floor and the limit are
 * covered by tests too — they decide what a search returns just as much as the
 * score does.
 */
export function rankFoods(foods: UsdaFood[], terms: string[], limit: number) {
  const scored = foods
    .map((food) => ({ food, score: scoreAgainst(terms, food) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  return scored.filter((r) => r.score >= best * RELEVANCE_FLOOR).slice(0, limit);
}

/**
 * Query words that matched nothing anywhere.
 *
 * A typo silently degrades the query — "2% great value mlik" quietly becomes a
 * search for "2% great value", and the results look confident rather than wrong.
 */
export function unmatchedTerms(terms: string[], foods: UsdaFood[]): string[] {
  return terms.filter((t) => !foods.some((f) => {
    const hay = [f.description, f.brandName, f.brandOwner].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(t);
  }));
}

/** UPC-A and EAN-13 differ only by a leading zero; compare them as the same code. */
export function normaliseUpc(code: string): string {
  return code.replace(/\D/g, "").replace(/^0+/, "");
}
