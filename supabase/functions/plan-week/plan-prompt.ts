// The prompts, schemas and answer-cleaning for plan-week, apart from the
// plumbing so tests can import the same source Deno runs (see
// tests/plan-week.test.mjs).

/** Recipes cooked in one Sunday session. */
export const MAX_BATCHES = 2;

/** Portions one week's prep can be asked for. */
export const MAX_PORTIONS = 42;

/** Recipes per ingredients request: a week's worth with room for swaps. */
export const MAX_RECIPES = 30;

/**
 * Units an ingredient may come back in. Fixed, because the client adds amounts
 * up by unit, and "Tbsp", "tablespoons" and "T" would be three lines.
 */
export const UNITS = [
  "g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "cup", "fl oz",
  "each", "can", "clove", "pinch", "package", "bunch", "slice",
];

export const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          recipe_id: { type: "INTEGER" },
          reason: { type: "STRING" },
        },
        required: ["recipe_id", "reason"],
      },
    },
  },
  required: ["picks"],
};

export const INGREDIENTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    recipes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          recipe_id: { type: "INTEGER" },
          ingredients: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                qty: { type: "NUMBER", nullable: true },
                unit: { type: "STRING", enum: UNITS, nullable: true },
                staple: { type: "BOOLEAN" },
              },
              required: ["name", "qty", "unit", "staple"],
            },
          },
        },
        required: ["recipe_id", "ingredients"],
      },
    },
  },
  required: ["recipes"],
};

/** The prep being asked for: how many recipes, how many portions, which to leave out. */
export function cleanPrepRequest(body: Record<string, unknown> | null) {
  const batches = Math.min(MAX_BATCHES, Math.max(1, Math.round(Number(body?.batches)) || 1));
  const portions = Math.min(MAX_PORTIONS, Math.max(1, Math.round(Number(body?.portions)) || 10));
  return { batches, portions, exclude: cleanRecipeIds(body?.exclude) };
}

/** Recipe ids as positive integers, deduplicated and capped. */
export function cleanRecipeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_RECIPES);
}

export interface RecipeSummary {
  id: number;
  title: string;
  tags: string[] | null;
  mine: boolean;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

export interface Goal {
  calorie_target: number | null;
  protein_target_g: number | null;
}

/**
 * The suggestion prompt. The recipes go in as data, one JSON object a line,
 * and the model answers with ids only — titles it can misspell, ids it cannot
 * invent past the check in cleanPicks.
 */
export function planPrompt(
  request: { batches: number; portions: number; exclude: number[] },
  recipes: RecipeSummary[],
  goal: Goal | null,
  recent: string[],
): string {
  const target = goal?.calorie_target || goal?.protein_target_g
    ? `The main eater's daily targets: ${goal?.calorie_target ?? "?"} kcal, ` +
      `${goal?.protein_target_g ?? "?"} g protein. Favour recipes that help hit the ` +
      "protein target without blowing the calories.\n"
    : "";
  const ate = recent.length
    ? `Eaten often in the last two weeks (vary away from these): ${recent.join("; ")}.\n`
    : "";
  const skip = request.exclude.length
    ? `Do not pick these ids, they are already chosen or turned down: ${request.exclude.join(", ")}.\n`
    : "";

  return "A household cooks once on Sunday and eats it all week: dinners for two, " +
    "sometimes lunches. Breakfast-for-dinner counts as dinner.\n\n" +
    `Pick ${request.batches} recipe${request.batches === 1 ? "" : "s"} from their ` +
    `collection below to batch-cook ${request.portions} portions in total.\n\n` +
    "Rules:\n" +
    "- Use only recipe ids from the list. Never invent a recipe.\n" +
    "- Only real meals. Not dressings, sauces, dips, sides, desserts, snacks, " +
    "drinks, baking, or anything that isn't food. Judge by title and tags.\n" +
    "- It must keep well in the fridge for several days and reheat or eat cold.\n" +
    "- Prefer recipes with \"mine\": true — those are the household's own.\n" +
    "- With two picks, make them different from each other.\n" +
    skip + target + ate +
    "- reason is one short sentence on why it suits this week's prep.\n\n" +
    "Return ONLY JSON: {\"picks\": [{\"recipe_id\": number, \"reason\": string}]}.\n\n" +
    "Recipes (per serving):\n" +
    recipes.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * The model's picks, kept to what was asked: known recipe ids, none excluded,
 * no repeats, no more than requested.
 */
export function cleanPicks(
  parsed: unknown,
  request: { batches: number; exclude: number[] },
  recipeIds: Set<number>,
): Array<{ recipe_id: number; reason: string }> {
  const raw = (parsed as { picks?: unknown })?.picks;
  const out: Array<{ recipe_id: number; reason: string }> = [];
  const seen = new Set(request.exclude);
  for (const p of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>) {
    const id = Number(p?.recipe_id);
    if (!recipeIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ recipe_id: id, reason: String(p?.reason ?? "").trim().slice(0, 200) });
    if (out.length >= request.batches) break;
  }
  return out;
}

/** The ingredients prompt: each recipe's lines, verbatim, to be read not rewritten. */
export function ingredientsPrompt(recipes: Array<{ id: number; title: string; ingredients: string[] }>): string {
  return "Turn each recipe's ingredient lines into shopping-list entries.\n\n" +
    "For each ingredient line give:\n" +
    "- name: what you would look for in a grocery store, lower case, singular, " +
    "without amounts or preparation. \"2 cups shredded cooked chicken breast\" → " +
    "\"chicken breast\"; \"1½ teaspoons extra-virgin olive oil\" → \"olive oil\".\n" +
    "- qty: the amount as written, as a number (½ is 0.5). null if none is given.\n" +
    `- unit: one of ${UNITS.join(", ")}, or null for a plain count. Keep the ` +
    "recipe's unit; do not convert.\n" +
    "- staple: true only for salt, pepper, water, cooking oil, and common dried " +
    "spices most kitchens already have.\n" +
    "Skip lines that aren't ingredients, such as \"For the sauce:\". A line that " +
    "names another recipe (\"½ cup Peanut Dressing\") is still one entry.\n\n" +
    "Return ONLY JSON: {\"recipes\": [{\"recipe_id\": number, \"ingredients\": " +
    "[{\"name\": string, \"qty\": number|null, \"unit\": string|null, " +
    "\"staple\": boolean}]}]}.\n\n" +
    recipes.map((r) =>
      `Recipe ${r.id} — ${r.title}:\n` + r.ingredients.map((line) => `- ${line}`).join("\n")
    ).join("\n\n");
}

/** The name an ingredient is matched on: lower case, single-spaced. */
export function ingredientKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The model's ingredients, by recipe id, for the recipes that were asked
 * about. Amounts that aren't positive numbers become null rather than zero:
 * "to taste" is unknown, not none.
 */
export function cleanIngredients(parsed: unknown, recipeIds: Set<number>) {
  const raw = (parsed as { recipes?: unknown })?.recipes;
  const out: Record<number, Array<{ key: string; name: string; qty: number | null; unit: string | null; staple: boolean }>> = {};

  for (const r of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>) {
    const id = Number(r?.recipe_id);
    if (!recipeIds.has(id)) continue;
    out[id] = ((Array.isArray(r.ingredients) ? r.ingredients : []) as Array<Record<string, unknown>>)
      .map((i) => {
        const name = String(i?.name ?? "").trim();
        const qty = Number(i?.qty);
        const unit = UNITS.includes(String(i?.unit)) ? String(i.unit) : null;
        return {
          key: ingredientKey(name),
          name,
          qty: i?.qty != null && qty > 0 ? qty : null,
          unit,
          staple: i?.staple === true,
        };
      })
      .filter((i) => i.name);
  }
  return out;
}
