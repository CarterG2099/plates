/**
 * grocery.js — Sunday meal prep: one or two recipes cooked in a batch big
 * enough for the week, the shopping list they make, the link that puts that
 * list in a Walmart cart, and the portions left as the week goes.
 *
 * One plan for the household. The three tables are read and written the way the
 * logs are read — by the owner and whoever they share with — so either of you
 * can tick things off the same list.
 *
 * The week is counted in portions, not days: dinners (and sometimes lunches)
 * times the people eating. The plan-week function suggests the recipes as an
 * unsaved draft; only taking it to the shopping list writes anything. After that the
 * list and the usuals are local-first like everything else.
 *
 * Walmart has no cart API. Its add-to-cart link takes item numbers, so each
 * ingredient is mapped once to a product you paste a link for (a "usual"), and
 * the button builds the link from those.
 */

import { supabase } from './supabase.js';
import * as local from './local.js';
import * as sync from './sync.js';
import { toDateOnly, logFood } from './food.js';

/** A week of Sunday prep: five dinners each, no lunches, until changed. */
export const DEFAULT_PREP = { dinners: 5, lunches: 0 };

/** Batches cooked on a Sunday: one or two recipes. */
export const MAX_BATCHES = 2;

/**
 * Walmart's add-to-cart link. Not documented by Walmart — it came from a
 * third-party project and was checked by hand on 2026-11-05, in Safari and the
 * iOS app: `items=<id>|<qty>,<id>`, and an item it can't find is dropped while
 * the rest still land. One constant so a change on their side is one line here.
 */
export const WALMART_CART_URL = 'https://www.walmart.com/sc/cart/addToCart';

/**
 * The item number from a Walmart product link — the digits after the slug in
 * walmart.com/ip/<slug>/<id>, ignoring the query string — or a bare number.
 * null for anything else, so a pasted search page can't become a cart entry.
 */
export function walmartItemId(text) {
  const s = String(text ?? '').trim();
  if (/^\d{4,}$/.test(s)) return s;
  const m = s.match(/walmart\.com\/ip\/(?:[^/?#\s]+\/)?(\d{4,})(?=[/?#\s]|$)/i);
  return m ? m[1] : null;
}

// ---- amounts ------------------------------------------------------------------

/** Grams and millilitres per unit. Units outside these only add to themselves. */
const MASS = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOLUME = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, 'fl oz': 29.5735 };

function family(unit) {
  if (unit in MASS) return 'mass';
  if (unit in VOLUME) return 'volume';
  return unit || 'each';
}

const perBase = (unit) => MASS[unit] ?? VOLUME[unit] ?? 1;

/** How many servings a recipe makes: servings_count, else the first number in its servings text. */
export function recipeYield(recipe) {
  const count = Number(recipe?.servings_count);
  if (count > 0) return count;
  const m = String(recipe?.servings ?? '').match(/\d+(\.\d+)?/);
  return m && Number(m[0]) > 0 ? Number(m[0]) : null;
}

/**
 * How much of a recipe to cook for this many servings. A recipe that doesn't
 * say what it makes is cooked whole: there's nothing to scale against.
 */
export function scaleFor(servings, recipe) {
  const makes = recipeYield(recipe);
  return makes ? servings / makes : 1;
}

/** Round up, never down: a list that is short by a quarter cup is short. */
export function roundUp(qty) {
  if (qty == null) return null;
  return qty >= 10 ? Math.ceil(qty) : Math.ceil(qty * 4 - 1e-9) / 4;
}

const FRACTIONS = { 0.25: '¼', 0.5: '½', 0.75: '¾' };

/** "1½ cup", "3", "200 g" — or '' for an amount nobody wrote down. */
export function amountLabel(qty, unit) {
  if (qty == null) return '';
  const whole = Math.floor(qty);
  const part = FRACTIONS[Math.round((qty - whole) * 100) / 100] ?? '';
  const number = part ? `${whole || ''}${part}` : String(Math.round(qty * 100) / 100);
  return unit && unit !== 'each' ? `${number} ${unit}` : number;
}

/**
 * One shopping list from the week's meals.
 *
 * Each meal's ingredients are scaled by its servings over what the recipe
 * makes, then added up per ingredient. Amounts only add within one kind of
 * measure — cups to tablespoons, ounces to pounds — and are shown in the unit
 * that ingredient first appeared in. A cup of chicken and a pound of it stay
 * two lines, because nothing here knows what a cup of chicken weighs.
 *
 * `ingredients` is the plan-week function's answer: recipe id → [{key, name,
 * qty, unit, staple}].
 */
export function combine(meals, ingredients, recipesById) {
  const lines = new Map();

  for (const meal of meals) {
    const recipe = recipesById.get(meal.recipe_id);
    const scale = scaleFor(meal.servings, recipe);
    for (const ing of ingredients[meal.recipe_id] ?? []) {
      const kind = family(ing.unit);
      const id = `${ing.key}|${kind}`;
      if (!lines.has(id)) {
        lines.set(id, {
          key: ing.key, label: ing.name, unit: ing.unit ?? null, base: null,
          staple: Boolean(ing.staple), recipes: [],
        });
      }
      const line = lines.get(id);
      if (ing.qty != null) line.base = (line.base ?? 0) + ing.qty * scale * perBase(ing.unit);
      line.staple = line.staple && Boolean(ing.staple);
      const title = recipe?.title ?? '';
      if (title && !line.recipes.includes(title)) line.recipes.push(title);
    }
  }

  return [...lines.values()]
    .map(({ base, ...line }) => ({
      ...line,
      qty: base == null ? null : roundUp(base / perBase(line.unit)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---- the cart -----------------------------------------------------------------

/** The household's mapping for an ingredient: the newest, if two of you made one. */
export function usualFor(key, usuals) {
  let best = null;
  for (const u of usuals) {
    if (u.deleted_at || u.ingredient_key !== key) continue;
    if (!best || u.updated_at > best.updated_at) best = u;
  }
  return best;
}

/**
 * The add-to-cart link for what's still to buy.
 *
 * Only items mapped to a numeric Walmart id go in; the rest come back in
 * `skipped` so the button can name them. A product two ingredients share is
 * one entry with their quantities added. A quantity of 1 is the bare id.
 */
export function cartLink(items, usuals) {
  const quantities = new Map();
  const skipped = [];

  for (const item of items) {
    if (item.have || item.deleted_at) continue;
    const usual = usualFor(item.ingredient_key, usuals);
    const id = usual?.walmart_item_id;
    if (!id || !/^\d+$/.test(id)) { skipped.push(item.label); continue; }
    const qty = Math.max(1, Math.ceil(Number(usual.default_qty) || 1));
    quantities.set(id, (quantities.get(id) ?? 0) + qty);
  }

  const parts = [...quantities].map(([id, qty]) => (qty === 1 ? id : `${id}|${qty}`));
  return {
    url: parts.length ? `${WALMART_CART_URL}?items=${parts.join(',')}` : null,
    count: parts.length,
    skipped,
  };
}

// ---- the plan -----------------------------------------------------------------

/** Portions to cook: every dinner and lunch, for everyone eating. */
export function portionCount({ dinners, lunches, people }) {
  return Math.max(0, (Number(dinners) || 0) + (Number(lunches) || 0)) * Math.max(1, Number(people) || 1);
}

/** Portions shared as evenly as they go, the odd ones to the first batches. */
export function splitPortions(total, batches) {
  if (batches < 1) return [];
  const base = Math.floor(total / batches);
  return Array.from({ length: batches }, (_, i) => base + (i < total - base * batches ? 1 : 0));
}

const RECIPE_MACROS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg'];

/**
 * The batches for these picks: each recipe, its share of the portions, and
 * its per-serving macros as they stand now — a portion is one of the recipe's
 * servings, and the plan keeps its own copy so an edited recipe can't change
 * what a portion logged on Thursday weighed in at.
 */
export function batchesFor(picks, total, recipesById) {
  const shares = splitPortions(total, picks.length);
  return picks.map((pick, i) => {
    const recipe = recipesById.get(pick.recipe_id) ?? {};
    const batch = {
      recipe_id: pick.recipe_id,
      title: recipe.title ?? pick.title ?? 'Recipe',
      portions: shares[i],
      makes: recipeYield(recipe),
      reason: pick.reason ?? '',
    };
    for (const m of RECIPE_MACROS) {
      const v = recipe[m];
      batch[m] = v == null || v === '' ? null : Number(v);
    }
    return batch;
  });
}

/** "Makes 4 → cook ×1¼", or what to do when the recipe doesn't say what it makes. */
export function scaleLine(batch) {
  if (!batch.makes) return `Servings not listed · cook enough for ${batch.portions}`;
  const scale = batch.portions / batch.makes;
  const quarter = Math.round(scale * 4) / 4;
  const shown = Math.abs(quarter - scale) < 0.01 && quarter > 0
    ? amountLabel(quarter, null)
    : String(Math.round(scale * 100) / 100);
  return `Makes ${batch.makes} → cook ×${shown}`;
}

/** The plan on screen: the most recently accepted one either of you can see. */
export function currentPlan(plans) {
  let best = null;
  for (const p of plans) {
    if (p.deleted_at) continue;
    if (!best || p.accepted_at > best.accepted_at) best = p;
  }
  return best;
}

/** The Monday of the week a date falls in, as a date-only string. */
export function weekOf(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateOnly(d);
}

/**
 * How much of each batch is left. A portion eaten is a log entry for that
 * recipe since the plan was made — by either of you, which is the point of a
 * shared prep — counted by its quantity in servings.
 */
export function portionsLeft(plan, log) {
  if (!plan) return [];
  return plan.meals.map((batch) => {
    const byOwner = {};
    let eaten = 0;
    for (const e of log) {
      if (e.deleted_at || e.is_planned || e.recipe_id !== batch.recipe_id) continue;
      if (e.logged_at < plan.accepted_at) continue;
      const n = Number(e.quantity) || 1;
      eaten += n;
      byOwner[e.owner_email] = (byOwner[e.owner_email] ?? 0) + n;
    }
    return { ...batch, eaten, left: Math.max(0, batch.portions - eaten), byOwner };
  });
}

async function ask(body) {
  if (!navigator.onLine) throw new Error('Suggesting recipes needs a connection.');
  const { data, error } = await supabase.functions.invoke('plan-week', { body });
  // The function answers a readable failure as 200 with `error`, as read-food-photo does.
  if (error) throw new Error(error.message ?? String(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

/** Recipes to batch-cook: [{recipe_id, reason}]. Nothing is saved. */
export async function suggestRecipes({ batches, portions, exclude = [] }) {
  const data = await ask({ mode: 'plan', batches, portions, exclude });
  return data.picks ?? [];
}

/** Each recipe's ingredients as shopping entries, by recipe id. */
export async function readIngredients(recipeIds) {
  const data = await ask({ mode: 'ingredients', recipe_ids: recipeIds });
  return data.recipes ?? {};
}

/**
 * Save the week's batches and their list. Pantry staples start ticked as
 * already had — salt and oil on every week's list would bury what actually
 * needs buying.
 */
export async function acceptPlan({ batches, lines, email, now = new Date() }) {
  const plan = await local.save('meal_plans', {
    week_of: weekOf(now),
    meals: batches,
    accepted_at: now.toISOString(),
  }, email);

  for (const line of lines) {
    await local.save('shopping_items', {
      plan_id: plan.id,
      ingredient_key: line.key,
      label: line.label,
      qty: line.qty,
      unit: line.unit,
      recipes: line.recipes,
      have: line.staple,
    }, email);
  }
  sync.nudge();
  return plan;
}

/**
 * One prepped portion, logged now: the recipe's macros as the plan copied
 * them, one serving, stamped with the recipe so the count goes down.
 */
export function logPortion(batch, email) {
  const portion = { name: batch.title, brand: 'Meal prep', recipe_id: batch.recipe_id, serving_qty: 1, serving_unit: 'serving' };
  for (const m of RECIPE_MACROS) portion[m] = batch[m] ?? null;
  return logFood({ food: portion, quantity: 1, unit: 'serving', ownerEmail: email, date: new Date() });
}

/** Tick or untick. The row keeps its owner when the other of you does it. */
export async function setHave(item, have) {
  const row = await local.save('shopping_items', { ...item, have }, item.owner_email);
  sync.nudge();
  return row;
}

/** Map an ingredient to a Walmart product, or change the mapping. */
export async function saveUsual({ id, key, link, label, qty }, email, existing = null) {
  const itemId = walmartItemId(link);
  if (!itemId) throw new Error('That isn\'t a Walmart product link. It should look like walmart.com/ip/…/12345678.');
  const count = Math.round(Number(qty));
  if (!(count >= 1 && count <= 99)) throw new Error('Quantity must be 1 to 99.');

  const row = await local.save('walmart_items', {
    ...(existing ?? {}),
    ...(id ? { id } : {}),
    ingredient_key: key,
    walmart_item_id: itemId,
    label: String(label ?? '').trim(),
    default_qty: count,
  }, email);
  sync.nudge();
  return row;
}

export async function removeUsual(id) {
  const row = await local.remove('walmart_items', id);
  sync.nudge();
  return row;
}
