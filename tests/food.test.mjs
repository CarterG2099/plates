import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, NOW, daysAgo, atTime } from './helpers/browser.mjs';

installBrowser();
const food = await import('../docs/js/food.js');

const ME = 'me@example.com';
const OTHER = 'aana@example.com';

// ---- dates -----------------------------------------------------------------

test('dayBounds spans local midnight to midnight', () => {
  const { start, end } = food.dayBounds(new Date('2026-08-10T15:30:00'));
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getTime() - start.getTime(), 86_400_000);
});

test('isSameDay is inclusive of midnight and exclusive of the next', () => {
  const day = new Date('2026-08-10T12:00:00');
  const midnight = new Date('2026-08-10T00:00:00').toISOString();
  const nextMidnight = new Date('2026-08-11T00:00:00').toISOString();

  assert.equal(food.isSameDay(midnight, day), true);
  assert.equal(food.isSameDay(nextMidnight, day), false);
});

test('inferMealSlot covers every boundary hour', () => {
  const at = (h) => food.inferMealSlot(new Date(2026, 7, 10, h));
  assert.equal(at(0), 'breakfast');
  assert.equal(at(10), 'breakfast');
  assert.equal(at(11), 'lunch');     // boundary
  assert.equal(at(15), 'lunch');
  assert.equal(at(16), 'dinner');    // boundary
  assert.equal(at(20), 'dinner');
  assert.equal(at(21), 'snack');     // boundary
  assert.equal(at(23), 'snack');
});

test('toDateOnly pads and stays local, never UTC-shifted', () => {
  assert.equal(food.toDateOnly(new Date(2026, 0, 5)), '2026-01-05');
  // Late evening must not roll into tomorrow via UTC.
  assert.equal(food.toDateOnly(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('fromDateOnly round-trips through toDateOnly', () => {
  for (const iso of ['2026-01-01', '2026-06-15', '2026-12-31']) {
    assert.equal(food.toDateOnly(food.fromDateOnly(iso)), iso);
  }
});

test('dayLabel names the neighbouring days', () => {
  const now = new Date(2026, 7, 10);
  assert.equal(food.dayLabel(new Date(2026, 7, 10), now), 'Today');
  assert.equal(food.dayLabel(new Date(2026, 7, 9), now), 'Yesterday');
  assert.equal(food.dayLabel(new Date(2026, 7, 11), now), 'Tomorrow');
  assert.match(food.dayLabel(new Date(2026, 7, 4), now), /Aug/);
});

test('timestampFor uses now for today and the meal hour for other days', () => {
  const now = new Date(2026, 7, 10, 14, 30);
  assert.equal(food.timestampFor(new Date(2026, 7, 10), 'dinner', now).getTime(), now.getTime());

  const planned = food.timestampFor(new Date(2026, 7, 12), 'dinner', now);
  assert.equal(planned.getHours(), 18);
  assert.equal(planned.getDate(), 12);
});

test('timestampFor falls back to midday for an unknown slot', () => {
  const at = food.timestampFor(new Date(2026, 7, 12), 'brunch', new Date(2026, 7, 10));
  assert.equal(at.getHours(), 12);
});

// ---- goals -----------------------------------------------------------------

const goals = [
  { owner_email: ME, starts_on: '2026-01-01', ends_on: '2026-06-30', calorie_target: 2500 },
  { owner_email: ME, starts_on: '2026-07-01', ends_on: null, calorie_target: 2100 },
  { owner_email: OTHER, starts_on: '2026-01-01', ends_on: null, calorie_target: 1800 },
];

test('currentGoal picks the phase containing the date', () => {
  assert.equal(food.currentGoal(goals, ME, new Date(2026, 2, 1))?.calorie_target, 2500);
  assert.equal(food.currentGoal(goals, ME, new Date(2026, 7, 1))?.calorie_target, 2100);
});

test('currentGoal never crosses owners', () => {
  assert.equal(food.currentGoal(goals, OTHER, new Date(2026, 7, 1))?.calorie_target, 1800);
  assert.equal(food.currentGoal(goals, 'nobody@example.com', new Date(2026, 7, 1)), null);
});

test('currentGoal ignores deleted phases and gaps', () => {
  const deleted = [{ owner_email: ME, starts_on: '2026-01-01', ends_on: null, calorie_target: 9, deleted_at: '2026-02-02' }];
  assert.equal(food.currentGoal(deleted, ME, new Date(2026, 7, 1)), null);
  assert.equal(food.currentGoal(goals, ME, new Date(2025, 5, 1)), null);   // before any phase
});

// ---- totals ----------------------------------------------------------------

test('sumTotals adds every macro and tolerates nulls', () => {
  const totals = food.sumTotals([
    { calories: 100, protein_g: 10, carbs_g: 5, fat_g: 2, fiber_g: null, sodium_mg: 50 },
    { calories: 50, protein_g: null, carbs_g: 5, fat_g: 1, fiber_g: 3, sodium_mg: undefined },
  ]);
  assert.equal(totals.calories, 150);
  assert.equal(totals.protein_g, 10);
  assert.equal(totals.fiber_g, 3);
  assert.equal(totals.sodium_mg, 50);
});

test('sumTotals of nothing is all zeros, not NaN', () => {
  const totals = food.sumTotals([]);
  for (const m of food.MACROS) assert.equal(totals[m], 0);
});

// ---- the day ---------------------------------------------------------------

const log = [
  { id: 'a', owner_email: ME, logged_at: '2026-08-10T08:00:00.000Z', meal_slot: 'breakfast', food_id: 'f1', calories: 100 },
  { id: 'b', owner_email: ME, logged_at: '2026-08-10T13:00:00.000Z', meal_slot: 'lunch', food_id: 'f2', calories: 200 },
  { id: 'c', owner_email: ME, logged_at: '2026-08-10T19:00:00.000Z', meal_slot: 'dinner', food_id: 'f1', calories: 300 },
  { id: 'd', owner_email: OTHER, logged_at: '2026-08-10T08:00:00.000Z', meal_slot: 'breakfast', food_id: 'f1', calories: 999 },
  { id: 'e', owner_email: ME, logged_at: '2026-08-10T09:00:00.000Z', meal_slot: 'breakfast', food_id: 'f1', calories: 50, deleted_at: '2026-08-10T10:00:00.000Z' },
];

test('entriesForDay excludes other owners and deleted rows', () => {
  const entries = food.entriesForDay(log, ME, new Date('2026-08-10T12:00:00'));
  assert.deepEqual(entries.map((e) => e.id), ['a', 'b', 'c']);
});

test('entriesForDay returns oldest first', () => {
  const entries = food.entriesForDay(log, ME, new Date('2026-08-10T12:00:00'));
  assert.ok(entries[0].logged_at < entries[entries.length - 1].logged_at);
});

test('groupByMeal keeps meal order and drops empty meals', () => {
  const entries = food.entriesForDay(log, ME, new Date('2026-08-10T12:00:00'));
  const groups = food.groupByMeal(entries);
  assert.deepEqual(groups.map((g) => g.slot), ['breakfast', 'lunch', 'dinner']);
  assert.equal(groups[0].totals.calories, 100);
});

test('groupByMeal treats a missing slot as a snack', () => {
  const groups = food.groupByMeal([{ logged_at: 'x', calories: 10 }]);
  assert.deepEqual(groups.map((g) => g.slot), ['snack']);
});

test('countLoggedToday counts only that food, and nothing without an id', () => {
  const day = new Date('2026-08-10T12:00:00');
  assert.equal(food.countLoggedToday(log, ME, 'f1', day), 2);
  assert.equal(food.countLoggedToday(log, ME, 'f2', day), 1);
  assert.equal(food.countLoggedToday(log, ME, null, day), 0);
});

test('lastEntryForFood returns the most recent, not the first', () => {
  const day = new Date('2026-08-10T12:00:00');
  assert.equal(food.lastEntryForFood(log, ME, 'f1', day).id, 'c');
  assert.equal(food.lastEntryForFood(log, ME, 'nope', day), null);
});

// ---- scaling ---------------------------------------------------------------

test('scaleMacros scales from the stored basis', () => {
  const perHundred = { serving_qty: 100, calories: 59, protein_g: 10.6, carbs_g: 3.5, fat_g: 0, fiber_g: 0, sodium_mg: 38 };
  const scaled = food.scaleMacros(perHundred, 170);
  assert.equal(scaled.calories, 100.3);
  assert.equal(scaled.protein_g, 18);
  assert.equal(scaled.sodium_mg, 64.6);
});

test('scaleMacros is identity for one serving of a per-serving food', () => {
  const perServing = { serving_qty: 1, calories: 120, protein_g: 25, carbs_g: 3, fat_g: 1.5, fiber_g: 0, sodium_mg: 60 };
  assert.deepEqual(food.scaleMacros(perServing, 1), {
    calories: 120, protein_g: 25, carbs_g: 3, fat_g: 1.5, fiber_g: 0, sodium_mg: 60,
  });
});

test('scaleMacros keeps nulls null rather than turning them into zero', () => {
  const scaled = food.scaleMacros({ serving_qty: 1, calories: 100, protein_g: null }, 2);
  assert.equal(scaled.calories, 200);
  assert.equal(scaled.protein_g, null);
});

test('scaleMacros survives a zero or missing basis instead of dividing by zero', () => {
  assert.equal(food.scaleMacros({ serving_qty: 0, calories: 100 }, 5).calories, 500);
  assert.equal(Number.isFinite(food.scaleMacros({ calories: 100 }, 2).calories), true);
});

test('scaleMacros treats a zero quantity as zero, not as the whole serving', () => {
  assert.equal(food.scaleMacros({ serving_qty: 1, calories: 100 }, 0).calories, 0);
});

// ---- ranking ---------------------------------------------------------------

const foods = [
  { id: 'milk2', name: '2% Reduced Fat Milk', brand: 'Great Value', barcode: '222' },
  { id: 'whole', name: 'Milk, Whole', brand: 'Kroger', barcode: null },
  { id: 'pudding', name: 'Chocolate Pudding Cup', brand: 'Jell-O', barcode: null },
  { id: 'oats', name: 'Rolled Oats', brand: 'Quaker', barcode: null },
  { id: 'oatmilk', name: 'Oat Milk', brand: 'Oatly', barcode: null },
  { id: 'chicken', name: 'Chicken Breast, raw', brand: null, barcode: null },
  { id: 'gone', name: 'Deleted Food', brand: null, deleted_at: '2026-01-01' },
];

const history = [
  // Daily this week.
  ...Array.from({ length: 10 }, (_, i) => ({ food_id: 'oats', owner_email: ME, logged_at: daysAgo(i % 7), quantity: 40, unit: 'g' })),
  // Heavily eaten, but months ago.
  ...Array.from({ length: 20 }, (_, i) => ({ food_id: 'whole', owner_email: ME, logged_at: daysAgo(90 + i), quantity: 250, unit: 'ml' })),
  { food_id: 'milk2', owner_email: ME, logged_at: daysAgo(1), quantity: 1.5, unit: 'serving' },
  { food_id: 'oats', owner_email: OTHER, logged_at: daysAgo(0), quantity: 99, unit: 'g' },
];

test('rankFoods drops deleted foods', async () => {
  await atTime(NOW, () => {
    const ranked = food.rankFoods(foods, history, ME);
    assert.equal(ranked.some((f) => f.id === 'gone'), false);
  });
});

test('recent beats more-but-older — frecency, not raw count', async () => {
  await atTime(NOW, () => {
    const ranked = food.rankFoods(foods, history, ME);
    const oats = ranked.find((f) => f.id === 'oats');
    const whole = ranked.find((f) => f.id === 'whole');

    assert.equal(oats.count, 10);
    assert.equal(whole.count, 20);              // twice as many logs
    assert.ok(oats.frecency > whole.frecency);  // and still ranks lower
    assert.ok(ranked.indexOf(oats) < ranked.indexOf(whole));
  });
});

test("rankFoods ignores the other person's log", async () => {
  await atTime(NOW, () => {
    const ranked = food.rankFoods(foods, history, ME);
    assert.equal(ranked.find((f) => f.id === 'oats').count, 10);   // not 11
  });
});

test('rankFoods carries the last amount and unit forward', async () => {
  await atTime(NOW, () => {
    const milk = food.rankFoods(foods, history, ME).find((f) => f.id === 'milk2');
    assert.equal(milk.lastQuantity, 1.5);
    assert.equal(milk.lastUnit, 'serving');
  });
});

test('rankFoods survives an unparseable logged_at', async () => {
  await atTime(NOW, () => {
    const ranked = food.rankFoods(foods, [{ food_id: 'oats', owner_email: ME, logged_at: 'not a date' }], ME);
    const oats = ranked.find((f) => f.id === 'oats');
    assert.equal(oats.count, 0);
    assert.equal(Number.isFinite(oats.frecency), true);
  });
});

// ---- search ----------------------------------------------------------------

const ranked = await atTime(NOW, () => food.rankFoods(foods, history, ME));
const names = (list) => list.map((f) => f.name);

test('an empty search returns everything, ranked', () => {
  assert.equal(food.searchFoods(ranked, '').length, ranked.length);
  assert.equal(food.searchFoods(ranked, '   ').length, ranked.length);
});

test('multi-word search matches regardless of word order', () => {
  assert.deepEqual(names(food.searchFoods(ranked, 'milk 2%')), ['2% Reduced Fat Milk']);
  assert.deepEqual(names(food.searchFoods(ranked, '2% milk')), ['2% Reduced Fat Milk']);
});

test('every word must land somewhere', () => {
  assert.deepEqual(food.searchFoods(ranked, 'milk pudding'), []);
  assert.deepEqual(food.searchFoods(ranked, 'zzz'), []);
});

test('search matches on brand as well as name', () => {
  assert.deepEqual(names(food.searchFoods(ranked, 'quaker')), ['Rolled Oats']);
});

test('a scanned barcode you already own beats everything', () => {
  const hits = food.searchFoods(ranked, '222');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, '2% Reduced Fat Milk');
});

test('search is case-insensitive', () => {
  assert.deepEqual(names(food.searchFoods(ranked, 'ROLLED OATS')), ['Rolled Oats']);
});

test('a weak text match never outranks a staple on history alone', () => {
  // "oat" hits Rolled Oats (eaten daily) and Oat Milk (never eaten).
  const hits = names(food.searchFoods(ranked, 'oat'));
  assert.equal(hits[0], 'Rolled Oats');
  assert.ok(hits.includes('Oat Milk'));
});

// ---- lookup-result scoring -------------------------------------------------

const score = (q, draft) => food.scoreDraft(q.toLowerCase().split(/\s+/), draft);

test('the head noun separates milk from pudding made with milk', () => {
  const milk = score('milk 2%', { name: 'Milk, reduced fat, fluid, 2% milkfat', brand: null });
  const pudding = score('milk 2%', { name: 'Puddings, chocolate, dry mix, prepared with 2% milk', brand: null });
  assert.ok(milk > pudding * 2, `milk ${milk} should dominate pudding ${pudding}`);
});

test('a brand-only search returns that brand instead of scoring zero', () => {
  const s = score('myprotein', { name: 'Impact Whey Protein, Chocolate Brownie', brand: 'Myprotein' });
  assert.ok(s > 0, 'a brand match must not be wiped out by the padding penalty');
});

test('brand words match on word boundaries, not substrings', () => {
  // "myprotein".includes("protein") is true; that must not make "protein" a brand word.
  const s = score('myprotein protein powder', { name: 'Impact Whey Protein', brand: 'Myprotein' });
  const noBrand = score('myprotein protein powder', { name: 'Impact Whey Protein', brand: null });
  assert.ok(s >= noBrand);
});

test('a brand word cannot win the head-noun bonus', () => {
  const real = score('great value peanut butter', { name: 'Peanut Butter, Creamy', brand: 'Great Value' });
  const cookies = score('great value peanut butter', { name: 'Great Value Sandwich Cookies, Peanut Butter', brand: 'Great Value' });
  assert.ok(real > cookies, `peanut butter ${real} should beat cookies ${cookies}`);
});

test('restating the brand in the product name earns no advantage', () => {
  const tea = score('great value', { name: 'Great Value Black Tea', brand: 'Great Value' });
  const milk = score('great value', { name: '2% Reduced Fat Milk', brand: 'Great Value' });
  assert.equal(Math.round(tea), Math.round(milk));
});

test('a branded name is read from its last word, a USDA description from its first', () => {
  const branded = score('milk', { name: 'Great Value Whole Milk', brand: 'Great Value' });
  const sr = score('milk', { name: 'Milk, reduced fat, fluid', brand: null });
  assert.ok(branded > 0 && sr > 0);
  // The SR trap: a description ending in "milk" that is not milk.
  const trap = score('milk', { name: 'Puddings, chocolate, prepared with 2% milk', brand: null });
  assert.ok(sr > trap * 2);
});

test('coverage multiplies: half an answer loses to a full one', () => {
  const half = score('milk 2%', { name: 'Milk Chocolate Candy Bar', brand: 'Hershey' });
  const full = score('milk 2%', { name: 'Milk, reduced fat, fluid, 2% milkfat', brand: null });
  assert.ok(full > half * 2);
});

test('other-market listings are demoted but not dropped', () => {
  const latin = score('myprotein impact whey', { name: 'Impact Whey Protein MyProtein', brand: 'Myprotein' });
  const cyrillic = score('myprotein impact whey', { name: 'Протеин MyProtein Impact Whey Protein', brand: null });
  assert.ok(cyrillic > 0, 'demoted, not filtered out');
  assert.ok(latin > cyrillic, `latin ${latin} should beat cyrillic ${cyrillic}`);
});

test('accented Latin is not treated as another market', () => {
  // Scored on a word both names share, so this isolates the demotion from the
  // accent-folding question below.
  const plain = score('dessert', { name: 'Creme Brulee Dessert', brand: null });
  const accented = score('dessert', { name: 'Crème Brûlée Dessert', brand: null });
  assert.ok(accented >= plain * 0.9, 'accents must not trigger the demotion');
});

test('accents are folded, so a plain query finds an accented name', () => {
  assert.ok(score('creme brulee', { name: 'Crème Brûlée Dessert', brand: null }) > 0);
  assert.ok(score('jalapeno', { name: 'Jalapeño Poppers', brand: null }) > 0);
});

test('a query that matches nothing scores zero', () => {
  assert.equal(score('zzz', { name: 'Milk', brand: null }), 0);
});

// ---- dedupe and merge ------------------------------------------------------

test('matchesDraft pairs on barcode', () => {
  assert.equal(food.matchesDraft({ barcode: '222', name: 'A' }, { barcode: '222', name: 'B' }), true);
});

test('matchesDraft pairs on name and brand when there is no barcode', () => {
  assert.equal(food.matchesDraft({ name: ' Milk ', brand: 'GV' }, { name: 'milk', brand: 'gv' }), true);
  assert.equal(food.matchesDraft({ name: 'Milk', brand: 'GV' }, { name: 'Milk', brand: 'Other' }), false);
});

test('mergeDrafts keeps the earlier source on a collision', () => {
  const usda = [{ draft: { name: 'Milk', brand: 'GV', barcode: '9' }, missing: [], source: 'USDA' }];
  const off = [{ draft: { name: 'Milk different name', brand: null, barcode: '9' }, missing: [], source: 'OFF' }];
  const merged = food.mergeDrafts([usda, off], 'milk');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'USDA');
});

test('mergeDrafts survives either source being empty', () => {
  const one = [{ draft: { name: 'Milk', brand: null, barcode: '1' }, missing: [], source: 'OFF' }];
  assert.equal(food.mergeDrafts([[], one], 'milk').length, 1);
  assert.equal(food.mergeDrafts([one, []], 'milk').length, 1);
  assert.equal(food.mergeDrafts([[], []], 'milk').length, 0);
});

test('mergeDrafts drops results that answer nothing', () => {
  const junk = [{ draft: { name: 'Sardines', brand: null, barcode: '1' }, missing: [], source: 'OFF' }];
  assert.equal(food.mergeDrafts([junk], 'milk').length, 0);
});

// ---- meals -----------------------------------------------------------------

const byId = new Map([
  ['whey', { id: 'whey', name: 'Whey', serving_qty: 1, serving_unit: 'serving', calories: 120, protein_g: 25, carbs_g: 3, fat_g: 1.5, fiber_g: 0, sodium_mg: 60 }],
]);

test('comboTotals sums items that point at real foods, scaled by quantity', () => {
  const combo = { items: [{ food_id: 'whey', quantity: 2, unit: 'serving' }] };
  assert.equal(food.comboTotals(combo, byId).calories, 240);
  assert.equal(food.comboTotals(combo, byId).protein_g, 50);
});

test('comboTotals sums snapshot items that carry their own macros', () => {
  const combo = { items: [
    { food_id: null, name: 'Chicken', quantity: 1, unit: 'serving', calories: 245, protein_g: 46, carbs_g: 0, fat_g: 5 },
    { food_id: null, name: 'Rice', quantity: 1, unit: 'serving', calories: 205, protein_g: 4, carbs_g: 45, fat_g: 0 },
  ] };
  assert.equal(food.comboTotals(combo, byId).calories, 450);
});

test('comboTotals scales a snapshot item too', () => {
  const combo = { items: [{ food_id: null, name: 'Chicken', quantity: 2, unit: 'serving', calories: 245 }] };
  assert.equal(food.comboTotals(combo, byId).calories, 490);
});

test('comboTotals mixes both kinds of item', () => {
  const combo = { items: [
    { food_id: 'whey', quantity: 1, unit: 'serving' },
    { food_id: null, name: 'Banana', quantity: 1, unit: 'serving', calories: 105 },
  ] };
  assert.equal(food.comboTotals(combo, byId).calories, 225);
});

test('an item pointing at a removed food contributes zero, not NaN', () => {
  const combo = { items: [{ food_id: 'deleted', name: 'Ghost', quantity: 1, unit: 'g' }] };
  const totals = food.comboTotals(combo, byId);
  assert.equal(totals.calories, 0);
  for (const m of food.MACROS) assert.equal(Number.isFinite(totals[m]), true);
});

test('comboTotals of an empty or itemless meal is zero', () => {
  assert.equal(food.comboTotals({ items: [] }, byId).calories, 0);
  assert.equal(food.comboTotals({}, byId).calories, 0);
});

test('ownedCombos filters to you, alive, sorted by name', () => {
  const all = [
    { id: '1', name: 'Zebra', owner_email: ME },
    { id: '2', name: 'Apple', owner_email: ME },
    { id: '3', name: 'Hers', owner_email: OTHER },
    { id: '4', name: 'Old', owner_email: ME, deleted_at: '2026-01-01' },
  ];
  assert.deepEqual(food.ownedCombos(all, ME).map((c) => c.name), ['Apple', 'Zebra']);
});

test('searchCombos ranks meals by how well the name matches', () => {
  const mine = [{ id: '1', name: 'Protein Shake' }, { id: '2', name: 'Overnight Oats' }];
  assert.deepEqual(food.searchCombos(mine, 'shake').map((c) => c.name), ['Protein Shake']);
  assert.deepEqual(food.searchCombos(mine, 'oat').map((c) => c.name), ['Overnight Oats']);
  assert.deepEqual(food.searchCombos(mine, 'zzz'), []);
  assert.equal(food.searchCombos(mine, '').length, 2);
});

// ---- ways of saying how much -----------------------------------------------
//
// Four lenses onto one stored number. The property that matters is the round
// trip: whichever one you type in, what lands in the log is a quantity in the
// food's own unit, and reading it back through the same lens gives you what you
// typed. Anything else and switching chips would walk the amount.

const YOGHURT = {                       // logged in servings, one serving = 170 g
  serving_unit: 'serving', serving_qty: 1,
  serving_size: 170, serving_size_unit: 'g',
  calories: 150, protein_g: 15,
};

const RICE = {                          // logged by weight, macros per 100 g
  serving_unit: 'g', serving_qty: 100,
  serving_size: null, serving_size_unit: null,
  calories: 130, protein_g: 2.7,
};

const SODA = {                          // a volume, so millilitres and fl oz
  serving_unit: 'serving', serving_qty: 1,
  serving_size: 355, serving_size_unit: 'ml',
  calories: 140,
};

test('a food logged in servings can be seen four ways', () => {
  assert.deepEqual(food.lensesFor(YOGHURT).map((l) => l.key),
    ['serving', 'measure', 'imperial', 'kcal']);
  assert.deepEqual(food.lensesFor(YOGHURT).map((l) => l.label),
    ['Servings', 'g', 'oz', 'kcal']);
});

test('a volume offers millilitres and fluid ounces, not grams', () => {
  assert.deepEqual(food.lensesFor(SODA).map((l) => l.label), ['Servings', 'ml', 'fl oz', 'kcal']);
});

test('a food logged by weight is already its own measure', () => {
  // No serving size on record, and it does not need one: grams are the unit.
  const keys = food.lensesFor(RICE).map((l) => l.key);
  assert.deepEqual(keys, ['measure', 'imperial', 'kcal']);
  assert.equal(keys.includes('serving'), false, 'nothing says what a serving of it is');
});

test('one serving reads the same amount through every lens', () => {
  assert.equal(food.fromQuantity(YOGHURT, 1, 'serving'), 1);
  assert.equal(food.fromQuantity(YOGHURT, 1, 'measure'), 170);
  assert.equal(food.fromQuantity(YOGHURT, 1, 'imperial'), 6);      // 170 g ≈ 5.996 oz
  assert.equal(food.fromQuantity(YOGHURT, 1, 'kcal'), 150);
});

test('every lens round-trips back to the quantity that gets stored', () => {
  // Quantities in each food's own unit, so these are amounts someone eats:
  // servings for the yoghurt and the can, grams for the rice.
  for (const [item, lenses, amounts] of [
    [YOGHURT, ['serving', 'measure', 'imperial', 'kcal'], [0.5, 1, 2.25, 7]],
    [RICE, ['measure', 'imperial', 'kcal'], [10, 45, 100, 225]],
    [SODA, ['serving', 'measure', 'imperial', 'kcal'], [0.5, 1, 2]],
  ]) {
    for (const lens of lenses) {
      for (const quantity of amounts) {
        const shown = food.fromQuantity(item, quantity, lens);
        const back = food.toQuantity(item, shown, lens);
        // Relative, because the trip goes through a rounded display on purpose.
        assert.ok(Math.abs(back - quantity) / quantity < 0.02,
          `${lens} walked ${quantity} to ${back} via ${shown}`);
      }
    }
  }
});

test('tapping through every chip and back comes home to the same amount', () => {
  // What setSheetLens does on each tap: read the quantity through the lens you
  // are leaving, write it through the one you are arriving at. Four hops must
  // not walk the amount, or the number drifts every time you change your mind.
  const hop = (item, quantity, lens) => food.toQuantity(item, food.fromQuantity(item, quantity, lens), lens);

  for (const [item, order, start] of [
    [YOGHURT, ['serving', 'measure', 'imperial', 'kcal', 'serving'], 2],
    [SODA, ['serving', 'imperial', 'measure', 'kcal', 'serving'], 1],
    [RICE, ['measure', 'imperial', 'kcal', 'measure'], 150],
  ]) {
    let quantity = start;
    for (const lens of order) quantity = hop(item, quantity, lens);
    assert.ok(Math.abs(quantity - start) / start < 0.02,
      `${order.join(' -> ')} walked ${start} to ${quantity}`);
  }
});

test('a coarse lens cannot describe a fine amount, and does not pretend to', () => {
  // Half a gram of rice is 0.65 kcal. Shown as a whole number of calories — which
  // is the right display for every amount anyone eats — it reads 1, and 1 kcal of
  // rice is 0.77 g. The loss is in the lens, not the arithmetic: switch to a unit
  // coarser than the amount and the amount is gone.
  assert.equal(food.fromQuantity(RICE, 0.5, 'kcal'), 1);
  assert.equal(food.toQuantity(RICE, 1, 'kcal'), 0.77);

  // Which is why the ones people use keep their precision.
  assert.equal(food.toQuantity(RICE, food.fromQuantity(RICE, 100, 'kcal'), 'kcal'), 100);
});

test('grams convert to ounces at the real ratio, not a rounded one', () => {
  assert.equal(food.toQuantity(RICE, 1, 'imperial'), 28.35, 'one ounce of rice, in grams');
  assert.equal(food.fromQuantity(RICE, 100, 'imperial'), 3.53);
  assert.equal(food.toQuantity(SODA, 12, 'imperial'), 1,
    'a twelve fl oz can is one 355 ml serving');
});

test('calories are a lens like any other, and scale the macros with them', () => {
  // 300 kcal of yoghurt is two servings, which is 340 g and 30 g of protein.
  const q = food.toQuantity(YOGHURT, 300, 'kcal');
  assert.equal(q, 2);
  assert.equal(food.fromQuantity(YOGHURT, q, 'measure'), 340);
  assert.equal(food.scaleMacros(YOGHURT, q).protein_g, 30);
});

test('a food with no calories on it cannot be logged by calories', () => {
  const unknown = { ...RICE, calories: null };
  assert.equal(food.lensesFor(unknown).some((l) => l.key === 'kcal'), false);
  assert.equal(food.toQuantity(unknown, 300, 'kcal'), 0, 'and never divides by nothing');
});

test('the slider means the same thing on every food', () => {
  assert.deepEqual(food.LENS_MAX, { serving: 10, measure: 500, imperial: 20, kcal: 1500 });
  assert.deepEqual(food.LENS_STEP, { serving: 0.25, measure: 5, imperial: 0.25, kcal: 10 });
});
