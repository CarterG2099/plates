/**
 * food.js — food domain logic.
 *
 * Everything here works off arrays already loaded from IndexedDB. Nothing in
 * this file touches the network, because nothing in the logging path is allowed
 * to: that is the whole reason the app exists in this shape.
 */

import * as local from './local.js';
import * as sync from './sync.js';

export const MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg'];

// ---- dates -----------------------------------------------------------------

/** Local-midnight bounds for a day, so "today" means the user's today. */
export function dayBounds(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export function isSameDay(iso, date = new Date()) {
  const { start, end } = dayBounds(date);
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t < end.getTime();
}

/**
 * Which meal you're logging, inferred from the clock so it never has to be
 * picked. Boundaries are deliberately generous — a late breakfast is still
 * breakfast.
 */
export function inferMealSlot(date = new Date()) {
  const h = date.getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

export const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];

/** Nominal times, used when logging to a day that isn't today. */
const SLOT_HOURS = { breakfast: 8, lunch: 12, dinner: 18, snack: 15 };

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function toDateOnly(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromDateOnly(iso) {
  return new Date(`${iso}T00:00:00`);   // parsed as local, not UTC
}

export function dayLabel(date, now = new Date()) {
  const diff = Math.round((dayBounds(date).start - dayBounds(now).start) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function isFuture(date, now = new Date()) {
  return dayBounds(date).start > dayBounds(now).start;
}

/**
 * When to stamp an entry. Logging to today means now; logging to another day
 * uses the meal's nominal hour, so planned days still sort sensibly.
 */
export function timestampFor(date, mealSlot, now = new Date()) {
  if (dayBounds(date).start.getTime() === dayBounds(now).start.getTime()) return now;

  const at = new Date(date);
  at.setHours(SLOT_HOURS[mealSlot] ?? 12, 0, 0, 0);
  return at;
}

// ---- goals -----------------------------------------------------------------

/** The goal whose date window contains `date` — the latest one that qualifies. */
export function currentGoal(goals, ownerEmail, date = new Date()) {
  const day = toDateOnly(date);
  return goals
    .filter((g) => g.owner_email === ownerEmail && !g.deleted_at)
    .filter((g) => g.starts_on <= day && (!g.ends_on || g.ends_on >= day))
    .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1))[0] ?? null;
}

// ---- totals ----------------------------------------------------------------

export function emptyTotals() {
  return Object.fromEntries(MACROS.map((m) => [m, 0]));
}

export function sumTotals(entries) {
  const totals = emptyTotals();
  for (const e of entries) {
    for (const m of MACROS) totals[m] += Number(e[m]) || 0;
  }
  return totals;
}

/** Entries for one day, oldest first, grouped ready for the Today screen. */
export function entriesForDay(log, ownerEmail, date = new Date()) {
  return log
    .filter((e) => e.owner_email === ownerEmail && !e.deleted_at && isSameDay(e.logged_at, date))
    .sort((a, b) => (a.logged_at < b.logged_at ? -1 : 1));
}

export function groupByMeal(entries) {
  return MEAL_ORDER
    .map((slot) => ({
      slot,
      entries: entries.filter((e) => (e.meal_slot ?? 'snack') === slot),
    }))
    .filter((g) => g.entries.length)
    .map((g) => ({ ...g, totals: sumTotals(g.entries) }));
}

/** How many times this food has been logged today — drives the undo affordance. */
export function countLoggedToday(log, ownerEmail, foodId, date = new Date()) {
  if (!foodId) return 0;
  return entriesForDay(log, ownerEmail, date).filter((e) => e.food_id === foodId).length;
}

/** The most recent entry for a food today, so a mis-tap can be taken straight back. */
export function lastEntryForFood(log, ownerEmail, foodId, date = new Date()) {
  if (!foodId) return null;
  const matches = entriesForDay(log, ownerEmail, date).filter((e) => e.food_id === foodId);
  return matches[matches.length - 1] ?? null;   // entriesForDay sorts oldest first
}

// ---- ranking ---------------------------------------------------------------

const RANK_WINDOW_DAYS = 90;

/**
 * Your foods, ordered by how often you actually eat them.
 *
 * This is the screen that decides whether the app gets used, so it is computed
 * entirely from the local log — no query, no round trip, and correct offline.
 * Recency breaks ties so a food you ate this morning outranks one you ate
 * equally often but months ago.
 */
export function rankFoods(foods, log, ownerEmail) {
  const cutoff = Date.now() - RANK_WINDOW_DAYS * 86400_000;

  const stats = new Map();
  for (const e of log) {
    if (e.owner_email !== ownerEmail || e.deleted_at || !e.food_id) continue;
    if (new Date(e.logged_at).getTime() < cutoff) continue;

    const s = stats.get(e.food_id) ?? { count: 0, last: '', quantity: null, unit: null };
    s.count += 1;
    if (e.logged_at > s.last) {
      s.last = e.logged_at;
      s.quantity = e.quantity;
      s.unit = e.unit;
    }
    stats.set(e.food_id, s);
  }

  return foods
    .filter((f) => !f.deleted_at)
    .map((f) => {
      const s = stats.get(f.id);
      return {
        ...f,
        count: s?.count ?? 0,
        lastLoggedAt: s?.last ?? null,
        lastQuantity: s?.quantity ?? null,
        lastUnit: s?.unit ?? null,
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.lastLoggedAt && b.lastLoggedAt) return a.lastLoggedAt < b.lastLoggedAt ? 1 : -1;
      if (a.lastLoggedAt) return -1;
      if (b.lastLoggedAt) return 1;
      return a.name.localeCompare(b.name);
    });
}

/** Local substring search. Nothing here is worth a network call. */
export function searchFoods(ranked, term) {
  const q = term.trim().toLowerCase();
  if (!q) return ranked;
  return ranked.filter((f) =>
    f.name.toLowerCase().includes(q) || (f.brand ?? '').toLowerCase().includes(q));
}

// ---- scaling ---------------------------------------------------------------

/**
 * Scale a food's per-serving macros to a logged quantity.
 *
 * Assumes the logged unit matches the food's serving unit — true for everything
 * entered through this app, since the quantity stepper inherits the food's own
 * unit. Cross-unit conversion (cups to grams) is a separate problem and is not
 * pretended to be solved here.
 */
export function scaleMacros(food, quantity) {
  const per = Number(food.serving_qty) || 1;
  const factor = (Number(quantity) || 0) / per;

  const out = {};
  for (const m of MACROS) {
    const value = Number(food[m]);
    out[m] = Number.isFinite(value) ? round(value * factor, 1) : null;
  }
  return out;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ---- writes ----------------------------------------------------------------

/**
 * Log a food. Macros are snapshotted onto the entry rather than referenced, so
 * editing or deleting the food later cannot rewrite what you already ate.
 */
export async function logFood({ food, quantity, unit, mealSlot, ownerEmail, date }) {
  const slot = mealSlot ?? inferMealSlot();

  const entry = await local.save('food_log', {
    logged_at: timestampFor(date ?? new Date(), slot).toISOString(),
    meal_slot: slot,
    food_id: food.id ?? null,
    recipe_id: food.recipe_id ?? null,
    description: food.brand ? `${food.name} · ${food.brand}` : food.name,
    quantity: Number(quantity),
    unit: unit ?? food.serving_unit ?? 'g',
    ...scaleMacros(food, quantity),
  }, ownerEmail);

  sync.nudge();
  return entry;
}

/** Log every item of a saved combo in one go. */
export async function logCombo({ combo, foodsById, mealSlot, ownerEmail, date }) {
  const slot = mealSlot ?? inferMealSlot();
  const logged = [];

  for (const item of combo.items ?? []) {
    const food = foodsById.get(item.food_id);
    if (!food) continue;
    logged.push(await logFood({
      food,
      quantity: item.quantity,
      unit: item.unit,
      mealSlot: slot,
      ownerEmail,
      date,
    }));
  }
  return logged;
}

// ---- meal prep -------------------------------------------------------------

/** The fields that make an entry reproducible on another day. */
function portable(entry) {
  return {
    meal_slot: entry.meal_slot,
    food_id: entry.food_id ?? null,
    recipe_id: entry.recipe_id ?? null,
    description: entry.description,
    quantity: entry.quantity,
    unit: entry.unit,
    calories: entry.calories,
    protein_g: entry.protein_g,
    carbs_g: entry.carbs_g,
    fat_g: entry.fat_g,
    fiber_g: entry.fiber_g,
    sodium_mg: entry.sodium_mg,
  };
}

/**
 * Copy a day's entries onto other days — cook once, eat Monday through Thursday.
 * Macros come from the copied entries, not from the foods, so a copy is a true
 * snapshot even if the food is edited afterwards.
 */
export async function copyDay({ log, ownerEmail, from, targets }) {
  const entries = entriesForDay(log, ownerEmail, from);
  const created = [];

  for (const target of targets) {
    for (const entry of entries) {
      const item = portable(entry);
      created.push(await logEntry(item, target, ownerEmail));
    }
  }

  sync.nudge();
  return created;
}

export async function saveDayTemplate({ name, log, ownerEmail, date }) {
  const items = entriesForDay(log, ownerEmail, date).map(portable);
  const template = await local.save('day_templates', { name, items }, ownerEmail);
  sync.nudge();
  return template;
}

export async function applyDayTemplate({ template, ownerEmail, date }) {
  const created = [];
  for (const item of template.items ?? []) {
    created.push(await logEntry(item, date, ownerEmail));
  }
  sync.nudge();
  return created;
}

function logEntry(item, date, ownerEmail) {
  return local.save('food_log', {
    ...item,
    logged_at: timestampFor(date, item.meal_slot).toISOString(),
  }, ownerEmail);
}

export async function deleteTemplate(id) {
  const row = await local.remove('day_templates', id);
  sync.nudge();
  return row;
}

export async function saveFood(fields, ownerEmail) {
  const food = await local.save('foods', fields, ownerEmail);
  sync.nudge();
  return food;
}

export async function deleteEntry(id) {
  const row = await local.remove('food_log', id);
  sync.nudge();
  return row;
}

// ---- what's left, in food you actually eat ---------------------------------

/**
 * Express remaining calories as servings of foods you already eat.
 *
 * "253 kcal left" is abstract; "about one chicken breast" is a decision. Built
 * from your own frequents, so it is never generic advice — and it reuses the
 * same ranking that already drives the logger.
 */
export function remainingAsFoods(remainingKcal, rankedFoods, limit = 2) {
  const remaining = Number(remainingKcal);
  if (!Number.isFinite(remaining) || remaining < 50) return [];

  return rankedFoods
    .filter((f) => f.count > 0 && Number(f.calories) > 0)
    .map((f) => {
      const quantity = f.lastQuantity ?? f.serving_qty ?? 1;
      const perServing = Number(f.calories) * (quantity / (Number(f.serving_qty) || 1));
      return { food: f, perServing, servings: Math.round(remaining / perServing) };
    })
    // One to three servings: "6 scoops of whey" is arithmetic, not a suggestion.
    .filter((x) => x.servings >= 1 && x.servings <= 3 && x.perServing >= 40)
    .slice(0, limit)
    .map((x) => ({
      ...x,
      label: x.servings === 1 ? `1 ${x.food.name}` : `${x.servings} × ${x.food.name}`,
    }));
}

// ---- goals -----------------------------------------------------------------

const numeric = (v) => (v === '' || v == null ? null : Number(v));

/** Calories implied by a macro split, for sanity-checking against the target. */
export function caloriesFromMacros({ protein_target_g, carbs_target_g, fat_target_g }) {
  const p = Number(protein_target_g) || 0;
  const c = Number(carbs_target_g) || 0;
  const f = Number(fat_target_g) || 0;
  if (!p && !c && !f) return null;
  return Math.round(p * 4 + c * 4 + f * 9);
}

/** Adjust the goal you're already in — same phase, corrected numbers. */
export async function updateGoal(goal, fields, ownerEmail) {
  const row = await local.save('goals', {
    ...goal,
    phase: fields.phase || null,
    calorie_target: numeric(fields.calorie_target),
    protein_target_g: numeric(fields.protein_target_g),
    carbs_target_g: numeric(fields.carbs_target_g),
    fat_target_g: numeric(fields.fat_target_g),
    target_weight_lb: numeric(fields.target_weight_lb),
  }, ownerEmail);

  sync.nudge();
  return row;
}

/**
 * Begin a new phase from today, closing the previous one yesterday.
 *
 * This is why goals are a dated table rather than columns on members: switching
 * from a cut to a bulk should leave the cut's targets intact, so "what was I
 * aiming for in March" stays answerable.
 */
export async function startPhase(fields, current, ownerEmail) {
  if (current) {
    await local.save('goals', {
      ...current,
      ends_on: toDateOnly(addDays(new Date(), -1)),
    }, ownerEmail);
  }

  const row = await local.save('goals', {
    phase: fields.phase || null,
    starts_on: toDateOnly(new Date()),
    ends_on: null,
    calorie_target: numeric(fields.calorie_target),
    protein_target_g: numeric(fields.protein_target_g),
    carbs_target_g: numeric(fields.carbs_target_g),
    fat_target_g: numeric(fields.fat_target_g),
    target_weight_lb: numeric(fields.target_weight_lb),
  }, ownerEmail);

  sync.nudge();
  return row;
}

/** Every phase you've been through, newest first. */
export function goalHistory(goals, ownerEmail) {
  return goals
    .filter((g) => g.owner_email === ownerEmail && !g.deleted_at)
    .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1));
}
