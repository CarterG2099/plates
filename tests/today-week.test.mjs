/**
 * Today's week strip, rings, week averages and meds.
 *
 * The week is Monday to Sunday around the day on screen. Its averages count
 * only days marked complete — a half-logged day reads as eating less than
 * really happened — and each day is measured against the goal in force on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const food = await import('../docs/js/food.js');
const local = await import('../docs/js/local.js');

const ME = 'me@example.com';
const OTHER = 'other@example.com';

/** Noon on a day, local, so no timezone moves an entry across midnight. */
const at = (day) => new Date(`${day}T12:00:00`).toISOString();

async function eat(day, macros, owner = ME) {
  await local.save('food_log', {
    logged_at: at(day), description: 'Food', quantity: 1, unit: 'serving',
    calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, ...macros,
  }, owner);
}

async function mark(day, complete, owner = ME) {
  await local.save('day_marks', { day, complete }, owner);
}

let seeded = false;
async function today(viewDate) {
  Alpine.store('auth').session = { user: { email: ME } };
  if (!seeded) {
    seeded = true;
    await local.save('goals', {
      starts_on: '2026-01-01', calorie_target: 2100, protein_target_g: 180, carbs_target_g: 210, fat_target_g: 60,
    }, ME);
    // The week of Mon Nov 16 – Sun Nov 22, 2026.
    await eat('2026-11-16', { calories: 2100, protein_g: 180, carbs_g: 210, fat_g: 60 });   // 100% everything
    await mark('2026-11-16', true);
    await eat('2026-11-17', { calories: 2310, protein_g: 90, carbs_g: 210, fat_g: 72 });    // over on calories and fat
    await mark('2026-11-17', true);
    await eat('2026-11-18', { calories: 900, protein_g: 40, carbs_g: 80, fat_g: 20 });      // a half day, marked incomplete
    await mark('2026-11-18', false);
    await eat('2026-11-19', { calories: 1500, protein_g: 100, carbs_g: 150, fat_g: 50 });   // logged, never reviewed
    await eat('2026-11-20', { calories: 5000, protein_g: 400, carbs_g: 500, fat_g: 200 }, OTHER);  // someone else's
    await mark('2026-11-20', true, OTHER);
  }
  await Alpine.store('data').refreshCore();
  Alpine.store('ui').viewDate = viewDate;
  return Alpine.reactive(components.todayPage());
}

test('weekOf gives Monday to Sunday around any day of the week', () => {
  for (const day of ['2026-11-16', '2026-11-19', '2026-11-22']) {
    const week = food.weekOf(food.fromDateOnly(day)).map(food.toDateOnly);
    assert.deepEqual(week, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'], day);
  }
  assert.equal(food.toDateOnly(food.weekOf(food.fromDateOnly('2026-11-23'))[0]), '2026-11-23', 'a Monday starts its own week');
});

test('dayStatus: the mark wins, then the future, today, logged and empty', () => {
  const t = '2026-11-24';
  assert.equal(food.dayStatus({ key: '2026-11-20', mark: true, logged: 3 }, t), 'complete');
  assert.equal(food.dayStatus({ key: '2026-11-20', mark: false, logged: 3 }, t), 'incomplete');
  assert.equal(food.dayStatus({ key: '2026-11-20', mark: null, logged: 3 }, t), 'unreviewed');
  assert.equal(food.dayStatus({ key: '2026-11-20', mark: null, logged: 0 }, t), 'empty');
  assert.equal(food.dayStatus({ key: t, mark: null, logged: 0 }, t), 'today');
  assert.equal(food.dayStatus({ key: t, mark: true, logged: 2 }, t), 'complete', 'today can be finished early');
  assert.equal(food.dayStatus({ key: '2026-11-25', mark: null, logged: 0 }, t), 'future');
});

test('the week averages only the days marked complete', () => {
  const day = (mark, logged, totals, targets = { calories: 2000, protein_g: 100, carbs_g: null, fat_g: 50 }) =>
    ({ mark, logged, totals, targets });
  const avg = food.completedAverages([
    day(true, 1, { calories: 2000, protein_g: 100, carbs_g: 10, fat_g: 50 }),
    day(true, 1, { calories: 2200, protein_g: 50, carbs_g: 10, fat_g: 75 }),
    day(false, 1, { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }),
    day(null, 1, { calories: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }),
    day(true, 0, { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }),
  ]);
  assert.deepEqual(avg, { count: 2, calories: 105, protein_g: 75, carbs_g: null, fat_g: 125 });
});

test('no complete days means no averages, not zeroes', () => {
  assert.deepEqual(food.completedAverages([]), { count: 0, calories: null, protein_g: null, carbs_g: null, fat_g: null });
});

test('a day is measured against the goal that was in force on it', () => {
  const goals = [
    { owner_email: ME, starts_on: '2026-01-01', ends_on: '2026-11-17', calorie_target: 2500 },
    { owner_email: ME, starts_on: '2026-11-18', calorie_target: 2000, protein_target_g: 150 },
  ];
  const data = { log: [], goals, marks: [] };
  assert.equal(food.dayAgainstGoal(data, ME, food.fromDateOnly('2026-11-17')).targets.calories, 2500);
  const later = food.dayAgainstGoal(data, ME, food.fromDateOnly('2026-11-18')).targets;
  assert.deepEqual(later, { calories: 2000, protein_g: 150, carbs_g: null, fat_g: null });
});

test('the strip shows the seven days with the right marks, and the viewed day picked', async () => {
  const page = await today('2026-11-19');
  assert.deepEqual(page.week.map((d) => d.key),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
  assert.deepEqual(page.week.map((d) => d.on), [false, false, false, true, false, false, false]);
  const marks = page.week.map((d) => (d.markSvg.match(/mark-(\w+)/) ?? [])[1] ?? '');
  // Thursday the 19th is in the past here (the clock says later than 2026-11-22), so it is unreviewed.
  assert.deepEqual(marks.slice(0, 4), ['complete', 'complete', 'incomplete', 'unreviewed']);
  assert.equal(marks[4], '', 'another person\'s complete day is not mine');
  assert.match(page.week[1].aria, /complete$/);
});

test('tapping a day in the strip opens it', async () => {
  const page = await today('2026-11-19');
  page.pickDay('2026-11-17');
  assert.equal(Alpine.store('ui').viewDate, '2026-11-17');
  assert.equal(page.week.find((d) => d.on).key, '2026-11-17');
  assert.equal(page.status.key, 'complete');
  assert.equal(page.status.text, 'Complete');
});

test('the rows beside the rings show amount, target, share, and how far over', async () => {
  const page = await today('2026-11-17');
  const [cal, protein, , fat] = page.ringRows;
  assert.equal(cal.value, '2,310');
  assert.equal(cal.of, '/ 2,100 · 110%');
  assert.equal(cal.over, true);
  assert.equal(cal.overText, '+10% over');
  assert.equal(protein.of, '/ 180 g · 50%');
  assert.equal(protein.over, false);
  assert.equal(fat.overText, '+20% over');
  assert.deepEqual(cal.nutrient, { key: 'calories', name: 'Calories', unit: ' kcal' });
  assert.match(page.ringsSvg, /aria-label="2310 kcal, 90 g protein, 210 g carbs, 72 g fat"/);
  assert.equal((page.ringsSvg.match(/class="ring-tick"/g) ?? []).length, 2, 'calories and fat lapped');
});

test('a past day says how it landed against the target', async () => {
  assert.equal((await today('2026-11-17')).ringNote, '210 kcal over target');
  assert.equal((await today('2026-11-18')).ringNote, '1,200 kcal under target');
  assert.equal((await today('2026-11-16')).ringNote, 'Right on the calorie target');
  assert.equal((await today('2026-11-21')).ringNote, 'Nothing logged');
});

test('the week tiles average the two complete days and ignore the rest', async () => {
  const page = await today('2026-11-19');
  const tiles = Object.fromEntries(page.weekAverages.tiles.map((t) => [t.key, t.text]));
  // Monday 100%, Tuesday 110% calories / 50% protein / 100% carbs / 120% fat.
  assert.deepEqual(tiles, { calories: '105%', protein_g: '75%', carbs_g: '100%', fat_g: '110%' });
  assert.equal(page.weekAverages.sub, 'average of 2 complete days');
  assert.equal(page.weekAverages.title, 'Week of Nov 16');
  assert.equal(page.weekAverages.tiles.find((t) => t.key === 'fat_g').width, 100, 'a bar stops at full');
});

test('marking a day complete brings it into the week', async () => {
  const page = await today('2026-11-19');
  await page.toggleDayMark();
  await Alpine.store('data').refreshCore();
  assert.equal(page.weekAverages.count, 3);
  assert.equal(page.week[3].markSvg.includes('mark-complete'), true);
  await page.toggleDayMark();   // and back, for the tests after this one
  await Alpine.store('data').refreshCore();
  assert.equal(page.weekAverages.count, 2);
});

test('a week with nothing complete says how days get in, with dashes not zeroes', async () => {
  const page = await today('2026-11-02');
  assert.equal(page.weekAverages.count, 0);
  assert.equal(page.weekAverages.sub, 'counts days once you mark them complete');
  assert.deepEqual(page.weekAverages.tiles.map((t) => t.text), ['–', '–', '–', '–']);
});

test('the meds card lists today\'s doses: meds only, switched on, due today', async () => {
  const todayKey = food.toDateOnly(new Date());
  const page = await today(todayKey);
  const weekday = new Date().getDay();
  const ui = Alpine.store('ui');
  ui.reminderList = [
    { id: 'a', kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: [weekday], enabled: true },
    { id: 'b', kind: 'meds', label: 'Off', at_time: '07:00:00', days: [weekday], enabled: false },
    { id: 'c', kind: 'meds', label: 'Not today', at_time: '07:00:00', days: [(weekday + 1) % 7], enabled: true },
    { id: 'd', kind: 'food', label: 'Lunch', at_time: '12:30:00', days: [weekday], enabled: true },
  ];
  ui.reminderToday = {};
  assert.deepEqual(page.meds.map((m) => m.id), ['a']);
  assert.equal(page.medsSummary, '0 of 1 taken');
  assert.equal(page.medLine(page.meds[0]), '6:45am');

  ui.reminderToday = { a: { taken_at: new Date(`${todayKey}T09:02:00`).toISOString() } };
  assert.equal(page.medsSummary, '1 of 1 taken');
  assert.equal(page.medLine(page.meds[0]), '6:45am · taken 9:02am');
});

test('the meds card is today only: a dose taken is a today fact', async () => {
  const page = await today('2026-11-17');
  Alpine.store('ui').reminderList = [{ id: 'a', kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true }];
  assert.deepEqual(page.meds, []);
});

test('the Today markup draws the strip, the rings, the meds and the tiles from these getters', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const todayHtml = html.slice(html.indexOf('x-data="todayPage"'), html.indexOf('<!-- Edit a logged amount'));
  assert.match(todayHtml, /<template x-for="d in week"/);
  assert.match(todayHtml, /x-html="d\.svg"/);
  assert.match(todayHtml, /x-html="ringsSvg"/);
  assert.match(todayHtml, /@click="pickDay\(d\.key\)"/);
  assert.match(todayHtml, /x-for="m in meds"/);
  assert.match(todayHtml, /\$store\.ui\.toggleTaken\(m\)/);
  assert.match(todayHtml, /x-for="t in weekAverages\.tiles"/);
  assert.match(todayHtml, /x-for="r in weekLabel\.printedRows"/, 'the average complete day is still there as a full label');
  assert.match(todayHtml, /@click="weekLabelOpen = !weekLabelOpen"/);
  assert.match(todayHtml, /@click="\$store\.ui\.shiftDay\(-1\)" aria-label="Previous day"/, 'a day back without a swipe');
  assert.match(todayHtml, /@click="\$store\.ui\.shiftDay\(1\)" aria-label="Next day"/);
  assert.doesNotMatch(todayHtml, /class="rack"/, 'the rings replace the bar');
});

test('the food suggestion is for today only: a past day has nothing left to fill', async () => {
  // A food eaten recently, so there is something to suggest. Sunday: unmarked,
  // so it changes neither the averages nor the marks the tests above read.
  const rice = await local.save('foods', { name: 'Rice bowl', serving_qty: 1, serving_unit: 'bowl', calories: 800, protein_g: 20, carbs_g: 150, fat_g: 10 }, ME);
  await eat('2026-11-22', { food_id: rice.id, description: 'Rice bowl', calories: 800 });

  const now = await today(food.toDateOnly(new Date()));
  assert.match(now.remainingInFood, /Rice bowl/, 'today: what would fill the rest of the day');
  const past = await today('2026-11-18');   // 1,200 kcal under, a past day
  assert.equal(past.remainingInFood, '');
});

test('the average day label covers the complete days of the week on screen, up to today', async () => {
  const page = await today('2026-11-19');
  assert.equal(page.weekLabel.loggedDays, 2, 'Monday and Tuesday; the incomplete and unreviewed days stay out');
  assert.equal(page.weekLabel.calories, 2205, '(2,100 + 2,310) / 2');
});

test('planned food shows on the rings and in their spoken label', async () => {
  const day = food.toDateOnly(new Date());
  await local.save('food_log', { logged_at: at(day), description: 'Dinner', quantity: 1, unit: 'serving',
    calories: 500, protein_g: 40, carbs_g: 50, fat_g: 15, is_planned: true }, ME);
  const page = await today(day);
  assert.match(page.ringsSvg, /class="ring-plan ring-cal"/);
  assert.match(page.ringsSvg, /plus 500 kcal planned/);
});
