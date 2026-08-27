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
 * When to stamp an entry: the day you are logging to, at the time you logged it.
 *
 * Used to be the nominal hour of a guessed meal, which put every entry added to
 * another day at the same instant and left the day in no particular order. The
 * clock is the honest answer and it sorts: things added later come later.
 */
export function timestampFor(date, now = new Date()) {
  if (dayBounds(date).start.getTime() === dayBounds(now).start.getTime()) return now;

  const at = new Date(date);
  at.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
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

/**
 * Lowercase, with accents folded off.
 *
 * Without this, "creme" cannot find "Crème Brûlée" and "jalapeno" cannot find
 * "Jalapeño" — the letters differ, so every match test fails. Nobody types the
 * diacritic when searching, and Open Food Facts is full of names that carry it.
 */
function fold(text) {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** One phrase against one food. */
function phraseWeight(food, q) {
  const name = fold(food.name);
  if (name === q) return WEIGHT.exact;
  if (name.startsWith(q)) return WEIGHT.prefix;
  if (name.split(/[\s\-(,/]+/).some((w) => w.startsWith(q))) return WEIGHT.word;
  if (name.includes(q)) return WEIGHT.substring;

  return fold(food.brand).includes(q) ? WEIGHT.brand : 0;
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
  const q = fold(term.trim());
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
  const name = fold(draft.name);
  const brand = fold(draft.brand);

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

  score = Math.max(score, 0) * (matched / terms.length) ** 1.5;

  // Open Food Facts is a global database, so a search for "myprotein impact
  // whey" surfaced the Cyrillic listings above the English ones. They are real
  // products, but not the packet in your hand — the name won't match the label
  // and the numbers came off a different market's packaging. Demoted, not
  // dropped, so they still appear when nothing else does.
  return isMostlyLatin(draft.name) ? score : score * 0.3;
}

/**
 * Accented Latin counts as Latin: "Héritage", "Müsli" and "Crème" are all names
 * you might read off a label here. Cyrillic, Greek, Arabic and CJK are not.
 *
 * A proportion test is too lenient — "Протеин MyProtein Impact Whey Protein" is
 * 79% Latin and would survive it, and that listing is precisely the problem.
 * A few non-Latin letters are enough to mark a listing as another market's.
 */
function isMostlyLatin(name) {
  const letters = (name ?? '').replace(/[^\p{Letter}]/gu, '');
  if (!letters) return true;

  const foreign = letters.length - (letters.match(/\p{Script=Latin}/gu) ?? []).length;
  return foreign < 3;
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
  const terms = fold(term.trim()).split(/\s+/).filter(Boolean);
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
    // null must stay null. Number(null) is 0 and passes isFinite, so a food
    // whose protein is genuinely unknown was logging as zero protein — a
    // silent understatement rather than a visible gap.
    const raw = food[m];
    if (raw === null || raw === undefined || raw === '') { out[m] = null; continue; }

    const value = Number(raw);
    out[m] = Number.isFinite(value) ? round(value * factor, 1) : null;
  }
  return out;
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Rescale an already-logged entry's macros to a different amount.
 *
 * The entry's own snapshot is the basis, never the food it came from: fixing
 * an amount you mis-tapped must not quietly pull in a food that has been
 * edited or rescanned since. The one case the snapshot cannot serve is an
 * amount of zero, which leaves no ratio to scale by — then the food is the
 * only basis left, and if it is gone too the macros go with it.
 */
export function scaleEntry(entry, quantity, food) {
  const previous = Number(entry.quantity);
  if (!(previous > 0)) return food ? scaleMacros(food, quantity) : emptyTotals();

  const factor = (Number(quantity) || 0) / previous;
  const out = {};
  for (const m of MACROS) {
    // Null stays null. A macro nobody recorded is not a macro that is zero, and
    // changing an amount is no occasion to decide otherwise — note that
    // Number(null) is 0 and finite, so this cannot be left to Number.isFinite.
    const value = entry[m] == null ? NaN : Number(entry[m]);
    out[m] = Number.isFinite(value) ? round(value * factor, 1) : null;
  }
  return out;
}

/**
 * How much, in words.
 *
 * `serving` is the only unit that reads as a word rather than a symbol, so it
 * is the only one that takes a space and a plural. `170g` is right; `1serving`
 * never was.
 */
/**
 * What a draft's macros are measured against, in words.
 *
 * `basis` off a lookup is sometimes a measure ("55 g", "3/4 cup (170 g)"),
 * sometimes the phrase "one serving", and sometimes "per 100 g" — so it cannot
 * just be pasted after "one serving =", which is how a per-100g food came to
 * announce itself as "one serving = per 100 g".
 *
 * There is no serving at all in the per-100g case: that basis is the fallback
 * for products whose label never published one. Saying so plainly beats
 * inventing a serving that does not exist.
 */
export function basisLabel(draft) {
  if (!draft) return '';

  const unit = (draft.serving_unit ?? '').trim();
  if (unit !== 'serving') {
    const qty = Number(draft.serving_qty) || 1;
    return `per ${qty} ${unit}`.trimEnd();
  }

  const measure = (draft.basis ?? '').trim();
  return measure && measure !== 'one serving' ? `one serving = ${measure}` : 'per serving';
}

// ---- ways of saying how much ------------------------------------------------
//
// Four lenses onto one number. Whichever you type in, what gets stored is a
// quantity in the food's own `serving_unit` — the basis scaleMacros divides by —
// so the entry does not care which one you used and history stays comparable.

const G_PER_OZ = 28.349523125;
const ML_PER_FL_OZ = 29.5735295625;

const IMPERIAL_OF = { g: 'oz', ml: 'fl oz' };

/** Fixed, so the slider means the same thing on every food. */
export const LENS_MAX = { serving: 10, measure: 500, imperial: 20, kcal: 1500 };

/** What one drag-step moves, so a slider lands on a number worth reading. */
export const LENS_STEP = { serving: 0.25, measure: 5, imperial: 0.25, kcal: 10 };

const per = (food) => Number(food?.serving_qty) || 1;

/** What one serving physically measures, and in what — null when unrecorded. */
function measure(food) {
  const size = Number(food?.serving_size) || null;
  const unit = (food?.serving_size_unit ?? '').trim().toLowerCase();
  return size && IMPERIAL_OF[unit] ? { size, unit } : null;
}

/**
 * Which lenses this food can actually be seen through.
 *
 * A food logged in grams already is its own measure, so it needs no serving
 * size to offer one; a food logged in servings needs one before grams mean
 * anything. Calories need a calorie figure that is not zero, or the conversion
 * divides by nothing.
 */
export function lensesFor(food) {
  if (!food) return [];

  const unit = (food.serving_unit ?? '').trim().toLowerCase();
  const own = IMPERIAL_OF[unit] ? { size: 1, unit } : null;   // already a measure
  const m = own ?? measure(food);

  const out = [];
  if (unit === 'serving') out.push({ key: 'serving', label: 'Servings', unit: 'serving' });
  if (m) {
    out.push({ key: 'measure', label: m.unit, unit: m.unit });
    out.push({ key: 'imperial', label: IMPERIAL_OF[m.unit], unit: IMPERIAL_OF[m.unit] });
  }
  if (unit !== 'serving' && !m) out.push({ key: 'measure', label: unit || 'amount', unit: unit || '' });
  if (Number(food.calories) > 0) out.push({ key: 'kcal', label: 'kcal', unit: 'kcal' });

  return out;
}

/** How many of the food's own units one unit of `lens` is worth. */
function factorFor(food, lens) {
  const unit = (food?.serving_unit ?? '').trim().toLowerCase();
  const m = IMPERIAL_OF[unit] ? { size: 1, unit } : measure(food);

  switch (lens) {
    case 'serving':  return unit === 'serving' ? 1 : (m ? m.size : null);
    case 'measure':  return unit === 'serving' ? (m ? 1 / m.size : null) : 1;
    case 'imperial': {
      if (!m) return null;
      const g = m.unit === 'ml' ? ML_PER_FL_OZ : G_PER_OZ;
      return unit === 'serving' ? g / m.size : g;
    }
    default: return null;
  }
}

/**
 * Display rounding that keeps small amounts intact.
 *
 * Two decimals is right for the amounts anyone eats and wrong at the bottom of
 * the scale: half a gram is 0.0176 oz, and 0.02 is a different amount by a
 * seventh. Below a tenth, two more places.
 */
function show(n, dp) {
  if (!Number.isFinite(n)) return 0;
  return round(n, n !== 0 && Math.abs(n) < 0.1 ? dp + 2 : dp);
}

/** The amount to show, given a stored quantity. */
export function fromQuantity(food, quantity, lens) {
  const q = Number(quantity) || 0;

  if (lens === 'kcal') {
    const kcal = Number(food?.calories) || 0;
    return round(q * (kcal / per(food)), 0);
  }

  const factor = factorFor(food, lens);
  if (!factor) return q;
  return show(q / factor, lens === 'measure' ? 1 : 2);
}

/** And back again — this is the number that gets stored. */
export function toQuantity(food, amount, lens) {
  const a = Number(amount) || 0;

  if (lens === 'kcal') {
    const kcal = Number(food?.calories) || 0;
    if (!kcal) return 0;
    return round((a * per(food)) / kcal, 2);
  }

  const factor = factorFor(food, lens);
  if (!factor) return a;
  return round(a * factor, 2);
}

export function amountLabel(quantity, unit) {
  const n = Number(quantity) || 0;
  if (unit !== 'serving') return `${n}${unit}`;
  return `${n} ${n === 1 ? 'serving' : 'servings'}`;
}

// ---- writes ----------------------------------------------------------------

/**
 * Log a food. Macros are snapshotted onto the entry rather than referenced, so
 * editing or deleting the food later cannot rewrite what you already ate.
 */
export async function logFood({ food, quantity, unit, ownerEmail, date }) {
  const entry = await local.save('food_log', {
    logged_at: timestampFor(date ?? new Date()).toISOString(),
    // Left null rather than guessed. The column and everything already in it
    // stay put, so this is reversible; what stops is inventing a meal from the
    // clock and being wrong about it every time you log to another day.
    meal_slot: null,
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
      food_id: i.food_id ?? null,
      name: i.name ?? null,
      quantity: Number(i.quantity),
      unit: i.unit,
      // Snapshot items carry their own macros because they point at nothing: a
      // meal built from a photo is a set of estimates, not a set of foods.
      ...(i.food_id ? {} : Object.fromEntries(MACROS.map((m) => [m, i[m] ?? null]))),
    })),
  }, ownerEmail);

  sync.nudge();
  return row;
}

/**
 * The food an item refers to, real or snapshotted.
 *
 * An item either points at one of your foods, or carries its own macros. The
 * second kind exists so a meal can be built from a photo without inventing
 * foods for a plate you ate once.
 */
function itemFood(item, foodsById) {
  const real = item.food_id ? foodsById.get(item.food_id) : null;
  if (real) return real;
  if (item.calories == null) return null;

  return {
    id: null,
    name: item.name ?? 'Item',
    brand: null,
    serving_qty: 1,
    serving_unit: item.unit ?? 'serving',
    ...Object.fromEntries(MACROS.map((m) => [m, item[m] ?? null])),
  };
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
    const food = itemFood(item, foodsById);
    if (!food) continue;
    const scaled = scaleMacros(food, item.quantity);
    for (const m of MACROS) totals[m] += Number(scaled[m]) || 0;
  }
  for (const m of MACROS) totals[m] = round(totals[m], 1);
  return totals;
}

/** Meals matching what you typed, best match first. */
export function searchCombos(combos, term) {
  const q = fold(term.trim());
  if (!q) return combos;

  return combos
    .map((c) => ({ combo: c, weight: matchWeight({ name: c.name }, q) }))
    .filter((m) => m.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.combo.name.localeCompare(b.combo.name))
    .map((m) => m.combo);
}

/** Log every item of a saved combo in one go. */
export async function logCombo({ combo, foodsById, ownerEmail, date }) {
  const logged = [];

  for (const item of combo.items ?? []) {
    const food = itemFood(item, foodsById);
    if (!food) continue;
    logged.push(await logFood({
      food,
      quantity: item.quantity,
      unit: item.unit,
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
    logged_at: timestampFor(date).toISOString(),
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

/**
 * Change how much of an entry you ate, after the fact.
 *
 * The unit never changes here. Grams are offered as a lens over servings in
 * the UI, but what gets written back is the entry's own unit — a row that was
 * logged in servings goes on reading in servings.
 */
export async function updateEntry({ entry, quantity, food }) {
  const row = await local.save('food_log', {
    ...entry,
    quantity: Number(quantity),
    ...scaleEntry(entry, quantity, food),
  });

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
