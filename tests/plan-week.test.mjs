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

test('counts are whole, in range, and only for real meals', () => {
  assert.deepEqual(p.cleanCounts({ dinner: 5, lunch: '2', snack: 0, brunch: 3 }), { dinner: 5, lunch: 2 });
  assert.deepEqual(p.cleanCounts({ dinner: 400 }), { dinner: p.MAX_PER_MEAL });
  assert.deepEqual(p.cleanCounts({ dinner: -2, breakfast: 1.6 }), { breakfast: 2 });
  assert.deepEqual(p.cleanCounts(null), {});
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

test('the plan prompt asks for exactly the slots, with the recipes as data', () => {
  const text = p.planPrompt({ dinner: 5, breakfast: 2 }, RECIPES,
    { calorie_target: 2400, protein_target_g: 190 }, ['Greek yogurt (6×)']);
  assert.match(text, /Fill exactly these slots: 2 × breakfast, 5 × dinner\./);
  assert.match(text, /2400 kcal, 190 g protein/);
  assert.match(text, /Greek yogurt \(6×\)/);
  assert.ok(text.includes(JSON.stringify(RECIPES[0])), 'each recipe as one JSON line');
  assert.match(text, /Prefer recipes with "mine": true/);
});

test('with no goal and no history, those lines are left out rather than filled with nothing', () => {
  const text = p.planPrompt({ dinner: 5 }, RECIPES, null, []);
  assert.doesNotMatch(text, /targets|Eaten often/);
});

test('the plan keeps known recipes, requested slots, and no more of each than asked', () => {
  const answer = { meals: [
    { meal: 'dinner', recipe_id: 7, reason: 'High protein.' },
    { meal: 'breakfast', recipe_id: 9, reason: 'Quick.' },
    { meal: 'dinner', recipe_id: 404, reason: 'Invented.' },
    { meal: 'lunch', recipe_id: 7, reason: 'Not asked for.' },
    { meal: 'dinner', recipe_id: 9, reason: 'Second dinner.' },
    { meal: 'dinner', recipe_id: 7, reason: 'One too many.' },
  ] };
  const kept = p.cleanPlan(answer, { dinner: 2, breakfast: 1 }, new Set([7, 9]));
  assert.deepEqual(kept.map((m) => [m.meal, m.recipe_id]), [['breakfast', 9], ['dinner', 7], ['dinner', 9]]);
});

test('an answer with no meals is an empty plan, not a crash', () => {
  assert.deepEqual(p.cleanPlan({}, { dinner: 5 }, new Set([7])), []);
  assert.deepEqual(p.cleanPlan(null, { dinner: 5 }, new Set([7])), []);
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
  assert.equal(p.PLAN_SCHEMA.properties.meals.items.properties.recipe_id.type, 'INTEGER');
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
