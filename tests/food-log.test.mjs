/**
 * food.js — the write path and the amount label.
 *
 * Separate from food.test.mjs, which covers the pure helpers. These go through
 * the real local.js into the in-memory IndexedDB, so the snapshot rule is tested
 * end to end rather than as arithmetic.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();

const local = await import('../docs/js/local.js');
const food = await import('../docs/js/food.js');

const ME = 'me@example.com';
beforeEach(() => local.wipe());

const OATS = {
  id: 'f-oats', name: 'Oats', brand: 'Quaker',
  serving_qty: 1, serving_unit: 'serving',
  calories: 150, protein_g: 5, carbs_g: 27, fat_g: 3, fiber_g: 4, sodium_mg: 0,
};

// ---- amountLabel -------------------------------------------------------------
// First the reported bug was "1serving", and `serving` was made the exception.
// Then it was "1cup", because the exception was one unit rather than one kind of
// unit. A symbol prints hard against the number; a word takes a space and a
// plural, whichever word it happens to be.

test('one serving keeps its space', () => {
  assert.equal(food.amountLabel(1, 'serving'), '1 serving');
});

test('anything but one is plural', () => {
  assert.equal(food.amountLabel(2, 'serving'), '2 servings');
  assert.equal(food.amountLabel(0.5, 'serving'), '0.5 servings');
  assert.equal(food.amountLabel(1.5, 'serving'), '1.5 servings');
  assert.equal(food.amountLabel(0, 'serving'), '0 servings');
});

test('every word unit is spaced and pluralised, not just serving', () => {
  assert.equal(food.amountLabel(1, 'cup'), '1 cup');
  assert.equal(food.amountLabel(2, 'cup'), '2 cups');
  assert.equal(food.amountLabel(1, 'slice'), '1 slice');
  assert.equal(food.amountLabel(3, 'slice'), '3 slices');
  assert.equal(food.amountLabel(2, 'piece'), '2 pieces');
  assert.equal(food.amountLabel(0, 'cup'), '0 cups');
});

test('a unit that is already plural does not get a second s', () => {
  assert.equal(food.amountLabel(2, 'slices'), '2 slices');
  assert.equal(food.amountLabel(1, 'slices'), '1 slices', 'left as entered');
});

test('symbol units stay tight against the number and never pluralise', () => {
  assert.equal(food.amountLabel(170, 'g'), '170g');
  assert.equal(food.amountLabel(1, 'g'), '1g');
  assert.equal(food.amountLabel(2, 'ml'), '2ml');
  assert.equal(food.amountLabel(200, 'lb'), '200lb');
  assert.equal(food.amountLabel(4, 'oz'), '4oz');
});

test('an abbreviation takes the space but never the plural', () => {
  // "1fl oz" is not a word and does not read as one.
  assert.equal(food.amountLabel(1, 'fl oz'), '1 fl oz');
  assert.equal(food.amountLabel(12, 'fl oz'), '12 fl oz');
  assert.equal(food.amountLabel(2, 'tbsp'), '2 tbsp');
  assert.equal(food.amountLabel(3, 'tsp'), '3 tsp');
});

test('a missing quantity reads as zero rather than NaN', () => {
  assert.equal(food.amountLabel(undefined, 'serving'), '0 servings');
  assert.equal(food.amountLabel(null, 'g'), '0g');
  assert.equal(food.amountLabel('', 'serving'), '0 servings');
});

test('a missing unit says the number and nothing else', () => {
  assert.equal(food.amountLabel(2, ''), '2');
  assert.equal(food.amountLabel(2, null), '2');
  assert.equal(food.amountLabel(2, undefined), '2');
});

// ---- scaleEntry ---------------------------------------------------------------

const ENTRY = {
  id: 'e1', owner_email: ME, quantity: 1, unit: 'serving',
  calories: 150, protein_g: 12, carbs_g: 24, fat_g: 2.5, fiber_g: 3, sodium_mg: 190,
};

test('an edited amount rescales the entry proportionally', () => {
  const doubled = food.scaleEntry(ENTRY, 2);
  for (const [key, value] of Object.entries(
    { calories: 300, protein_g: 24, carbs_g: 48, fat_g: 5, fiber_g: 6, sodium_mg: 380 })) {
    assert.equal(doubled[key], value, key);
  }
  // The entry never carried these, so doubling it does not invent them.
  assert.equal(doubled.sugars_g, null);

  assert.equal(food.scaleEntry(ENTRY, 0.5).calories, 75);
  assert.equal(food.scaleEntry(ENTRY, 1).calories, 150, 'no change is a no-op');
});

test('the entry\'s own snapshot is the basis, never the food behind it', () => {
  // This is what makes keeping food_id safe. If scaleEntry ever consults the
  // food while the snapshot is usable, editing a food rewrites what you ate.
  const rewritten = { serving_qty: 1, calories: 9999, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 };
  assert.equal(food.scaleEntry(ENTRY, 2, rewritten).calories, 300);
});

test('a macro nobody recorded stays null rather than becoming a hard zero', () => {
  // Number(null) is 0 and passes Number.isFinite, which is exactly how this
  // went wrong: "not recorded" silently became "none".
  assert.equal(food.scaleEntry({ ...ENTRY, fiber_g: null }, 2).fiber_g, null);
  assert.equal(food.scaleEntry({ ...ENTRY, sodium_mg: undefined }, 2).sodium_mg, null);
  assert.equal(food.scaleEntry({ ...ENTRY, fiber_g: null }, 2).calories, 300, 'the rest still scale');
});

test('a zero-quantity entry leaves no ratio, so the food is the only basis left', () => {
  const zeroed = { ...ENTRY, quantity: 0 };
  const backing = { serving_qty: 1, calories: 100, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 };

  assert.equal(food.scaleEntry(zeroed, 2, backing).calories, 200);
  assert.deepEqual(food.scaleEntry(zeroed, 2), food.emptyTotals(), 'and zeros when the food is gone too');
});

// ---- logging, editing, deleting -------------------------------------------------

test('logging snapshots the scaled macros and a readable description', async () => {
  const entry = await food.logFood({ food: OATS, quantity: 2, ownerEmail: ME, date: new Date() });

  assert.equal(entry.description, 'Oats · Quaker');
  assert.equal(entry.food_id, 'f-oats', 'provenance only');
  assert.equal(entry.calories, 300, 'frozen at log time');
  assert.equal(entry.unit, 'serving');
});

test('logging to another day lands on that day, and invents no meal', async () => {
  // The bug this replaces: the slot came from inferMealSlot() with no argument,
  // so it read the wall clock rather than the day being logged to. Adding
  // yesterday's dinner over breakfast filed it under breakfast.
  const yesterday = new Date(Date.now() - 86_400_000);
  const entry = await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: yesterday });

  assert.equal(new Date(entry.logged_at).toDateString(), yesterday.toDateString(),
    'stamped on the day you chose');
  assert.equal(entry.meal_slot, null, 'and no meal guessed from a clock that was not there');
});

test('two entries added to a past day keep the order they were added in', async () => {
  const day = new Date(Date.now() - 3 * 86_400_000);
  const first = await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: day });
  const second = await food.logFood({ food: OATS, quantity: 2, ownerEmail: ME, date: day });

  // Both used to be stamped at the meal's nominal hour, which made them
  // simultaneous and left the day in whatever order it came out of the store.
  assert.ok(first.logged_at <= second.logged_at);
  const ordered = food.entriesForDay(await local.all('food_log'), ME, day);
  assert.deepEqual(ordered.map((e) => e.quantity), [1, 2]);
});

test('a food with no brand still gets a description', async () => {
  const entry = await food.logFood({
    food: { ...OATS, brand: null }, quantity: 1, ownerEmail: ME, date: new Date(),
  });
  assert.equal(entry.description, 'Oats');
});

test('editing an amount updates the row in place and keeps its unit', async () => {
  const entry = await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: new Date() });
  const edited = await food.updateEntry({ entry, quantity: 1.18 });

  assert.equal(edited.id, entry.id, 'the same row, not a second one');
  assert.equal(edited.unit, 'serving', 'grams are a display lens; the stored unit never changes');
  assert.equal(edited.quantity, 1.18);
  assert.equal(edited.calories, 177);
  assert.equal((await local.all('food_log')).length, 1);
});

test('editing an amount cannot pull in a food edited since', async () => {
  const entry = await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: new Date() });
  const rewritten = { ...OATS, calories: 9999 };

  const edited = await food.updateEntry({ entry, quantity: 2, food: rewritten });
  assert.equal(edited.calories, 300);
});

test('deleting an entry tombstones it and drops it from the day', async () => {
  const entry = await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: new Date() });
  await food.deleteEntry(entry.id);

  const raw = await local.allRaw('food_log');
  assert.equal(raw.length, 1, 'kept so the delete can propagate');
  assert.equal(food.entriesForDay(raw, ME, new Date()).length, 0);
});

// ---- meal prep --------------------------------------------------------------------

test('copying a day forward writes new rows carrying the snapshot', async () => {
  const from = new Date('2026-08-10T12:00:00');
  const to = new Date('2026-08-11T12:00:00');
  await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: from });

  const log = await local.all('food_log');
  const created = await food.copyDay({ log, ownerEmail: ME, from, targets: [to] });

  assert.equal(created.length, 1);
  assert.equal(created[0].calories, 150, 'the copy carries the macros, not a reference');
  assert.notEqual(created[0].id, log[0].id);
  assert.equal(food.entriesForDay(await local.all('food_log'), ME, to).length, 1);
});

test('copying forward covers every target day', async () => {
  const from = new Date('2026-08-10T12:00:00');
  await food.logFood({ food: OATS, quantity: 1, ownerEmail: ME, date: from });

  const created = await food.copyDay({
    log: await local.all('food_log'),
    ownerEmail: ME,
    from,
    targets: [food.addDays(from, 1), food.addDays(from, 2), food.addDays(from, 3)],
  });
  assert.equal(created.length, 3);
});

test('a template captures a day and replays it onto another', async () => {
  const day = new Date('2026-08-10T12:00:00');
  const later = new Date('2026-08-12T12:00:00');
  await food.logFood({ food: OATS, quantity: 3, ownerEmail: ME, date: day });

  const template = await food.saveDayTemplate({
    name: 'Cut day A', log: await local.all('food_log'), ownerEmail: ME, date: day,
  });
  assert.equal(template.items.length, 1);
  assert.equal(template.name, 'Cut day A');

  await food.applyDayTemplate({ template, ownerEmail: ME, date: later });
  const replayed = food.entriesForDay(await local.all('food_log'), ME, later);

  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].calories, 450, 'the amount travels with the template');
});

test('applying an empty template is a no-op rather than a throw', async () => {
  const created = await food.applyDayTemplate({
    template: { name: 'Empty', items: [] }, ownerEmail: ME, date: new Date(),
  });
  assert.deepEqual(created, []);
});

// ---- basisLabel ---------------------------------------------------------------
// What the new-food form says the macros are measured against. `basis` arrives
// in three different shapes from lookup.js, which is how a per-100g food came
// to announce itself as "one serving = per 100 g".

test('a per-100g food does not claim to have a serving', () => {
  // There is no serving here at all — 100g is the fallback for products whose
  // label never published one.
  assert.equal(
    food.basisLabel({ serving_qty: 100, serving_unit: 'g', basis: 'per 100 g' }),
    'per 100 g',
  );
  assert.equal(
    food.basisLabel({ serving_qty: 100, serving_unit: 'ml', basis: 'per 100 ml' }),
    'per 100 ml',
  );
});

test('a serving-based food shows what one serving measures', () => {
  assert.equal(
    food.basisLabel({ serving_qty: 1, serving_unit: 'serving', basis: '55 g' }),
    'one serving = 55 g',
  );
  assert.equal(
    food.basisLabel({ serving_qty: 1, serving_unit: 'serving', basis: '3/4 cup (170 g)' }),
    'one serving = 3/4 cup (170 g)',
  );
});

test('with no measure to show, it just says per serving', () => {
  // Not "one serving = one serving".
  assert.equal(
    food.basisLabel({ serving_qty: 1, serving_unit: 'serving', basis: 'one serving' }),
    'per serving',
  );
  assert.equal(food.basisLabel({ serving_qty: 1, serving_unit: 'serving', basis: null }), 'per serving');
  assert.equal(food.basisLabel({ serving_qty: 1, serving_unit: 'serving' }), 'per serving');
});

test('basisLabel survives a half-typed form', () => {
  assert.equal(food.basisLabel(null), '');
  assert.equal(food.basisLabel({ serving_qty: 100, serving_unit: '' }), 'per 100',
    'no trailing space while the unit is empty');
  assert.equal(food.basisLabel({ serving_qty: null, serving_unit: 'g' }), 'per 1 g',
    'a blank amount reads as one rather than zero or NaN');
});

// ---- filling an entry's gaps from its food ---------------------------------

test('a blank the entry never recorded is filled from the food', () => {
  // Logged before the food learned its saturated fat, which is every entry
  // written before the label carried more than six figures.
  const entry = { ...ENTRY, quantity: 1, calories: 150, saturated_fat_g: null };
  const backing = { calories: 150, saturated_fat_g: 3, serving_qty: 1, serving_unit: 'serving' };

  const shown = food.scaleEntry(entry, 2, backing, { fillGaps: true });
  assert.equal(shown.calories, 300, 'the recorded figure still scales');
  assert.equal(shown.saturated_fat_g, 6, 'and the blank is filled at the same amount');
});

test('a figure the entry did record is never replaced by the food', () => {
  // The snapshot exists for exactly this: the food was rescanned and now says
  // something else. What was eaten does not change.
  const entry = { ...ENTRY, quantity: 1, calories: 150 };
  const rewritten = { calories: 999, serving_qty: 1, serving_unit: 'serving' };

  assert.equal(food.scaleEntry(entry, 1, rewritten, { fillGaps: true }).calories, 150);
});

test('filling gaps is off unless asked for', () => {
  const entry = { ...ENTRY, quantity: 1, saturated_fat_g: null };
  const backing = { calories: 150, saturated_fat_g: 3, serving_qty: 1, serving_unit: 'serving' };

  assert.equal(food.scaleEntry(entry, 1, backing).saturated_fat_g, null);
});

test('a gap stays a gap when the food has nothing either', () => {
  const entry = { ...ENTRY, quantity: 1, saturated_fat_g: null };
  const backing = { calories: 150, saturated_fat_g: null, serving_qty: 1, serving_unit: 'serving' };

  assert.equal(food.scaleEntry(entry, 1, backing, { fillGaps: true }).saturated_fat_g, null);
  assert.equal(food.scaleEntry(entry, 1, null, { fillGaps: true }).saturated_fat_g, null,
    'and when the food is gone entirely');
});

test('a gap is not filled across units, where the factor would be nonsense', () => {
  // 100 g of kettle corn against a food sold by the serving. scaleMacros does no
  // cross-unit conversion, so consulting it here would multiply by a hundred.
  const entry = { ...ENTRY, quantity: 100, unit: 'g', calories: 459.4, sugars_g: null };
  const backing = { calories: 130, sugars_g: 3, serving_qty: 1, serving_unit: 'serving' };

  const shown = food.scaleEntry(entry, 100, backing, { fillGaps: true });
  assert.equal(shown.sugars_g, null, 'blank beats three hundred grams of sugar');
  assert.equal(shown.calories, 459.4, 'and what was recorded is untouched');
});

test('the same food logged in its own unit does fill', () => {
  const entry = { ...ENTRY, quantity: 1, unit: 'serving', calories: 130, sugars_g: null };
  const backing = { calories: 130, sugars_g: 3, serving_qty: 1, serving_unit: 'serving' };

  assert.equal(food.scaleEntry(entry, 1, backing, { fillGaps: true }).sugars_g, 3);
});
