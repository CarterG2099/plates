/**
 * plan-week: what the model is asked, and what of its answer is kept.
 *
 * The prompt module is imported straight from supabase/functions, so this is
 * the source Deno runs. The model's answer is never trusted past cleanPlan and
 * cleanIngredients: recipe ids it invents, slots nobody asked for and units the
 * client can't add up are all dropped there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const p = await import('../supabase/functions/plan-week/plan-prompt.ts');
const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('a prep request is one or two recipes, a sane number of portions, and ids to leave out', () => {
  assert.deepEqual(p.cleanPrepRequest({ batches: 2, portions: 10, exclude: [3, 'x', 3] }),
    { batches: 2, portions: 10, exclude: [3] });
  assert.deepEqual(p.cleanPrepRequest({ batches: 9, portions: 900 }), { batches: p.MAX_BATCHES, portions: p.MAX_PORTIONS, exclude: [] });
  assert.deepEqual(p.cleanPrepRequest({ batches: 0, portions: -4 }), { batches: 1, portions: 1, exclude: [] });
  assert.deepEqual(p.cleanPrepRequest(null), { batches: 1, portions: 10, exclude: [] });
});

test('recipe ids are positive integers, once each, capped', () => {
  assert.deepEqual(p.cleanRecipeIds([3, '3', 4, -1, 'x', 2.5]), [3, 4]);
  assert.equal(p.cleanRecipeIds(Array.from({ length: 50 }, (_, i) => i + 1)).length, p.MAX_RECIPES);
  assert.deepEqual(p.cleanRecipeIds('3'), []);
});

const RECIPES = [
  { id: 7, title: 'Peanut Chicken Bowl', tags: ['dinner'], mine: true, calories: 520, protein_g: 42, carbs_g: 30, fat_g: 22 },
  { id: 9, title: 'Overnight Oats', tags: ['breakfast'], mine: false, calories: 380, protein_g: 20, carbs_g: 50, fat_g: 9 },
];

test('the prompt asks for a Sunday batch of real meals, with the recipes as data', () => {
  const text = p.planPrompt({ batches: 2, portions: 10, exclude: [] }, RECIPES,
    { calorie_target: 2400, protein_target_g: 190 }, ['Greek yogurt (6×)']);
  assert.match(text, /cooks once on Sunday and eats it all week/);
  assert.match(text, /Pick 2 recipes from their collection below to batch-cook 10 portions in total\./);
  assert.match(text, /Not dressings, sauces, dips, sides, desserts, snacks/);
  assert.match(text, /Breakfast-for-dinner counts as dinner/);
  assert.match(text, /2400 kcal, 190 g protein/);
  assert.match(text, /Greek yogurt \(6×\)/);
  assert.ok(text.includes(JSON.stringify(RECIPES[0])), 'each recipe as one JSON line');
});

test('one recipe reads as one, and the excluded ids are named', () => {
  const text = p.planPrompt({ batches: 1, portions: 5, exclude: [7, 9] }, RECIPES, null, []);
  assert.match(text, /Pick 1 recipe from/);
  assert.match(text, /Do not pick these ids, they are already chosen or turned down: 7, 9\./);
  assert.doesNotMatch(text, /targets|Eaten often/);
});

test('the picks keep known recipes, none excluded, no repeats, no more than asked', () => {
  const answer = { picks: [
    { recipe_id: 404, reason: 'Invented.' },
    { recipe_id: 7, reason: 'Excluded.' },
    { recipe_id: 9, reason: 'Good.' },
    { recipe_id: 9, reason: 'Again.' },
    { recipe_id: 11, reason: 'Second.' },
    { recipe_id: 12, reason: 'One too many.' },
  ] };
  const kept = p.cleanPicks(answer, { batches: 2, exclude: [7] }, new Set([7, 9, 11, 12]));
  assert.deepEqual(kept, [{ recipe_id: 9, reason: 'Good.' }, { recipe_id: 11, reason: 'Second.' }]);
});

test('an answer with no picks is an empty list, not a crash', () => {
  assert.deepEqual(p.cleanPicks({}, { batches: 2, exclude: [] }, new Set([7])), []);
  assert.deepEqual(p.cleanPicks(null, { batches: 2, exclude: [] }, new Set([7])), []);
});

test('the ingredients prompt carries every line verbatim and the fixed units', () => {
  const text = p.ingredientsPrompt([{ id: 7, title: 'Peanut Chicken Bowl',
    ingredients: ['1½ teaspoons extra-virgin olive oil', '2 cups shredded cooked chicken breast (see Tip)'] }]);
  assert.match(text, /Recipe 7 — Peanut Chicken Bowl:\n- 1½ teaspoons extra-virgin olive oil\n- 2 cups shredded/);
  assert.match(text, /one of g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz,/);
  assert.match(text, /do not convert/);
});

test('ingredients are keyed by name, units outside the list dropped, and missing amounts stay null', () => {
  const answer = { recipes: [
    { recipe_id: 7, ingredients: [
      { name: 'Chicken  Breast', qty: 2, unit: 'cup', staple: false },
      { name: 'olive oil', qty: 1.5, unit: 'teaspoons', staple: true },
      { name: 'salt', qty: 0, unit: null, staple: true },
      { name: '', qty: 1, unit: 'cup', staple: false },
    ] },
    { recipe_id: 404, ingredients: [{ name: 'ghost', qty: 1, unit: null, staple: false }] },
  ] };
  const out = p.cleanIngredients(answer, new Set([7]));
  assert.deepEqual(Object.keys(out), ['7']);
  assert.deepEqual(out[7], [
    { key: 'chicken breast', name: 'Chicken  Breast', qty: 2, unit: 'cup', staple: false },
    { key: 'olive oil', name: 'olive oil', qty: 1.5, unit: null, staple: true },
    { key: 'salt', name: 'salt', qty: null, unit: null, staple: true },
  ]);
});

test('the response schemas bind the units and ids the client relies on', () => {
  const ing = p.INGREDIENTS_SCHEMA.properties.recipes.items.properties.ingredients.items.properties;
  assert.deepEqual(ing.unit.enum, p.UNITS);
  assert.equal(p.PLAN_SCHEMA.properties.picks.items.properties.recipe_id.type, 'INTEGER');
});

// ---- the function --------------------------------------------------------------

test('plan-week checks membership with the caller\'s token and uses the anon key, never service role', async () => {
  const src = await read('../supabase/functions/plan-week/index.ts');
  assert.match(src, /rpc\("is_member"\)/);
  assert.match(src, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(src, /SERVICE_ROLE/);
  assert.doesNotMatch(src, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/, 'a draft writes nothing');
});

test('its Gemini helper is the same file read-food-photo uses', async () => {
  assert.equal(await read('../supabase/functions/plan-week/gemini.ts'),
    await read('../supabase/functions/read-food-photo/gemini.ts'));
});
