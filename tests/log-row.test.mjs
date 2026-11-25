/**
 * The food rows on the add food screen say how much of each food the day
 * already has, so a double tap on + shows where it happened instead of on Today.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const food = await import('../docs/js/food.js');
const local = await import('../docs/js/local.js');

const ME = 'me@example.com';
const PIZZA = { id: 'pz', name: 'Pizza', serving_qty: 1, serving_unit: 'serving', calories: 280 };

const day = (n) => food.toDateOnly(food.addDays(new Date(), n));

async function eat(dayKey, quantity, extra = {}) {
  await local.save('food_log', {
    logged_at: new Date(`${dayKey}T12:00:00`).toISOString(), food_id: PIZZA.id, description: 'Pizza',
    quantity, unit: 'serving', calories: 280 * quantity, protein_g: 0, carbs_g: 0, fat_g: 0, ...extra,
  }, ME);
}

async function rows(viewDate) {
  Alpine.store('auth').session = { user: { email: ME } };
  await Alpine.store('data').refreshCore();
  Alpine.store('ui').viewDate = viewDate;
  return Alpine.reactive(components.logPage());
}

test('a food row says how much of it the day on screen already has', async () => {
  await local.wipe();
  let page = await rows(day(0));
  assert.equal(page.loggedOnDay(PIZZA), '', 'nothing yet, nothing said');

  await eat(day(0), 1);
  await eat(day(0), 1);
  page = await rows(day(0));
  assert.equal(page.loggedOnDay(PIZZA), '2 servings today');

  await eat(day(-1), 0.5);
  page = await rows(day(-1));
  assert.equal(page.loggedOnDay(PIZZA), '0.5 servings yesterday', 'the day being logged to, not today');

  await eat(day(1), 1, { is_planned: true });
  page = await rows(day(1));
  assert.equal(page.loggedOnDay(PIZZA), '1 serving tomorrow', 'a plan counts on its day');

  page = await rows(day(-3));
  await eat(day(-3), 3);
  page = await rows(day(-3));
  assert.equal(page.loggedOnDay(PIZZA), `3 servings on ${food.dayLabel(food.fromDateOnly(day(-3)))}`);
});

test('the row prints it under the amount, in its own line', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button class="row-text" @click="openSheet\(item\)">[\s\S]*?<small class="row-logged" x-show="loggedOnDay\(item\)" x-text="loggedOnDay\(item\)"><\/small>\s*<\/button>/);
});
