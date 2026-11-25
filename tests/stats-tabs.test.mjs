/**
 * Stats as four tabs: Food, Body, Training, Goals.
 *
 * The order and which tabs show are a per-phone preference, so what is saved
 * may come from an older app; the swipe moves between tabs and, past the first
 * one, carries on to Train; the long lists fold to one line.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const stats = await import('../docs/js/stats.js');
const food = await import('../docs/js/food.js');
const local = await import('../docs/js/local.js');

const ui = () => Alpine.store('ui');
const reset = () => {
  localStorage.removeItem('plates:stats-tabs');
  ui().statsArrangement = stats.normaliseStatsTabs(null);
  ui().statsTab = null;
};

test('a saved arrangement keeps every tab exactly once, in the saved order', () => {
  assert.deepEqual(stats.normaliseStatsTabs(null), { order: ['food', 'body', 'training', 'goals'], hidden: [] });
  assert.deepEqual(stats.normaliseStatsTabs({ order: ['goals', 'training'] }).order, ['goals', 'training', 'food', 'body'],
    'tabs it did not know about are added at the end');
  assert.deepEqual(stats.normaliseStatsTabs({ order: ['goals', 'photos', 'goals', 'food'] }).order, ['goals', 'food', 'body', 'training'],
    'unknown and repeated tabs are dropped');
});

test('a saved arrangement can never hide every tab', () => {
  assert.deepEqual(stats.normaliseStatsTabs({ hidden: ['food', 'body', 'training', 'goals'] }).hidden, []);
  assert.deepEqual(stats.normaliseStatsTabs({ hidden: ['body', 'nope', 'body'] }).hidden, ['body']);
});

test('the first showing tab is on screen until another is picked', () => {
  reset();
  assert.equal(ui().statsActive, 'food');
  ui().setStatsTab('training');
  assert.equal(ui().statsActive, 'training');
});

test('swiping moves one tab and reports the ends so the app can carry on', () => {
  reset();
  assert.equal(ui().shiftStatsTab(1), true);
  assert.equal(ui().statsActive, 'body');
  assert.equal(ui().shiftStatsTab(-1), true);
  assert.equal(ui().shiftStatsTab(-1), false, 'nothing before Food');
  assert.equal(ui().statsActive, 'food');
  ui().setStatsTab('goals');
  assert.equal(ui().shiftStatsTab(1), false, 'nothing after Goals');
});

test('dragging a tab moves it and is saved for next time', () => {
  reset();
  ui().moveStatsTab('goals', 0);
  assert.deepEqual(ui().statsTabs.map((t) => t.key), ['goals', 'food', 'body', 'training']);
  ui().moveStatsTab('food', 99);
  assert.deepEqual(ui().statsTabs.map((t) => t.key), ['goals', 'body', 'training', 'food']);
  assert.deepEqual(JSON.parse(localStorage.getItem('plates:stats-tabs')).order, ['goals', 'body', 'training', 'food']);
});

test('a hidden tab leaves the bar and the swipe, but not the Edit list', () => {
  reset();
  ui().toggleStatsTab('body');
  assert.deepEqual(ui().statsTabs.map((t) => t.key), ['food', 'training', 'goals']);
  assert.equal(ui().statsTabOrder.find((t) => t.key === 'body').hidden, true);
  ui().setStatsTab('food');
  ui().shiftStatsTab(1);
  assert.equal(ui().statsActive, 'training', 'the swipe skips it');
  ui().toggleStatsTab('body');
  assert.equal(ui().statsTabs.length, 4);
});

test('the last showing tab cannot be hidden', () => {
  reset();
  for (const key of ['food', 'body', 'training']) ui().toggleStatsTab(key);
  ui().toggleStatsTab('goals');
  assert.deepEqual(ui().statsTabs.map((t) => t.key), ['goals']);
});

test('hiding the tab on screen moves to the first one still showing', () => {
  reset();
  ui().setStatsTab('body');
  ui().toggleStatsTab('body');
  assert.equal(ui().statsActive, 'food');
});

const ME = 'tabs@example.com';
const DAY = 86_400_000;

async function page() {
  Alpine.store('auth').session = { user: { email: ME } };
  await Alpine.store('data').refreshCore();
  await Alpine.store('data').refreshTraining();
  return Alpine.reactive(components.statsPage());
}

test('Goals averages the complete days of the last two weeks, against the goal of each day', async () => {
  const day = (n) => food.toDateOnly(new Date(Date.now() - n * DAY));
  await local.save('goals', { starts_on: '2020-01-01', calorie_target: 2000, protein_target_g: 100, carbs_target_g: 200, fat_target_g: 50 }, ME);
  for (const [n, kcal, done] of [[1, 2000, true], [2, 2400, true], [3, 500, false], [20, 9000, true]]) {
    await local.save('food_log', { logged_at: new Date(`${day(n)}T12:00:00`).toISOString(), description: 'x', quantity: 1, unit: 'serving',
      calories: kcal, protein_g: 100, carbs_g: 200, fat_g: 50 }, ME);
    await local.save('day_marks', { day: day(n), complete: done }, ME);
  }
  const p = await page();
  assert.deepEqual(p.goalAverages.tiles.map((t) => t.text), ['110%', '100%', '100%', '100%'],
    'the incomplete day and the one three weeks ago are left out');
  assert.equal(p.goalAverages.sub, 'average of 2 complete days, last 14');
});

test('the folded summaries name what is inside', async () => {
  const p = await page();
  assert.equal(p.liftsSummary, '');
  assert.equal(p.prsSummary, '');
  assert.equal(p.compareSummary, 'Where your lifts stand for your size');
});

test('each card sits in its tab, and the long lists fold', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const panel = (key) => {
    const start = html.indexOf(`<div class="stats-panel" data-tab="${key}"`);
    assert.ok(start > 0, `${key} panel exists`);
    const next = html.indexOf('<div class="stats-panel"', start + 10);
    return html.slice(start, next > 0 ? next : html.indexOf('<!-- Edit targets', start));
  };
  assert.match(panel('food'), /Calories · 14 day average/);
  assert.match(panel('body'), /card-label">Body weight/);
  assert.match(panel('body'), /card-label">Progress photos/);
  for (const label of ['Consistency', 'Weekly volume', 'Sets per muscle', 'Best lifts', 'How you compare', 'Personal records']) {
    assert.match(panel('training'), new RegExp(`card-label">${label}`), label);
  }
  assert.match(panel('goals'), /card-label">Targets/);
  assert.match(panel('goals'), /card-label">Weight goal/);
  assert.match(panel('goals'), /x-for="t in goalAverages\.tiles"/);
  assert.equal((panel('training').match(/class="card fold"/g) ?? []).length, 3, 'lifts, comparison and records fold');
  assert.match(html, /x-show="\$store\.ui\.statsActive === 'food'"/);
  assert.match(html, /\$store\.ui\.moveStatsTab\(key, to\)/);
  assert.match(html, /\$store\.ui\.toggleStatsTab\(t\.key\)/);
});

test('the swipe on a Stats panel moves the Stats tab before it moves the app', async () => {
  const src = await readFile(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const nav = src.slice(src.indexOf('function swipeNav()'), src.indexOf('trackKeyboardInset();'));
  assert.match(nav, /closest\('\.stats-panel'\)/);
  assert.match(nav, /which === 'stats' && ui\.shiftStatsTab\(forward \? 1 : -1\)/);
  assert.match(nav, /ui\.shiftDay\(forward \? 7 : -7\)/, 'the week strip moves a week');
});
