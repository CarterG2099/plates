/**
 * The week's meals → shopping list → Walmart cart.
 *
 * The cart link's format was confirmed by hand on 2026-11-05 (Safari and the
 * iOS app): `items=<id>|<qty>,<id>`, a quantity of one as the bare id, and an
 * unknown id dropped while the rest still land. These tests hold the code to
 * that format, and to only ever putting numeric ids in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const g = await import('../docs/js/grocery.js');
const local = await import('../docs/js/local.js');
const { supabase } = await import('../docs/js/supabase.js');

// ---- links --------------------------------------------------------------------

test('the item number comes from a pasted product link, query string and all', () => {
  assert.equal(g.walmartItemId(
    'https://www.walmart.com/ip/Great-Value-Milk-1-Lowfat-Half-Gallon-Plastic-Jug/10804537?classType=REGULAR&athbdg=L1100&from=/search'),
  '10804537');
  assert.equal(g.walmartItemId('https://www.walmart.com/ip/24OZ-GRTVALU-2-LF-COTCHS-X12/12444458'), '12444458');
  assert.equal(g.walmartItemId('walmart.com/ip/27935840'), '27935840');
  assert.equal(g.walmartItemId('  26559565 '), '26559565');
});

test('anything that is not a product link gives no item number', () => {
  assert.equal(g.walmartItemId('https://www.walmart.com/search?q=milk'), null);
  assert.equal(g.walmartItemId('https://www.target.com/ip/milk/10804537'), null);
  assert.equal(g.walmartItemId('https://www.walmart.com/ip/Milk-2-Percent'), null);
  assert.equal(g.walmartItemId(''), null);
  assert.equal(g.walmartItemId(null), null);
});

const USUALS = [
  { id: 'u1', ingredient_key: 'milk', walmart_item_id: '10804537', default_qty: 1, updated_at: '1' },
  { id: 'u2', ingredient_key: 'chicken breast', walmart_item_id: '27935840', default_qty: 2, updated_at: '1' },
  { id: 'u3', ingredient_key: 'greek yogurt', walmart_item_id: '26559565', default_qty: 3, updated_at: '1' },
];
const item = (key, label, extra = {}) => ({ id: key, ingredient_key: key, label, have: false, ...extra });

test('the cart link is the confirmed format: bare id for one, id|qty for more, commas between', () => {
  const { url, count, skipped } = g.cartLink(
    [item('milk', 'milk'), item('chicken breast', 'chicken breast'), item('greek yogurt', 'greek yogurt')], USUALS);
  assert.equal(url, 'https://www.walmart.com/sc/cart/addToCart?items=10804537,27935840|2,26559565|3');
  assert.equal(count, 3);
  assert.deepEqual(skipped, []);
});

test('unmapped items stay out of the link and are named; ticked ones are left out quietly', () => {
  const { url, skipped } = g.cartLink([
    item('milk', 'milk'),
    item('kale', 'curly kale'),
    item('greek yogurt', 'greek yogurt', { have: true }),
  ], USUALS);
  assert.equal(url, 'https://www.walmart.com/sc/cart/addToCart?items=10804537');
  assert.deepEqual(skipped, ['curly kale']);
});

test('a mapping without a numeric id never reaches the link', () => {
  const { url, skipped } = g.cartLink([item('milk', 'milk')],
    [{ ...USUALS[0], walmart_item_id: '10804537abc' }]);
  assert.equal(url, null);
  assert.deepEqual(skipped, ['milk']);
});

test('two ingredients on one product are one entry with their quantities added', () => {
  const usuals = [USUALS[1], { id: 'u4', ingredient_key: 'chicken', walmart_item_id: '27935840', default_qty: 1, updated_at: '1' }];
  const { url } = g.cartLink([item('chicken breast', 'chicken breast'), item('chicken', 'chicken')], usuals);
  assert.equal(url, 'https://www.walmart.com/sc/cart/addToCart?items=27935840|3');
});

test('the newest mapping wins when both of you made one, and a forgotten one does not count', () => {
  const usuals = [
    { id: 'a', ingredient_key: 'milk', walmart_item_id: '111111', updated_at: '2026-11-01' },
    { id: 'b', ingredient_key: 'milk', walmart_item_id: '222222', updated_at: '2026-11-03' },
    { id: 'c', ingredient_key: 'milk', walmart_item_id: '333333', updated_at: '2026-11-04', deleted_at: 'x' },
  ];
  assert.equal(g.usualFor('milk', usuals).id, 'b');
});

// ---- amounts ------------------------------------------------------------------

const RECIPES = new Map([
  [1, { id: 1, title: 'Peanut Chicken', servings_count: 4 }],
  [2, { id: 2, title: 'Chicken Tacos', servings: '15-20' }],
  [3, { id: 3, title: 'Mystery Stew' }],
]);

test('what a recipe makes: servings_count first, else the first number in the servings text', () => {
  assert.equal(g.recipeYield(RECIPES.get(1)), 4);
  assert.equal(g.recipeYield(RECIPES.get(2)), 15);
  assert.equal(g.recipeYield(RECIPES.get(3)), null);
  assert.equal(g.scaleFor(2, RECIPES.get(1)), 0.5);
  assert.equal(g.scaleFor(2, RECIPES.get(3)), 1, 'no yield: cook it whole');
});

test('ingredients are scaled per meal and added up within one kind of measure', () => {
  const ingredients = {
    1: [
      { key: 'chicken breast', name: 'chicken breast', qty: 1, unit: 'lb', staple: false },
      { key: 'kale', name: 'curly kale', qty: 6, unit: 'cup', staple: false },
      { key: 'salt', name: 'salt', qty: 0.5, unit: 'tsp', staple: true },
    ],
    3: [
      { key: 'chicken breast', name: 'chicken breast', qty: 8, unit: 'oz', staple: false },
      { key: 'kale', name: 'kale', qty: 2, unit: 'tbsp', staple: false },
      { key: 'chicken breast', name: 'chicken breast', qty: 2, unit: null, staple: false },
    ],
  };
  // Peanut Chicken twice at 2 servings each (half the recipe each time), Mystery Stew once, whole.
  const meals = [{ recipe_id: 1, servings: 2 }, { recipe_id: 1, servings: 2 }, { recipe_id: 3, servings: 2 }];
  const lines = g.combine(meals, ingredients, RECIPES);
  const find = (key, unit) => lines.find((l) => l.key === key && l.unit === unit);

  // 1 lb × ½ × 2 = 1 lb, + 8 oz = 1.5 lb, shown in the unit it first came in.
  assert.equal(find('chicken breast', 'lb').qty, 1.5);
  // A count of breasts is not a weight: its own line.
  assert.equal(find('chicken breast', null).qty, 2);
  // 6 cup × ½ × 2 = 6 cup, + 2 tbsp = 6.125 cup, rounded up to the quarter.
  assert.equal(find('kale', 'cup').qty, 6.25);
  assert.deepEqual(find('kale', 'cup').recipes, ['Peanut Chicken', 'Mystery Stew']);
  assert.equal(find('salt', 'tsp').staple, true);
});

test('an amount nobody wrote down stays unknown, not zero', () => {
  const lines = g.combine([{ recipe_id: 3, servings: 1 }],
    { 3: [{ key: 'pepper', name: 'pepper', qty: null, unit: null, staple: true }] }, RECIPES);
  assert.equal(lines[0].qty, null);
  assert.equal(g.amountLabel(lines[0].qty, lines[0].unit), '');
});

test('amounts read the way a recipe writes them, and round up', () => {
  assert.equal(g.amountLabel(1.5, 'cup'), '1½ cup');
  assert.equal(g.amountLabel(0.25, 'tsp'), '¼ tsp');
  assert.equal(g.amountLabel(3, 'each'), '3');
  assert.equal(g.amountLabel(2, null), '2');
  assert.equal(g.amountLabel(200, 'g'), '200 g');
  assert.equal(g.roundUp(0.3), 0.5);
  assert.equal(g.roundUp(0.25), 0.25);
  assert.equal(g.roundUp(10.2), 11);
});

test('the week starts on Monday', () => {
  assert.equal(g.weekOf(new Date(2026, 10, 5)), '2026-11-02');    // a Thursday
  assert.equal(g.weekOf(new Date(2026, 10, 2)), '2026-11-02');    // the Monday itself
  assert.equal(g.weekOf(new Date(2026, 10, 8)), '2026-11-02');    // the Sunday after
});

test('the plan on screen is the latest accepted, ignoring discarded ones', () => {
  const plans = [
    { id: 'a', accepted_at: '2026-11-01T00:00:00Z' },
    { id: 'b', accepted_at: '2026-11-04T00:00:00Z' },
    { id: 'c', accepted_at: '2026-11-05T00:00:00Z', deleted_at: 'x' },
  ];
  assert.equal(g.currentPlan(plans).id, 'b');
  assert.equal(g.currentPlan([]), null);
});

// ---- saving -------------------------------------------------------------------

const ME = 'cgividen20@gmail.com';
const AANA = 'aanabraithwaite@gmail.com';

test('accepting saves the plan and its list locally, staples already ticked', async () => {
  const plan = await g.acceptPlan({
    meals: [{ meal: 'dinner', recipe_id: 1, title: 'Peanut Chicken', servings: 2, reason: 'x', extra: 'dropped' }],
    lines: [
      { key: 'kale', label: 'curly kale', qty: 3, unit: 'cup', staple: false, recipes: ['Peanut Chicken'] },
      { key: 'salt', label: 'salt', qty: 0.25, unit: 'tsp', staple: true, recipes: ['Peanut Chicken'] },
    ],
    email: ME,
    now: new Date(2026, 10, 5, 12),
  });
  assert.equal(plan.week_of, '2026-11-02');
  assert.deepEqual(Object.keys(plan.meals[0]).sort(), ['meal', 'reason', 'recipe_id', 'servings', 'title']);

  const items = (await local.all('shopping_items')).filter((i) => i.plan_id === plan.id);
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.ingredient_key === 'salt').have, true);
  assert.equal(items.find((i) => i.ingredient_key === 'kale').have, false);
  const queued = (await local.outbox()).map((e) => e.table);
  assert.ok(queued.includes('meal_plans') && queued.includes('shopping_items'), 'queued for sync');
});

test('ticking an item off keeps its owner when the other of you does it', async () => {
  const row = await local.save('shopping_items', { plan_id: 'p', ingredient_key: 'milk', label: 'milk', have: false }, ME);
  const ticked = await g.setHave(row, true);
  assert.equal(ticked.owner_email, ME);
  assert.equal(ticked.have, true);
});

test('a usual is saved from a pasted link, and a bad link or quantity says why', async () => {
  const saved = await g.saveUsual({ key: 'milk', link: 'https://www.walmart.com/ip/Milk/10804537?x=1', label: 'GV milk', qty: 2 }, ME);
  assert.equal(saved.walmart_item_id, '10804537');
  assert.equal(saved.default_qty, 2);

  await assert.rejects(g.saveUsual({ key: 'milk', link: 'https://www.walmart.com/search?q=milk', qty: 1 }, ME),
    /isn't a Walmart product link/);
  await assert.rejects(g.saveUsual({ key: 'milk', link: '10804537', qty: 0 }, ME), /1 to 99/);
});

test('replacing a usual keeps its id and owner — switching brands is an edit, not a second mapping', async () => {
  const first = await g.saveUsual({ key: 'yogurt', link: '26559565', qty: 1 }, AANA);
  const changed = await g.saveUsual({ id: first.id, key: 'yogurt', link: 'walmart.com/ip/Other-Yogurt/99999999', qty: 1 }, ME, first);
  assert.equal(changed.id, first.id);
  assert.equal(changed.owner_email, AANA);
  assert.equal(changed.walmart_item_id, '99999999');

  await g.removeUsual(first.id);
  assert.equal((await local.all('walmart_items')).some((u) => u.id === first.id), false, 'soft deleted');
});

// ---- the Plan tab ---------------------------------------------------------------

/** Answer plan-week the way the function does, and record what was asked. */
function withPlanWeek(answers, fn) {
  return async () => {
    const real = supabase.functions.invoke;
    const calls = [];
    supabase.functions.invoke = async (name, { body }) => {
      calls.push({ name, body });
      return { data: answers[body.mode], error: null };
    };
    try { await fn(calls); } finally { supabase.functions.invoke = real; }
  };
}

function planPage() {
  Alpine.store('auth').session = { user: { email: ME } };
  Alpine.store('auth').members = [
    { email: ME, sharing: true },
    { email: AANA, sharing: true },
  ];
  const page = Alpine.reactive(components.planPage());
  page.recipeList = [...RECIPES.values()];
  return page;
}

test('the tab starts at five dinners, a serving each for the two of you', () => {
  const page = planPage();
  page.loadRecipes = async () => {};
  page.init();
  assert.deepEqual({ ...page.counts }, { breakfast: 0, lunch: 0, dinner: 5, snack: 0 });
  assert.equal(page.servings, 2);

  Alpine.store('auth').members = [{ email: ME, sharing: true }];
  page.init();
  assert.equal(page.servings, 1, 'on your own, one');
});

test('a draft is asked for with the counts, edited, and only saved on accept', withPlanWeek({
  plan: { meals: [
    { meal: 'dinner', recipe_id: 1, reason: 'High protein.' },
    { meal: 'dinner', recipe_id: 2, reason: 'Quick.' },
  ] },
  ingredients: { recipes: {
    1: [{ key: 'chicken breast', name: 'chicken breast', qty: 1, unit: 'lb', staple: false }],
    3: [{ key: 'carrot', name: 'carrot', qty: 3, unit: null, staple: false }],
  } },
}, async (calls) => {
  const page = planPage();
  page.servings = 2;
  const plansBefore = (await local.all('meal_plans')).length;

  await page.makeDraft();
  assert.deepEqual(calls[0], { name: 'plan-week', body: { mode: 'plan', counts: page.counts } });
  assert.equal(page.draft.length, 2);
  assert.equal(page.draft[0].servings, 2);
  assert.equal((await local.all('meal_plans')).length, plansBefore, 'a draft saves nothing');

  page.swap(1, '3');
  page.stepServings(0, 2);          // 4 servings of a 4-serving recipe: the whole thing
  assert.equal(page.draft[1].recipe_id, 3);

  await page.accept();
  assert.deepEqual(calls[1].body, { mode: 'ingredients', recipe_ids: [1, 3] });
  assert.equal(page.draft, null);

  const plan = page.plan;
  assert.deepEqual(plan.meals.map((m) => m.title), ['Peanut Chicken', 'Mystery Stew']);
  assert.deepEqual(page.items.map((i) => [i.label, i.qty, i.unit]),
    [['carrot', 3, null], ['chicken breast', 1, 'lb']]);
}));

test('a failed plan says why and leaves no draft', withPlanWeek({ plan: { error: 'The reader is slow right now — try again in a moment.' } },
  async () => {
    const page = planPage();
    await page.makeDraft();
    assert.equal(page.draft, null);
    assert.match(page.error, /slow right now/);
    assert.equal(page.busy, '');
  }));

test('the list splits into mapped, needing a product, and already had; the cart follows', async () => {
  const page = planPage();
  const plan = await g.acceptPlan({
    meals: [{ meal: 'dinner', recipe_id: 1, title: 'Peanut Chicken', servings: 2 }],
    lines: [
      { key: 'milk', label: 'milk', qty: 1, unit: 'cup', staple: false, recipes: [] },
      { key: 'zz-unmapped', label: 'curly kale', qty: 6, unit: 'cup', staple: false, recipes: [] },
      { key: 'salt', label: 'salt', qty: null, unit: null, staple: true, recipes: [] },
    ],
    email: ME,
    now: new Date(Date.now() + 60_000),   // newest, so it is the plan on screen
  });
  await g.saveUsual({ key: 'milk', link: '10804537', label: 'GV milk', qty: 1 }, ME);
  await Alpine.store('data').refreshCore();

  assert.equal(page.plan.id, plan.id);
  assert.deepEqual(page.toBuy.map((i) => i.label), ['milk']);
  assert.deepEqual(page.unmapped.map((i) => i.label), ['curly kale']);
  assert.deepEqual(page.had.map((i) => i.label), ['salt']);
  assert.match(page.cart.url, /items=\d+/);
  assert.deepEqual(page.cart.skipped, ['curly kale']);
});

test('the mapping sheet opens on what is there and saves a pasted link', async () => {
  const page = planPage();
  page.openUsual({ ingredient_key: 'oats', label: 'rolled oats' });
  assert.deepEqual({ ...page.usual, existing: null }, { key: 'oats', label: 'rolled oats', link: '', qty: 1, existing: null });

  page.usual.link = 'not a link';
  await page.saveUsual();
  assert.match(page.usualError, /isn't a Walmart product link/);
  assert.ok(page.usual, 'stays open to fix');

  page.usual.link = 'https://www.walmart.com/ip/Oats/10315394';
  await page.saveUsual();
  assert.equal(page.usual, null);
  assert.equal(g.usualFor('oats', page.usuals).walmart_item_id, '10315394');
});

// ---- markup and wiring ---------------------------------------------------------

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const html = await read('../docs/index.html');

test('Plan is a tab, mounted only while open, and swipeable', async () => {
  assert.match(html, /<button[^>]*\$store\.ui\.go\('plan'\)">Plan<\/button>/);
  assert.match(html, /<template x-if="\$store\.ui\.view === 'plan'">\s*<main class="app-main" x-data="planPage">/);
  assert.match(await read('../docs/js/app.js'), /const TABS = \['today', 'plan', 'train', 'stats'\]/);
});

test('the cart button is a plain link to the built URL, opened outside the app', () => {
  assert.match(html, /<a class="btn btn-primary btn-block" x-show="cart\.url" :href="cart\.url"\s+target="_blank"/);
  assert.match(html, /x-text="`Not in the cart: \$\{cart\.skipped\.join\(', '\)\}`"/);
});

test('the three tables are stored locally, synced, and the module is precached', async () => {
  const sync = await read('../docs/js/sync.js');
  for (const t of ['meal_plans', 'shopping_items', 'walmart_items']) {
    assert.ok(local.TABLES.includes(t), t);
    assert.match(sync, new RegExp(`'${t}',`));
  }
  assert.match(await read('../docs/sw.js'), /'\/js\/grocery\.js',/);
});

test('the tables are shared with the household through can_read, never world-readable', async () => {
  const sql = await read('../supabase/schema.sql');
  const block = sql.slice(sql.indexOf('-- ---- meal plan, shopping list, Walmart usuals'));
  assert.match(block, /array\['meal_plans', 'shopping_items', 'walmart_items'\]/);
  assert.match(block, /for select using \(plates\.can_read\(owner_email\)\)/);
  // Insert matches update: sync's upserts are held to the insert policy even
  // when they land as an update, and owner-only stopped Aana ticking Carter's list.
  assert.match(block, /for insert with check \(plates\.can_read\(owner_email\)\)/);
  assert.match(block, /for update using \(plates\.can_read\(owner_email\)\) with check \(plates\.can_read\(owner_email\)\)/);
  assert.match(block, /revoke all on plates\.%I from anon, authenticated/);
  assert.doesNotMatch(block, /using \(true\)|allowed_emails|for delete/);
  assert.match(block, /walmart_item_id text not null check \(walmart_item_id ~ '\^\[0-9\]\+\$'\)/);
});
