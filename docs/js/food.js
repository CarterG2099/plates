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

const RANK_WINDOW_DAYS = 180;
const HALF_LIFE_DAYS = 21;

const DAY_MS = 86400_000;

/**
 * Your foods, ordered by how much you're eating them *now*.
 *
 * Each log entry is worth 0.5^(age / half-life) rather than a flat 1, so the
 * ordering follows the phase you're in. A raw count lets something you ate ten
 * times in March sit above what you've eaten three times this week, and the
 * staples rotate often enough that this was visibly wrong.
 *
 * Computed entirely from the local log — no query, no round trip, correct
 * offline. This is the screen that decides whether the app gets used.
 */
export function rankFoods(foods, log, ownerEmail) {
  const now = Date.now();
  const cutoff = now - RANK_WINDOW_DAYS * DAY_MS;

  const stats = new Map();
  for (const e of log) {
    if (e.owner_email !== ownerEmail || e.deleted_at || !e.food_id) continue;

    const at = new Date(e.logged_at).getTime();
    if (!(at >= cutoff)) continue;      // also rejects an unparseable date

    const s = stats.get(e.food_id)
      ?? { count: 0, frecency: 0, last: '', quantity: null, unit: null };

    s.count += 1;
    s.frecency += 0.5 ** ((now - at) / (HALF_LIFE_DAYS * DAY_MS));

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
        frecency: s?.frecency ?? 0,
        lastLoggedAt: s?.last ?? null,
        lastQuantity: s?.quantity ?? null,
        lastUnit: s?.unit ?? null,
      };
    })
    .sort((a, b) => (b.frecency - a.frecency) || a.name.localeCompare(b.name));
}

/**
 * How well a food answers what you typed.
 *
 * A plain `includes()` scored "Rolled Oats" and "Chocolate Oatmeal Bar" the
 * same for "oat", leaving history to break a tie that text should have won.
 * These weights multiply frecency, so a staple beats a one-off within a tier
 * while a weak text match can never win on history alone.
 */
const WEIGHT = { barcode: 100, exact: 100, prefix: 40, word: 20, substring: 8, brand: 4 };

/** One phrase against one food. */
function phraseWeight(food, q) {
  const name = (food.name ?? '').toLowerCase();
  if (name === q) return WEIGHT.exact;
  if (name.startsWith(q)) return WEIGHT.prefix;
  if (name.split(/[\s\-(,/]+/).some((w) => w.startsWith(q))) return WEIGHT.word;
  if (name.includes(q)) return WEIGHT.substring;

  return (food.brand ?? '').toLowerCase().includes(q) ? WEIGHT.brand : 0;
}

/**
 * How well a food answers what you typed.
 *
 * The whole query used to be matched as one substring, so "milk 2%" could only
 * find a food whose name literally contained "milk 2%" — not "2% Milk", not
 * "Milk, 2% reduced fat". Multi-word searches found almost nothing.
 *
 * Now every word has to appear somewhere, and the score is the average of what
 * each word scored. An exact phrase still wins outright, because typing the
 * whole name is the least ambiguous thing you can do.
 */
function matchWeight(food, q) {
  // A scanned code you already own must beat anything the internet offers.
  if (food.barcode && String(food.barcode) === q) return WEIGHT.barcode;

  const whole = phraseWeight(food, q);
  if (whole >= WEIGHT.prefix) return whole;

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length < 2) return whole;

  let total = 0;
  for (const term of terms) {
    const weight = phraseWeight(food, term);
    if (!weight) return 0;                 // every word must land somewhere
    total += weight;
  }
  // Averaged, not summed: a two-word match must not out-score an exact name.
  return Math.max(whole, total / terms.length);
}

/** Local search. Nothing here is worth a network call. */
export function searchFoods(ranked, term) {
  const q = term.trim().toLowerCase();
  if (!q) return ranked;

  return ranked
    .map((f) => ({ food: f, weight: matchWeight(f, q) }))
    .filter((m) => m.weight > 0)
    .map((m) => ({ ...m.food, score: m.weight * (1 + m.food.frecency) }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
}

/**
 * Score a lookup result against a query.
 *
 * Deliberately the same rules as the USDA Edge Function's scoreAgainst — head
 * noun dominant, coverage as a multiplier, brand matches worth less than name
 * matches, padding penalised. USDA and Open Food Facts results are merged into
 * one list, so they have to be ordered by one yardstick; scoring both here is
 * what makes that list coherent rather than two sorted lists stapled together.
 */
export function scoreDraft(terms, draft) {
  const name = (draft.name ?? '').toLowerCase();
  const brand = (draft.brand ?? '').toLowerCase();

  const words = name.split(/[^a-z0-9%.]+/).filter(Boolean);
  const head = words[0] ?? '';
  const tail = words[words.length - 1] ?? '';

  // Whole words, not substrings: "myprotein".includes("protein") is true, which
  // classified "protein" as a brand word on a product called "Impact Whey
  // Protein".
  const brandWords = brand.split(/[^a-z0-9%.]+/).filter(Boolean);
  const isBrandTerm = (t) => brandWords.some((w) => w.startsWith(t));

  let inName = 0;
  let inBrand = 0;
  for (const term of terms) {
    if (isBrandTerm(term)) inBrand += 1;
    else if (name.includes(term)) inName += 1;
  }

  const matched = inName + inBrand;
  if (!matched) return 0;

  let score = inName * 12 + inBrand * 5;

  // A branded name is natural English and ends on its head noun; USDA's own
  // descriptions invert it. Only branded rows get the tail checked.
  const heads = brand ? [head, tail] : [head];
  const headable = terms.filter((t) => !isBrandTerm(t));
  if (headable.some((t) => heads.some((h) => h && (h.startsWith(t) || (t.length > 3 && t.startsWith(h)))))) {
    score += 45;
  }

  // Scaled by how much of the match was in the name. On a brand-only match the
  // other words are the product's own name, not padding — flat, it scored a
  // brand search at zero.
  const padding = Math.min(Math.max(words.length - matched, 0), 14) * 2;
  score -= padding * (inName / matched);

  return Math.max(score, 0) * (matched / terms.length) ** 1.5;
}

/** Does this food already cover what a lookup returned? */
export function matchesDraft(food, draft) {
  if (draft.barcode && food.barcode && String(food.barcode) === String(draft.barcode)) return true;

  const norm = (s) => (s ?? '').trim().toLowerCase();
  return norm(food.name) === norm(draft.name) && norm(food.brand) === norm(draft.brand);
}

/**
 * Merge results from more than one source into one ranked list.
 *
 * The same product often exists in both USDA and Open Food Facts — the same
 * barcode, or the same name and brand — and showing it twice makes the list
 * look broken. Earlier sources win a collision, so pass the better-trusted one
 * first.
 */
export function mergeDrafts(groups, term) {
  const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const seen = [];

  for (const group of groups) {
    for (const result of group) {
      if (seen.some((kept) => matchesDraft(kept.draft, result.draft))) continue;
      seen.push(result);
    }
  }

  return seen
    .map((r) => ({ ...r, score: scoreDraft(terms, r.draft) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
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

/**
 * A saved meal: several foods logged together under one name.
 *
 * Items reference food_id rather than snapshotting macros, unlike the log
 * itself. That is deliberate and the opposite trade: a meal is a *recipe you
 * intend to repeat*, so correcting a food's macros should correct every future
 * logging of the meal. The snapshot still happens — at log time, in logFood —
 * so history stays frozen either way.
 *
 * The name is carried alongside food_id purely so a meal still reads correctly
 * if the food behind it is removed.
 */
export async function saveCombo({ id, name, items }, ownerEmail) {
  const row = await local.save('meal_combos', {
    ...(id ? { id } : {}),
    name: name.trim(),
    items: items.map((i) => ({
      food_id: i.food_id,
      name: i.name ?? null,
      quantity: Number(i.quantity),
      unit: i.unit,
    })),
  }, ownerEmail);

  sync.nudge();
  return row;
}

export async function deleteCombo(id) {
  const row = await local.remove('meal_combos', id);
  sync.nudge();
  return row;
}

/** Yours, still alive, newest first. */
export function ownedCombos(combos, ownerEmail) {
  return combos
    .filter((c) => c.owner_email === ownerEmail && !c.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What a meal adds up to right now.
 *
 * Computed rather than stored, so editing an ingredient's macros is reflected
 * without having to rewrite every meal that uses it.
 */
export function comboTotals(combo, foodsById) {
  const totals = emptyTotals();

  for (const item of combo.items ?? []) {
    const food = foodsById.get(item.food_id);
    if (!food) continue;
    const scaled = scaleMacros(food, item.quantity);
    for (const m of MACROS) totals[m] += Number(scaled[m]) || 0;
  }
  for (const m of MACROS) totals[m] = round(totals[m], 1);
  return totals;
}

/** Meals matching what you typed, best match first. */
export function searchCombos(combos, term) {
  const q = term.trim().toLowerCase();
  if (!q) return combos;

  return combos
    .map((c) => ({ combo: c, weight: matchWeight({ name: c.name }, q) }))
    .filter((m) => m.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.combo.name.localeCompare(b.combo.name))
    .map((m) => m.combo);
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

/** Soft delete. Logged entries keep their own macro snapshot, so history holds. */
export async function deleteFood(id) {
  const row = await local.remove('foods', id);
  sync.nudge();
  return row;
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
