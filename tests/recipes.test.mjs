import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const recipes = await import('../docs/js/recipes.js');
const food = await import('../docs/js/food.js');

const BREAD = {
  id: 42, title: "Grandma's Banana Bread", servings: '10', servings_count: 10,
  calories: 210, protein_g: 3.5, carbs_g: 34, fat_g: 7, fiber_g: 1.2, sodium_mg: 180,
  nutrition_source: 'gemini', created_by: 'mgividen@gmail.com',
};

// ---- the draft ----------------------------------------------------------------

test('recipeToDraft is one serving of the recipe, with recipe_id as provenance', () => {
  const d = recipes.recipeToDraft(BREAD);
  assert.equal(d.name, "Grandma's Banana Bread");
  assert.equal(d.brand, 'Recipe');
  assert.equal(d.serving_qty, 1);
  assert.equal(d.serving_unit, 'serving');
  assert.equal(d.basis, '1 of 10 servings');
  assert.equal(d.source, 'recipe');
  assert.equal(d.recipe_id, 42);
  assert.equal(d.calories, 210);
  assert.equal(d.sodium_mg, 180);
});

// The bug this guards against has shipped once already, from the other side:
// Number(null) is 0, and a food whose protein was unknown logged as zero protein.
test('recipeToDraft keeps an unknown macro null rather than zero', () => {
  const d = recipes.recipeToDraft({ ...BREAD, fiber_g: null, sodium_mg: '' });
  assert.equal(d.fiber_g, null);
  assert.equal(d.sodium_mg, null);
  assert.equal(d.calories, 210, 'the known ones are untouched');
});

test('a recipe draft scales like any other food, and nulls survive the scaling', () => {
  const d = recipes.recipeToDraft({ ...BREAD, fiber_g: null });
  const two = food.scaleMacros(d, 2);
  assert.equal(two.calories, 420);
  assert.equal(two.protein_g, 7);
  assert.equal(two.fiber_g, null, 'scaleMacros must not turn the null into 0');
});

test('recipeToDraft copes with a recipe that has no servings count', () => {
  const d = recipes.recipeToDraft({ ...BREAD, servings_count: null });
  assert.equal(d.basis, '1 serving');
  assert.equal(d.serving_qty, 1);
});

test('recipeToDraft never produces a nameless food', () => {
  assert.equal(recipes.recipeToDraft({ ...BREAD, title: '   ' }).name, 'Recipe');
  assert.equal(recipes.recipeToDraft({ ...BREAD, title: null }).name, 'Recipe');
});

// ---- what can be logged -------------------------------------------------------------

test('hasNutrition needs a calorie figure', () => {
  assert.equal(recipes.hasNutrition(BREAD), true);
  assert.equal(recipes.hasNutrition({ ...BREAD, calories: null }), false);
  assert.equal(recipes.hasNutrition({ ...BREAD, calories: '' }), false);
  assert.equal(recipes.hasNutrition({ ...BREAD, calories: 0 }), true, 'zero calories is a number');
  assert.equal(recipes.hasNutrition(null), false);
});

test('missingMacros names the required ones that are absent', () => {
  assert.deepEqual(recipes.missingMacros(BREAD), []);
  assert.deepEqual(recipes.missingMacros({ ...BREAD, protein_g: null, fat_g: '' }), ['protein_g', 'fat_g']);
  assert.deepEqual(recipes.missingMacros({ ...BREAD, fiber_g: null }), [], 'fibre is not required');
});

test('toResults drops recipes with no nutrition and shapes the rest like online hits', () => {
  const rows = recipes.toResults([BREAD, { ...BREAD, id: 43, title: 'Untracked', calories: null }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'Recipe');
  assert.equal(rows[0].draft.recipe_id, 42);
  assert.deepEqual(rows[0].missing, []);
});

// ---- search -------------------------------------------------------------------------

test('searchRecipes matches every word, ignoring case and accents', () => {
  const list = [BREAD, { ...BREAD, id: 2, title: 'Crème Brûlée' }, { ...BREAD, id: 3, title: 'Banana Pancakes' }];
  assert.deepEqual(recipes.searchRecipes(list, 'banana').map((r) => r.id), [42, 3]);
  assert.deepEqual(recipes.searchRecipes(list, 'banana bread').map((r) => r.id), [42]);
  assert.deepEqual(recipes.searchRecipes(list, 'creme brulee').map((r) => r.id), [2]);
  assert.deepEqual(recipes.searchRecipes(list, 'BANANA').map((r) => r.id), [42, 3]);
});

test('searchRecipes with no term returns everything', () => {
  assert.equal(recipes.searchRecipes([BREAD], '').length, 1);
  assert.equal(recipes.searchRecipes([BREAD], '   ').length, 1);
});

// ---- links --------------------------------------------------------------------------

test('recipeUrl points at the other app, view or edit', () => {
  assert.equal(recipes.recipeUrl(BREAD), 'https://recipes.cartergividen.com/recipe.html?id=42');
  assert.equal(recipes.recipeUrl(BREAD, { edit: true }), 'https://recipes.cartergividen.com/edit.html?id=42');
});

// ---- through the logger -------------------------------------------------------------

test('logging a recipe draft stamps recipe_id onto the entry', async () => {
  const draft = recipes.recipeToDraft(BREAD);
  const entry = await food.logFood({ food: draft, quantity: 2, unit: 'serving', ownerEmail: 'me@example.com' });
  assert.equal(entry.recipe_id, 42);
  assert.equal(entry.calories, 420);
  assert.equal(entry.unit, 'serving');
  assert.equal(entry.description, "Grandma's Banana Bread · Recipe");
});
