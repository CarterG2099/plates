/**
 * recipes.js — recipes from Mom's Kitchen, shaped so the food logger can use
 * them without knowing where they came from.
 *
 * Recipes live in `public.recipes`, the other app's table in the same Supabase
 * project, and nutrition on them is per serving. The logger only understands
 * foods, so a recipe is turned into a food draft here — one serving, macros as
 * stored — and from then on it flows through the same amount sheet, the same
 * `persistDraft`, the same `logFood` as a barcode hit would.
 *
 * `recipe_id` rides along as provenance. The food carries its own macro
 * snapshot, and the log snapshots again, so someone editing the recipe next
 * month cannot rewrite what you already ate. That is the same rule every other
 * food obeys; a recipe is not special.
 *
 * Nothing here touches the network. The fetch lives in app.js beside the other
 * online lookups, and this module is what makes its result usable.
 */

import { supabase } from './supabase.js';

const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg'];

/** The columns the logger needs. Ingredients and steps stay in the other app. */
export const COLUMNS = ['id', 'title', 'servings', 'servings_count', 'created_by',
  'nutrition_source', 'updated_at', ...MACROS].join(',');

/** A recipe with at least a calorie figure can be logged; the rest are shown greyed. */
export function hasNutrition(recipe) {
  return recipe?.calories != null && recipe.calories !== '';
}

/**
 * The food draft for one serving of a recipe.
 *
 * Nulls stay null. A recipe whose fibre was never estimated has unknown fibre,
 * not zero fibre, and scaleMacros downstream preserves that — the same bug that
 * once turned a null protein into zero was fixed there and must not be
 * reintroduced from this side.
 */
export function recipeToDraft(recipe) {
  const draft = {
    name: String(recipe.title ?? '').trim() || 'Recipe',
    brand: 'Recipe',
    serving_qty: 1,
    serving_unit: 'serving',
    basis: recipe.servings_count
      ? `1 of ${recipe.servings_count} servings`
      : '1 serving',
    source: 'recipe',
    recipe_id: recipe.id,
    barcode: null,
  };
  for (const m of MACROS) {
    const v = recipe[m];
    draft[m] = v == null || v === '' ? null : Number(v);
  }
  return draft;
}

/** Which required macros a recipe is missing, for the "N missing" pill. */
export function missingMacros(recipe) {
  return ['calories', 'protein_g', 'carbs_g', 'fat_g'].filter((m) => recipe?.[m] == null || recipe[m] === '');
}

/** Search-result rows in the shape the online list already renders. */
export function toResults(recipes) {
  return recipes.filter(hasNutrition).map((r) => ({
    draft: recipeToDraft(r),
    missing: missingMacros(r),
    source: 'Recipe',
  }));
}

/** Case- and accent-insensitive title match on every word of the term. */
export function searchRecipes(recipes, term) {
  const fold = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const words = fold(term).split(/\s+/).filter(Boolean);
  if (!words.length) return recipes;
  return recipes.filter((r) => {
    const hay = fold(r.title);
    return words.every((w) => hay.includes(w));
  });
}

/** The recipe's page in the other app — where nutrition gets added or fixed. */
export function recipeUrl(recipe, { edit = false } = {}) {
  return `https://recipes.cartergividen.com/${edit ? 'edit' : 'recipe'}.html?id=${recipe.id}`;
}

/**
 * Every recipe, from the other app's table.
 *
 * Plain `supabase.from`, not `db()`: that helper pins the `plates` schema and
 * this table is in `public`. Readable with the anon key by that app's design
 * (recipes_public_read), so membership is not a factor here.
 *
 * Tiny table, so no paging and no cache beyond the caller's — fifteen rows is
 * less than one Open Food Facts response.
 */
export async function fetchRecipes() {
  const { data, error } = await supabase
    .from('recipes')
    .select(COLUMNS)
    .order('title', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
