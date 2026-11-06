// The prompts, schemas and answer-cleaning for plan-week, apart from the
// plumbing so tests can import the same source Deno runs (see
// tests/plan-week.test.mjs).

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
type Meal = typeof MEALS[number];

/** Per slot, so a week can't be asked for a hundred lunches. */
export const MAX_PER_MEAL = 14;

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
    meals: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          meal: { type: "STRING", enum: [...MEALS] },
          recipe_id: { type: "INTEGER" },
          reason: { type: "STRING" },
        },
        required: ["meal", "recipe_id", "reason"],
      },
    },
  },
  required: ["meals"],
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

/** How many of each meal, as whole numbers in range; zeros dropped. */
export function cleanCounts(value: unknown): Partial<Record<Meal, number>> {
  const counts: Partial<Record<Meal, number>> = {};
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  for (const meal of MEALS) {
    const n = Math.round(Number(raw[meal]));
    if (n > 0) counts[meal] = Math.min(n, MAX_PER_MEAL);
  }
  return counts;
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

const describeCounts = (counts: Partial<Record<Meal, number>>) =>
  MEALS.filter((m) => counts[m]).map((m) => `${counts[m]} × ${m}`).join(", ");

/**
 * The planning prompt. The recipes go in as data, one JSON object a line, and
 * the model answers with ids only — titles it can misspell, ids it cannot
 * invent past the check in cleanPlan.
 */
export function planPrompt(
  counts: Partial<Record<Meal, number>>,
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

  return "You are planning a household's meals for one week, choosing only from " +
    "their own recipe collection below.\n\n" +
    `Fill exactly these slots: ${describeCounts(counts)}.\n\n` +
    "Rules:\n" +
    "- Use only recipe ids from the list. Never invent a recipe.\n" +
    "- Prefer recipes with \"mine\": true — those are the household's own.\n" +
    "- Fit the slot: breakfast-like recipes for breakfast, mains for lunch and " +
    "dinner, small things for snacks. Judge by title and tags.\n" +
    "- Don't repeat a recipe within the week unless there are fewer suitable " +
    "recipes than slots; then spread the repeats out.\n" +
    target + ate +
    "- reason is one short sentence on why this pick, e.g. \"High protein, and " +
    "you haven't had it this fortnight.\"\n\n" +
    "Return ONLY JSON: {\"meals\": [{\"meal\": slot, \"recipe_id\": number, " +
    "\"reason\": string}]}, one entry per slot filled.\n\n" +
    "Recipes (per serving):\n" +
    recipes.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * The model's plan, kept to what was asked: known recipe ids, requested slots,
 * no more of each than requested. In meal order.
 */
export function cleanPlan(
  parsed: unknown,
  counts: Partial<Record<Meal, number>>,
  recipeIds: Set<number>,
): Array<{ meal: Meal; recipe_id: number; reason: string }> {
  const raw = (parsed as { meals?: unknown })?.meals;
  const meals = Array.isArray(raw) ? raw : [];
  const used: Partial<Record<Meal, number>> = {};
  const out: Array<{ meal: Meal; recipe_id: number; reason: string }> = [];

  for (const m of meals as Array<Record<string, unknown>>) {
    const meal = m?.meal as Meal;
    const id = Number(m?.recipe_id);
    if (!MEALS.includes(meal) || !recipeIds.has(id)) continue;
    if ((used[meal] ?? 0) >= (counts[meal] ?? 0)) continue;
    used[meal] = (used[meal] ?? 0) + 1;
    out.push({ meal, recipe_id: id, reason: String(m?.reason ?? "").trim().slice(0, 200) });
  }

  return out.sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));
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
