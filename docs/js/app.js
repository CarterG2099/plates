/**
 * app.js — Alpine stores and screen components.
 *
 * Screens read from `$store.data`, which is a snapshot of IndexedDB. Writes go
 * through food.js, refresh the snapshot immediately, and let sync.js catch up
 * with the server whenever it can. Nothing on screen ever waits for a network
 * round trip.
 */

import Alpine from './vendor/alpine.esm.js';
import { supabase, signIn, signOut, loadMembership, describeError } from './supabase.js';
import * as local from './local.js';
import * as sync from './sync.js';
import * as food from './food.js';
import { lookupBarcode } from './lookup.js';
import * as scanner from './scanner.js';
import * as workout from './workout.js';
import { importHevy } from './import-hevy.js';
import { muscleMap } from './muscle-map.js';
import * as stats from './stats.js';

/**
 * Drag a sheet down to dismiss it.
 *
 * The grabber has been implying this since the sheets were built. Only engages
 * when the sheet is scrolled to the top, so a long list still scrolls normally —
 * pulling down mid-list should not throw the sheet away.
 */
Alpine.magic('swipe', () => (sheet, close) => {
  if (!sheet || sheet.dataset.swipe) return;
  sheet.dataset.swipe = '1';

  const THRESHOLD = 90;
  let startY = 0;
  let delta = 0;
  let dragging = false;

  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    delta = 0;
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    delta = e.touches[0].clientY - startY;
    // Downward only; an upward drag is a scroll.
    if (delta <= 0) { delta = 0; sheet.style.transform = ''; return; }
    sheet.style.transform = `translateY(${delta}px)`;
  }, { passive: true });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = 'transform 180ms ease';

    if (delta > THRESHOLD) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(close, 160);
    } else {
      sheet.style.transform = '';
    }
  };

  sheet.addEventListener('touchend', release);
  sheet.addEventListener('touchcancel', release);
});

/**
 * Swipe a row left to reveal its action.
 *
 * Direction is decided on the first move and then locked: if the finger goes
 * more vertical than horizontal it is a scroll, and the row must not creep
 * sideways while the list moves under it.
 */
Alpine.magic('swipeRow', () => (wrap) => {
  if (!wrap || wrap.dataset.swipeRow) return;
  wrap.dataset.swipeRow = '1';

  const slide = wrap.querySelector('.row');
  if (!slide) return;

  const WIDTH = 96;             // matches .row-remove
  const THRESHOLD = 40;

  let startX = 0, startY = 0, dx = 0;
  let dragging = false, locked = false;

  const isOpen = () => wrap.classList.contains('is-open');

  slide.addEventListener('touchstart', (e) => {
    // One row open at a time; two revealed actions is a mis-tap waiting.
    for (const other of document.querySelectorAll('.row-swipe.is-open')) {
      if (other !== wrap) other.classList.remove('is-open');
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = isOpen() ? -WIDTH : 0;
    dragging = true;
    locked = false;
    slide.style.transition = 'none';
  }, { passive: true });

  slide.addEventListener('touchmove', (e) => {
    if (!dragging) return;

    const x = e.touches[0].clientX - startX;
    const y = e.touches[0].clientY - startY;

    if (!locked) {
      if (Math.abs(y) > Math.abs(x)) { dragging = false; slide.style.transition = ''; return; }
      if (Math.abs(x) < 6) return;                 // too small to call yet
      locked = true;
    }

    dx = Math.min(0, Math.max(-WIDTH, (isOpen() ? -WIDTH : 0) + x));
    slide.style.transform = `translateX(${dx}px)`;
  }, { passive: true });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    slide.style.transition = '';
    slide.style.transform = '';        // the class drives it from here
    wrap.classList.toggle('is-open', dx < -THRESHOLD);
  };

  slide.addEventListener('touchend', release);
  slide.addEventListener('touchcancel', release);

  // While open, a tap closes rather than logging. Capture phase, so it lands
  // before the row's own click handlers.
  slide.addEventListener('click', (e) => {
    if (!isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove('is-open');
  }, true);
});

// ---- auth ------------------------------------------------------------------

/**
 * Membership, cached where it can be read synchronously.
 *
 * Deciding whether to show the app required a Supabase round trip, so a
 * local-first app sat on a spinner waiting for the network to confirm something
 * it already knew. The cache paints immediately; the real check runs behind it
 * and corrects if access was revoked.
 */
const MEMBERSHIP_KEY = 'plates:membership';

const readMembership = () => {
  try { return JSON.parse(localStorage.getItem(MEMBERSHIP_KEY) || 'null'); }
  catch { return null; }
};

const writeMembership = (value) => {
  try {
    if (value) localStorage.setItem(MEMBERSHIP_KEY, JSON.stringify(value));
    else localStorage.removeItem(MEMBERSHIP_KEY);
  } catch { /* private mode; we just lose the fast path */ }
};

Alpine.store('auth', {
  ready: false,
  session: null,
  isMember: false,
  isAdmin: false,
  members: [],
  error: '',

  get email() { return this.session?.user?.email ?? ''; },

  get displayName() {
    const me = this.members.find((m) => m.email?.toLowerCase() === this.email.toLowerCase());
    return me?.display_name || this.email;
  },

  async init() {
    const { data } = await supabase.auth.getSession();
    const session = data.session ?? null;
    this.session = session;

    const cached = readMembership();
    const trusted = session && cached && cached.email === session.user?.email;

    if (trusted) {
      // Paint from what we already know. Nothing here touches the network.
      this.members = cached.members ?? [];
      this.isMember = true;
      this.isAdmin = Boolean(cached.isAdmin);
      this.ready = true;

      await Alpine.store('data').refreshCore();
      sync.start();
      Alpine.store('data').refreshTraining();
      this.verify();                       // deliberately not awaited
    } else {
      await this.apply(session);
      this.ready = true;
    }

    supabase.auth.onAuthStateChange((_event, next) => this.apply(next ?? null));
  },

  /** Confirm the cached membership against the server, after the app is usable. */
  async verify() {
    const { isMember, members, error } = await loadMembership();
    if (error) return;                     // offline, or the schema is unreachable

    if (!isMember) {
      writeMembership(null);
      this.isMember = false;
      this.members = [];
      return;
    }
    this.members = members;
    writeMembership({ email: this.email, members, isAdmin: this.isAdmin });
  },

  async apply(session) {
    this.session = session;

    if (!session) {
      this.isMember = false;
      this.isAdmin = false;
      this.members = [];
      sync.stop();
      return;
    }

    const { isMember, members, error } = await loadMembership();

    if (error) {
      this.error = describeError(error);
      this.isMember = false;
      return;
    }

    this.error = '';
    this.members = members;
    this.isMember = isMember;
    this.isAdmin = members.some(
      (m) => m.email?.toLowerCase() === this.email.toLowerCase() && m.is_admin,
    );

    if (isMember) {
      writeMembership({ email: this.email, members, isAdmin: this.isAdmin });

      // Paint Today, then fill in training in the background.
      await Alpine.store('data').refreshCore();
      sync.start();
      Alpine.store('data').refreshTraining();
    } else {
      writeMembership(null);
    }
  },

  signIn() { return signIn().catch((e) => { this.error = e.message; }); },

  async signOut() {
    writeMembership(null);
    await local.wipe();
    await signOut();
  },
});

// ---- sync status -----------------------------------------------------------

Alpine.store('sync', {
  online: navigator.onLine,
  status: 'idle',
  pending: 0,
  lastSyncedAt: null,
  error: null,

  init() {
    sync.subscribe((s) => {
      const wasSyncing = this.status === 'syncing';
      Object.assign(this, s);
      // A completed pull may have brought in the other person's rows.
      if (wasSyncing && s.status === 'idle') Alpine.store('data').refresh();
    });
  },

  get label() {
    if (!this.online) return this.pending ? `Offline · ${this.pending} queued` : 'Offline';
    if (this.status === 'syncing') return 'Syncing…';
    if (this.status === 'error') return this.pending ? `Retrying · ${this.pending} queued` : 'Retrying…';
    if (this.pending) return `${this.pending} queued`;
    return 'Synced';
  },

  get dotClass() {
    if (!this.online) return 'dot dot-offline';
    if (this.status === 'error') return 'dot dot-error';
    if (this.pending || this.status === 'syncing') return 'dot dot-pending';
    return 'dot dot-synced';
  },
});

// ---- local snapshot --------------------------------------------------------

/**
 * Raw rows, deliberately OUTSIDE Alpine's reactive store.
 *
 * With two years of history this holds ~6,000 sets. Proxying them meant every
 * property read in a template went through a proxy trap, and every reactive tick
 * re-ran getters that scanned the whole log — a single Train render was doing
 * millions of row comparisons. Templates depend on `version` instead, which is a
 * single reactive integer.
 */
const raw = {
  goals: [], foods: [], log: [], combos: [], templates: [], weightLog: [],
  exercises: [], routines: [], routineExercises: [], sessions: [], sessionSets: [],
  index: workout.buildIndex([], [], ''),
  prior: new Map(),
};

/** Read raw data while still re-rendering when it changes. */
function snapshot() {
  Alpine.store('data').version;   // registers the dependency
  return raw;
}

Alpine.store('data', {
  ready: false,
  version: 0,
  goals: [],
  foods: [],
  log: [],
  combos: [],
  templates: [],
  weightLog: [],
  exercises: [],
  routines: [],
  routineExercises: [],
  sessions: [],
  sessionSets: [],

  /** What Today needs: small, and read first so the app paints immediately. */
  async refreshCore() {
    const [goals, foods, log, combos, templates, weightLog] = await Promise.all([
      local.all('goals'),
      local.all('foods'),
      local.all('food_log'),
      local.all('meal_combos'),
      local.all('day_templates'),
      local.all('weight_log'),
    ]);

    Object.assign(raw, { goals, foods, log, combos, templates, weightLog });
    this.ready = true;
    this.version++;
  },

  /**
   * The training tables, which are the big ones and which Today never reads.
   * With two years imported, session_sets alone is thousands of rows.
   */
  async refreshTraining() {
    const [exercises, routines, routineExercises, sessions, sessionSets] = await Promise.all([
      local.all('exercises'),
      local.all('routines'),
      local.all('routine_exercises'),
      local.all('sessions'),
      local.all('session_sets'),
    ]);

    Object.assign(raw, { exercises, routines, routineExercises, sessions, sessionSets });

    // Indexed once per refresh rather than per render.
    raw.index = workout.buildIndex(sessionSets, sessions, Alpine.store('auth').email);
    raw.prior = workout.priorForm(raw.index, null);
    this.version++;
  },

  async refresh() {
    await this.refreshCore();
    await this.refreshTraining();
  },
});

// ---- ui --------------------------------------------------------------------

Alpine.store('ui', {
  view: 'today',
  // The day being viewed and written to. Logging is always "to this date", which
  // is what makes meal prep work without a separate planning mode.
  viewDate: food.toDateOnly(new Date()),
  logOpen: window.matchMedia('(min-width: 900px)').matches,
  toast: '',
  _toastTimer: null,

  go(view) { this.view = view; },

  get date() { return food.fromDateOnly(this.viewDate); },
  get dayLabel() { return food.dayLabel(this.date); },
  get isToday() { return this.viewDate === food.toDateOnly(new Date()); },
  get isFuture() { return food.isFuture(this.date); },

  shiftDay(n) { this.viewDate = food.toDateOnly(food.addDays(this.date, n)); },
  goToday() { this.viewDate = food.toDateOnly(new Date()); },

  openLog() { this.logOpen = true; },
  closeLog() { this.logOpen = false; },

  get canScan() { return scanner.isSupported(); },

  /**
   * Straight to the camera from Today. The scanner lives inside the log panel's
   * component, so this opens the panel and raises a flag it watches for — one
   * tap from anywhere to a viewfinder.
   */
  scanRequested: false,
  startScan() {
    this.logOpen = true;
    this.scanRequested = true;
  },

  flash(message) {
    this.toast = message;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = ''; }, 1800);
  },
});

// ---- today -----------------------------------------------------------------

Alpine.data('todayPage', () => ({
  get email() { return Alpine.store('auth').email; },
  get date() { return Alpine.store('ui').date; },
  get data() { return snapshot(); },

  get goal() {
    return food.currentGoal(this.data.goals, this.email, this.date);
  },

  get entries() {
    return food.entriesForDay(this.data.log, this.email, this.date);
  },

  get totals() { return food.sumTotals(this.entries); },

  get meals() { return food.groupByMeal(this.entries); },

  get calorieTarget() { return Number(this.goal?.calorie_target) || null; },

  get remaining() {
    if (!this.calorieTarget) return null;
    return Math.round(this.calorieTarget - this.totals.calories);
  },

  /** Each macro's share of the calorie target, for the stacked bar. */
  segment(macro) {
    const perGram = macro === 'fat_g' ? 9 : 4;
    if (!this.calorieTarget) return 0;
    return Math.min(100, (this.totals[macro] * perGram / this.calorieTarget) * 100);
  },

  target(macro) {
    const key = { protein_g: 'protein_target_g', carbs_g: 'carbs_target_g', fat_g: 'fat_target_g' }[macro];
    return Number(this.goal?.[key]) || null;
  },

  percent(macro) {
    const t = this.target(macro);
    if (!t) return 0;
    return Math.min(100, (this.totals[macro] / t) * 100);
  },

  round(n) { return Math.round(Number(n) || 0); },

  mealLabel(slot) { return slot.charAt(0).toUpperCase() + slot.slice(1); },

  /** Plates on the bar: width is each macro's share of the calorie target. */
  get plates() {
    if (!this.calorieTarget) return [];
    return [
      { key: 'protein_g', colour: 'var(--color-protein)', per: 4 },
      { key: 'carbs_g',   colour: 'var(--color-carbs)',   per: 4 },
      { key: 'fat_g',     colour: 'var(--color-fat)',     per: 9 },
    ]
      .map((m) => ({ ...m, raw: (this.totals[m.key] * m.per / this.calorieTarget) * 100 }))
      .filter((m) => m.raw > 0.5)
      // Over target, the shares sum past 100% — scale them down together so the
      // bar stays full-width and the proportions between macros stay honest.
      .map((m, _, all) => {
        const total = all.reduce((sum, x) => sum + x.raw, 0);
        return { ...m, width: total > 100 ? (m.raw / total) * 100 : m.raw };
      });
  },

  get remainingInFood() {
    const ranked = food.rankFoods(this.data.foods, this.data.log, this.email);
    return food.remainingAsFoods(this.remaining, ranked)
      .map((x) => x.label)
      .join(', or ');
  },

  async removeEntry(id) {
    await food.deleteEntry(id);
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Removed');
  },

  // ---- meal prep -----------------------------------------------------------

  prep: null,       // 'copy' | 'save' | 'apply'
  copyCount: 3,
  templateName: '',

  openPrep(mode) {
    this.prep = mode;
    this.templateName = '';
  },
  closePrep() { this.prep = null; },

  get templates() { return this.data.templates; },

  /** Cook once, eat for the next N days. */
  async copyForward() {
    const targets = Array.from({ length: this.copyCount }, (_, i) => food.addDays(this.date, i + 1));
    const rows = await food.copyDay({
      log: this.data.log,
      ownerEmail: this.email,
      from: this.date,
      targets,
    });

    this.closePrep();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Copied ${rows.length} entries to ${this.copyCount} days`);
  },

  async saveAsTemplate() {
    const name = this.templateName.trim();
    if (!name) return;

    await food.saveDayTemplate({
      name,
      log: this.data.log,
      ownerEmail: this.email,
      date: this.date,
    });

    this.closePrep();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Saved “${name}”`);
  },

  async applyTemplate(template) {
    const rows = await food.applyDayTemplate({
      template,
      ownerEmail: this.email,
      date: this.date,
    });

    this.closePrep();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Added ${rows.length} entries`);
  },

  async removeTemplate(template) {
    await food.deleteTemplate(template.id);
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Template deleted');
  },
}));

// ---- log -------------------------------------------------------------------

/**
 * A food saved before scanned foods were stored as servings.
 *
 * Only OFF rows qualify: a hand-entered food measured in grams is measured in
 * grams on purpose, and rescanning must not overwrite that.
 */
function isStaleGramFood(f) {
  return f.source === 'off' && f.serving_unit !== 'serving';
}

/** One shape for the food form, whether typed by hand or filled from a lookup. */
function blankDraft(name = '') {
  return {
    id: null,
    name,
    brand: '',
    barcode: null,
    serving_qty: 100,
    serving_unit: 'g',
    default_qty: null,
    calories: '',
    protein_g: '',
    carbs_g: '',
    fat_g: '',
    fiber_g: '',
    sodium_mg: '',
    source: 'manual',
  };
}

Alpine.data('logPage', () => ({
  term: '',
  filter: '',       // '' | 'recent' | 'mine'
  sheet: null,      // { food, quantity, unit }
  creating: false,
  draft: null,

  servingSize: '',      // review-form converter, see applyServingSize()
  meal: null,           // { id, name, items: [{food_id, name, quantity, unit}] }
  mealPicker: false,
  mealTerm: '',
  _onlineTimer: null,
  _onlineGen: 0,

  init() {
    // Today's camera button raises this flag; the panel it opens is where the
    // scanner actually lives.
    this.$watch(() => Alpine.store('ui').scanRequested, (wanted) => {
      if (!wanted) return;
      Alpine.store('ui').scanRequested = false;
      this.openScanner();
    });

    // One search box. Local results are already reactive off `term`; this runs
    // the network half behind them.
    this.$watch('term', () => this.queueOnlineSearch());
  },

  get email() { return Alpine.store('auth').email; },
  get data() { return snapshot(); },

  get ranked() {
    return food.rankFoods(this.data.foods, this.data.log, this.email);
  },

  get results() {
    let list = food.searchFoods(this.ranked, this.term);
    if (this.filter === 'recent') {
      list = list.filter((f) => f.lastLoggedAt)
        .sort((a, b) => (a.lastLoggedAt < b.lastLoggedAt ? 1 : -1));
    } else if (this.filter === 'mine') {
      list = list.filter((f) => f.owner_email === this.email);
    }
    return list.slice(0, 60);
  },

  /** Yours and undeleted — the raw table carries both, and the other person's. */
  get combos() { return food.ownedCombos(this.data.combos, this.email); },

  /**
   * Meals matching the search, shown above ingredients.
   *
   * A meal is the more specific intent: typing "shake" when you have a meal
   * called Protein Shake means the meal, not every food with "shake" in it.
   */
  get comboResults() {
    return this.term ? food.searchCombos(this.combos, this.term) : [];
  },

  get foodsById() {
    // Includes soft-deleted rows on purpose: a meal whose ingredient was
    // removed should still log, since the log snapshots macros anyway.
    return new Map(this.data.foods.map((f) => [f.id, f]));
  },

  comboSummary(combo) {
    const totals = food.comboTotals(combo, this.foodsById);
    const n = (combo.items ?? []).length;
    return `${n} item${n === 1 ? '' : 's'} · ${Math.round(totals.calories)} kcal`;
  },

  get date() { return Alpine.store('ui').date; },
  get mealSlot() { return food.inferMealSlot(); },

  /** The one-tap path: log at the amount you last used for this food. */
  async quickLog(item) {
    const quantity = item.lastQuantity ?? item.default_qty ?? item.serving_qty ?? 1;
    await food.logFood({
      food: item,
      quantity,
      unit: item.lastUnit ?? item.serving_unit,
      ownerEmail: this.email,
      date: this.date,
    });
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`${item.name} · ${Math.round(quantity)}${item.serving_unit}`);
  },

  /** Times logged today. The undo button only exists when there's something to undo. */
  loggedToday(item) {
    return food.countLoggedToday(this.data.log, this.email, item.id, this.date);
  },

  /**
   * Exact inverse of the + button: takes back the most recent log of this food.
   * A mis-tap should be fixable where it happened, not by navigating to Today
   * and hunting for the row.
   */
  async undoLast(item) {
    const entry = food.lastEntryForFood(this.data.log, this.email, item.id, this.date);
    if (!entry) return;

    await food.deleteEntry(entry.id);
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Removed ${item.name}`);
  },

  /**
   * The amount sheet for a food that hasn't been written yet.
   *
   * There is no "save the food" step, because that was never something anyone
   * wanted to do — you save a food *because* you are logging it. The write
   * happens on Log, as a consequence of logging, and backing out writes nothing.
   */
  openDraftSheet(draft) {
    this.creating = false;
    this.sheet = {
      food: { ...draft },
      pending: { ...draft },
      quantity: draft.default_qty ?? draft.serving_qty ?? 1,
      unit: draft.serving_unit ?? 'g',
      prefilled: false,
    };
  },

  openSheet(item) {
    this.sheet = {
      food: item,
      pending: null,
      // What you ate last wins; then the label's serving; then the basis the
      // macros are stored against, which is only a sensible amount by accident.
      quantity: item.lastQuantity ?? item.default_qty ?? item.serving_qty ?? 1,
      unit: item.lastUnit ?? item.serving_unit ?? 'g',
      prefilled: item.lastQuantity != null,
    };
  },

  closeSheet() { this.sheet = null; },

  /**
   * The step follows the unit. Ten grams is a sensible nudge; ten servings is
   * ten cans of Fresca. `delta` is a direction, not an amount.
   */
  step(direction) {
    const size = this.sheet.unit === 'serving' ? 0.5 : 10;
    const next = Number(this.sheet.quantity) + Math.sign(direction) * size;
    this.sheet.quantity = Math.max(0, Math.round(next * 10) / 10);
  },

  get sheetMacros() {
    // Empty object rather than null: Alpine flushes effects for the sheet's
    // markup after `sheet` is cleared but before the template unmounts, so a
    // null here throws on every macro binding as the sheet closes.
    if (!this.sheet) return {};
    return food.scaleMacros(this.sheet.food, this.sheet.quantity);
  },

  async confirmSheet() {
    const { pending, quantity, unit } = this.sheet;

    // A food from a lookup is written here, on the way to logging it, rather
    // than in a step of its own beforehand.
    const item = pending ? await this.persistDraft(pending) : this.sheet.food;

    await food.logFood({ food: item, quantity, unit, ownerEmail: this.email, date: this.date });
    this.closeSheet();
    if (pending) { this.draft = null; this.term = ''; }
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Logged');
  },

  /**
   * Take a food out of your list.
   *
   * Soft, and safe for history: every log entry snapshots its own macros, so
   * removing the food leaves what you already ate untouched.
   */
  async removeFood(item) {
    await food.deleteFood(item.id);
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Removed ${item.name}`);
  },

  // ---- meals ---------------------------------------------------------------
  // A meal is several foods logged together under one name. Stored as a recipe
  // of references, not a snapshot — see saveCombo().

  startMeal() {
    this.meal = { id: null, name: this.term.trim(), items: [] };
    this.mealPicker = false;
    this.mealTerm = '';
  },

  editMeal(combo) {
    this.meal = {
      id: combo.id,
      name: combo.name,
      items: (combo.items ?? []).map((i) => ({ ...i })),
    };
    this.mealPicker = false;
    this.mealTerm = '';
  },

  closeMeal() { this.meal = null; this.mealPicker = false; this.mealTerm = ''; },

  /** Foods to pick from, ranked exactly as the main list is. */
  get mealChoices() {
    return food.searchFoods(this.ranked, this.mealTerm).slice(0, 30);
  },

  addIngredient(item) {
    this.meal.items.push({
      food_id: item.id,
      name: item.name,
      quantity: item.lastQuantity ?? item.default_qty ?? item.serving_qty ?? 1,
      unit: item.serving_unit ?? 'g',
    });
    this.mealPicker = false;
    this.mealTerm = '';
  },

  removeIngredient(index) { this.meal.items.splice(index, 1); },

  stepIngredient(index, direction) {
    const item = this.meal.items[index];
    const size = item.unit === 'serving' ? 0.5 : 10;
    item.quantity = Math.max(0, Math.round((Number(item.quantity) + Math.sign(direction) * size) * 10) / 10);
  },

  get mealTotals() {
    if (!this.meal) return food.emptyTotals();
    return food.comboTotals(this.meal, this.foodsById);
  },

  get canSaveMeal() {
    return Boolean(this.meal?.name?.trim()) && this.meal.items.length > 0;
  },

  async saveMeal({ andLog = false } = {}) {
    if (!this.canSaveMeal) return;

    const saved = await food.saveCombo(this.meal, this.email);
    this.closeMeal();
    this.term = '';
    await Alpine.store('data').refresh();

    if (andLog) {
      await this.logCombo(saved);
      return;
    }
    Alpine.store('ui').flash(`Saved “${saved.name}”`);
  },

  async removeMeal(combo) {
    await food.deleteCombo(combo.id);
    this.closeMeal();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Removed ${combo.name}`);
  },

  async logCombo(combo) {
    const rows = await food.logCombo({
      combo, foodsById: this.foodsById, ownerEmail: this.email, date: this.date,
    });
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`${combo.name} · ${rows.length} items`);
  },

  // ---- manual entry --------------------------------------------------------
  // Core, not a fallback: Open Food Facts is patchy on US store brands, so
  // typing a label in has to be a first-class path.

  startCreate() {
    this.creating = true;
    this.draft = blankDraft(this.term);
  },

  // ---- online lookup -------------------------------------------------------
  // Not a separate search. Your own foods render instantly from IndexedDB; this
  // runs behind them and appends what the internet knows, so one query covers
  // both. Barcodes go to Open Food Facts straight from the browser; names go to
  // USDA through the Edge Function, which holds the key. Either way the result
  // is a draft you review, never a silent write — OFF is crowd-sourced and
  // USDA's name matching is loose.

  online: { status: 'idle', results: [], error: '', term: '' },

  get looksLikeBarcode() {
    return /^\d{8,14}$/.test(this.term.trim());
  },

  /**
   * Online results that your own foods don't already cover.
   *
   * Deduped against the local list rather than merged into it: a lookup hit for
   * something you already have is noise, and scanning a food you eat weekly
   * should never offer to create a second copy of it.
   */
  get onlineResults() {
    if (this.online.term !== this.term.trim()) return [];
    const mine = this.results;
    return this.online.results.filter((r) => !mine.some((f) => food.matchesDraft(f, r.draft)));
  },

  get onlineBusy() {
    return this.online.status === 'searching' && this.online.term === this.term.trim();
  },

  /**
   * Debounced so a network call isn't fired per keystroke, and generation-
   * guarded so a slow response for "ch" can't land on top of results for
   * "chicken".
   */
  queueOnlineSearch() {
    clearTimeout(this._onlineTimer);
    const term = this.term.trim();

    // Already asked, or asking. Covers retyping the same word and the scanner,
    // which fires its own immediate lookup the instant it reads a code.
    if (term && term === this.online.term && this.online.status !== 'idle') return;

    // Two characters match half your foods; there is nothing useful to ask for.
    if (term.length < 3 && !this.looksLikeBarcode) {
      this._onlineGen = (this._onlineGen ?? 0) + 1;
      this.online = { status: 'idle', results: [], error: '', term: '' };
      return;
    }

    this._onlineTimer = setTimeout(() => this.runOnlineSearch(term), 350);
  },

  async runOnlineSearch(term) {
    if (!navigator.onLine) {
      this.online = { status: 'done', results: [], error: '', term };
      return;
    }

    const mine = ++this._onlineGen;
    this.online = { status: 'searching', results: [], error: '', term };

    let next;
    try {
      next = /^\d{8,14}$/.test(term)
        ? await this.lookupByBarcode(term)
        : await this.lookupByName(term);
    } catch (e) {
      next = { results: [], error: e.message ?? String(e) };
    }

    if (mine !== this._onlineGen) return;      // a newer search already started
    this.online = { status: 'done', ...next, term };
  },

  async lookupByBarcode(term) {
    const r = await lookupBarcode(term);
    if (r.status === 'found') {
      return { results: [{ draft: r.draft, missing: r.missing, source: 'Open Food Facts' }], error: '' };
    }
    return {
      results: [],
      error: {
        not_found: 'No product with that barcode. Add it by hand.',
        offline: '',
      }[r.status] ?? r.message ?? 'Lookup failed.',
    };
  },

  async lookupByName(term) {
    const { data, error } = await supabase.functions.invoke('lookup-usda', { body: { query: term } });
    if (error) throw error;

    return {
      results: (data.results ?? []).map((r) => ({
        draft: r.draft,
        missing: r.missing ?? [],
        source: r.dataType ?? 'USDA',
      })),
      error: data.error ?? '',
    };
  },

  // ---- scanner -------------------------------------------------------------

  scan: null,   // { status, message, decoder }

  get canScan() { return scanner.isSupported(); },

  async openScanner() {
    this.scan = { status: 'starting', message: '', decoder: '' };

    // The template renders on the next tick; the video element must exist first.
    await new Promise((r) => requestAnimationFrame(r));
    const video = this.$refs.video;

    const result = await scanner.start(video);
    if (!result.ok) {
      this.scan = { status: 'error', message: result.reason, decoder: '' };
      return;
    }

    this.scan = {
      status: 'ready',
      decoder: result.decoder,
      focus: result.focus,
      focusAt: null,
      // Say so rather than letting it look broken: on iOS there is no focus
      // control, and the camera app is the answer.
      message: result.focus === 'unavailable'
        ? 'This browser can’t control focus — use the camera app if it won’t read.'
        : 'Tap the preview to focus.',
    };

    scanner.startDecoding(video, {
      onResult: (code) => this.acceptCode(code),
      onError: (error) => { this.scan = { status: 'error', message: error.message, decoder: '' }; },
    });
  },

  /**
   * Shared by the live loop and the camera-app photo.
   *
   * A scan goes straight to the quantity sheet, so the whole gesture is: point
   * the camera, press Add. It used to require tapping the result, then Save on a
   * review form, then Add — three taps to log something the app had already
   * identified.
   *
   * The review form is still there, but only when it earns its place: a product
   * the app has never seen AND whose macros came back incomplete. Reviewing a
   * result that is already complete is a confirmation step with nothing to
   * confirm.
   */
  async acceptCode(code) {
    if (navigator.vibrate) navigator.vibrate(40);
    this.closeScanner();
    this.term = code;

    // Already yours: no lookup, no write, straight to the amount.
    //
    // Unless it was saved on the old per-100g basis. That shortcut made every
    // badly-stored food permanently badly-stored — rescanning found the local
    // copy and never asked Open Food Facts again, so the thing you rescanned it
    // to fix was exactly the thing it skipped.
    const mine = this.data.foods.find(
      (f) => !f.deleted_at && f.barcode && String(f.barcode) === code,
    );
    if (mine && !isStaleGramFood(mine)) {
      const ranked = this.ranked.find((f) => f.id === mine.id) ?? mine;
      this.openSheet(ranked);
      return;
    }

    this.online = { status: 'searching', results: [], error: '', term: code };
    const gen = ++this._onlineGen;

    let found;
    try {
      found = await this.lookupByBarcode(code);
    } catch (e) {
      found = { results: [], error: e.message ?? String(e) };
    }
    if (gen !== this._onlineGen) return;

    this.online = { status: 'done', ...found, term: code };

    const hit = found.results[0];

    // Nothing found, or found but with no serving to log it in. Either way the
    // review form is the honest answer — it must NOT silently save a 100 g
    // basis for a can of drink and call that done.
    if (!hit) {
      if (mine) this.openSheet(this.ranked.find((f) => f.id === mine.id) ?? mine);
      return;
    }

    // Same rule as tapping a search result, so a scan and a search behave
    // identically from here on.
    this.chooseOnline({ ...hit, existingId: mine?.id });
  },

  /** A photo from the system camera app, which focuses properly. */
  async decodePhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    // The live loop would otherwise keep reading underneath and could resolve
    // first, closing the sheet out from under this decode.
    scanner.stopDecoding();
    this.scan = { ...(this.scan ?? {}), status: 'reading', message: '' };

    let code = null;
    try {
      code = await scanner.decodeImageFile(file);
    } catch (e) {
      this.scan = { status: 'error', message: e.message, decoder: '' };
      return;
    }

    if (!code) {
      this.scan = { ...(this.scan ?? {}), status: 'ready',
                    message: 'No barcode in that photo — fill the frame and try again.' };
      this.resumeDecoding();
      return;
    }

    await this.acceptCode(code);
  },

  /**
   * Tap-to-focus.
   *
   * The video is object-fit: cover, so the element's box is a crop of the
   * frame — the tap has to be mapped back through that crop or the camera
   * focuses somewhere other than where you touched.
   */
  async focusHere(event) {
    if (this.scan?.status !== 'ready') return;

    const box = event.currentTarget.getBoundingClientRect();
    const left = ((event.clientX - box.left) / box.width) * 100;
    const top = ((event.clientY - box.top) / box.height) * 100;
    this.scan.focusAt = { left, top };

    const video = this.$refs.video;
    const source = video.videoWidth / video.videoHeight;
    const shown = box.width / box.height;

    // cover: the wider dimension is the one cropped.
    let x = left / 100;
    let y = top / 100;
    if (source > shown) {
      const visible = shown / source;                 // fraction of source width shown
      x = (1 - visible) / 2 + x * visible;
    } else if (source < shown) {
      const visible = source / shown;
      y = (1 - visible) / 2 + y * visible;
    }

    const ok = await scanner.focusAt(x, y);
    if (!ok) this.scan.message = 'This browser won’t let the page steer focus — use the camera app.';

    setTimeout(() => { if (this.scan) this.scan.focusAt = null; }, 700);
  },

  /** Put the live loop back after a photo attempt that didn't resolve. */
  resumeDecoding() {
    if (this.scan?.status !== 'ready') return;
    scanner.startDecoding(this.$refs.video, {
      onResult: (code) => this.acceptCode(code),
      onError: (error) => { this.scan = { status: 'error', message: error.message, decoder: '' }; },
    });
  },

  closeScanner() {
    scanner.stop(this.$refs.video);
    this.scan = null;
  },

  /** Pull a looked-up result into the same review form manual entry uses. */
  /**
   * Complete results go straight to the amount sheet. The review form is for
   * results that actually need reviewing — missing macros, or no serving to
   * express the food in.
   */
  chooseOnline(result) {
    const draft = { ...blankDraft(''), ...result.draft, id: result.existingId ?? null };
    if (result.missing.length || draft.serving_unit !== 'serving') {
      this.draft = draft;
      this.creating = true;
      return;
    }
    this.openDraftSheet(draft);
  },

  /** Force the review form, whatever the data looks like. */
  acceptLookup(result) {
    this.draft = { ...blankDraft(''), ...result.draft, id: result.existingId ?? null };
    this.creating = true;
  },

  cancelCreate() { this.creating = false; this.draft = null; this.servingSize = ''; },

  /**
   * Turn a per-100g draft into a per-serving one.
   *
   * Open Food Facts does not always record a serving size, and when it doesn't
   * there is nothing to derive one from — a can of drink comes back measured in
   * 100 ml, which is not how anyone drinks it. Rather than guess (a 355 ml can
   * and a 2 l bottle are both just `quantity` to OFF), this takes the number off
   * the label once and converts the macros to match. After this the food is
   * stored as 1 serving like any other scan.
   */
  applyServingSize() {
    const size = Number(this.servingSize);
    const basis = Number(this.draft.serving_qty);
    if (!(size > 0) || !(basis > 0)) return;

    const unit = this.draft.serving_unit || 'g';
    const factor = size / basis;

    for (const key of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sodium_mg']) {
      const value = this.draft[key];
      if (value === '' || value == null) continue;
      this.draft[key] = Math.round(Number(value) * factor * 10) / 10;
    }

    this.draft.serving_qty = 1;
    this.draft.serving_unit = 'serving';
    this.draft.basis = `${size} ${unit}`;
    this.servingSize = '';
  },

  get canSaveDraft() {
    return this.draft?.name?.trim() && Number(this.draft.serving_qty) > 0;
  },

  /** Review done — carry the draft to the amount sheet, which does the write. */
  addDraft() {
    if (!this.canSaveDraft) return;
    this.openDraftSheet(this.draft);
  },

  /** The write itself, shared with the scan path which skips the review form. */
  async persistDraft(d) {
    const numeric = (v) => (v === '' || v == null ? null : Number(v));

    return food.saveFood({
      // Present when rescanning a food you already have: updates that row rather
      // than leaving a stale duplicate behind, so the log keeps pointing at it.
      ...(d.id ? { id: d.id } : {}),
      name: d.name.trim(),
      brand: (d.brand ?? '').trim() || null,
      // No external_id here: plates.foods has no such column. The barcode is the
      // provenance that matters, and a USDA fdcId with nowhere to live would
      // write to IndexedDB happily and then fail on sync.
      barcode: d.barcode || null,
      serving_qty: Number(d.serving_qty),
      serving_unit: d.serving_unit.trim() || 'g',
      default_qty: d.default_qty == null || d.default_qty === '' ? null : Number(d.default_qty),
      calories: numeric(d.calories),
      protein_g: numeric(d.protein_g),
      carbs_g: numeric(d.carbs_g),
      fat_g: numeric(d.fat_g),
      fiber_g: numeric(d.fiber_g),
      sodium_mg: numeric(d.sodium_mg),
      source: d.source ?? 'manual',
    }, this.email);
  },
}));

// ---- boot ------------------------------------------------------------------

// ---- train -----------------------------------------------------------------

Alpine.data('trainPage', () => ({
  menu: false,
  picker: false,
  pickerTerm: '',
  finishing: false,
  routineName: '',
  restEndsAt: null,
  restLeft: 0,
  tick: 0,          // bumped by an interval so the timers re-render

  init() {
    // The drawn figure keys off primary_muscle, and exercises imported from Hevy
    // arrive without it. Filled in quietly in the background, at most weekly.
    this.$nextTick(async () => {
      if (!navigator.onLine) return;
      const missing = this.data.exercises.filter((e) => !e.deleted_at && !e.primary_muscle);
      if (!missing.length) return;

      const last = await local.getMeta('muscles:lastAttempt', 0);
      if (Date.now() - Number(last) < 7 * 86_400_000) return;
      await local.setMeta('muscles:lastAttempt', Date.now());

      try {
        await workout.importExerciseMetadata(this.data.exercises, this.email);
        await this.data.refresh();
      } catch { /* cosmetic; the figure falls back to reading the name */ }
    });

    // One ticker for both clocks. Only runs while the tab is visible, because a
    // phone in a pocket mid-set doesn't need to repaint a stopwatch.
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.tick++;
      if (this.restEndsAt) {
        this.restLeft = Math.ceil((this.restEndsAt - Date.now()) / 1000);
        if (this.restLeft <= 0) this.endRest(true);
      }
    }, 1000);
  },

  get email() { return Alpine.store('auth').email; },
  get data() { return snapshot(); },

  get session() { return workout.activeSession(this.data.sessions, this.email); },
  get sets() { return this.session ? workout.setsOf(this.data.index, this.session.id) : []; },
  get groups() { return workout.groupByExercise(this.sets); },
  get routines() { return workout.routinesFor(this.data.routines, this.email); },
  get history() { return workout.recentSessions(this.data.sessions, this.email); },

  get elapsed() {
    this.tick;   // read so Alpine re-evaluates each second
    return this.session ? workout.elapsed(this.session.started_at) : '00:00';
  },

  get volume() { return Math.round(workout.volume(this.sets)); },

  // ---- session lifecycle ---------------------------------------------------

  async startEmpty() {
    await workout.startSession({ name: null, ownerEmail: this.email });
    await this.data.refresh();
    this.picker = true;
  },

  async startFromRoutine(routine) {
    const session = await workout.startSession({
      name: routine.name, routineId: routine.id, ownerEmail: this.email,
    });

    // Seed the session with the routine's exercises so you start with the plan
    // in front of you rather than an empty screen.
    const planned = workout.routineExercises(this.data.routineExercises, routine.id);
    const library = workout.libraryFor(this.data.exercises, this.email);

    let existing = [];
    for (const item of planned) {
      const exercise = library.find((e) => e.id === item.exercise_id)
        ?? { id: item.exercise_id, name: item.notes || 'Exercise' };

      // One set to start, prefilled from the last time you did it. Add more as
      // you go — a routine says which exercises, not how many sets.
      const previous = workout.lastPerformance(
        this.data.sessionSets, this.data.sessions, this.email,
        exercise.id, exercise.name, session.id,
      );

      const { set } = await workout.addSet({
        session,
        exercise,
        weight: previous?.best?.weight_lb ?? null,
        reps: previous?.best?.reps ?? null,
        isWarmup: false,
        ownerEmail: this.email,
        existingSets: existing,
      });
      existing = [...existing, set];
    }

    await this.data.refresh();
  },

  async finishSession() {
    const name = this.routineName.trim();
    if (name) {
      await workout.saveSessionAsRoutine({
        name, session: this.session, sets: this.data.sessionSets, ownerEmail: this.email,
      });
    }
    await workout.finishSession(this.session);
    this.finishing = false;
    this.routineName = '';
    this.endRest();
    await this.data.refresh();
    Alpine.store('ui').flash(name ? `Finished · saved “${name}”` : 'Workout finished');
  },

  async discard() {
    await workout.discardSession(this.session, this.data.sessionSets);
    this.finishing = false;
    this.endRest();
    await this.data.refresh();
    Alpine.store('ui').flash('Workout discarded');
  },

  // ---- sets ----------------------------------------------------------------

  get library() {
    return workout.searchExercises(
      workout.libraryFor(this.data.exercises, this.email), this.pickerTerm,
    );
  },

  async addExercise(exercise) {
    await workout.addSet({
      session: this.session, exercise, weight: null, reps: null,
      isWarmup: false, ownerEmail: this.email, existingSets: this.sets,
    });
    this.picker = false;
    this.pickerTerm = '';
    await this.data.refresh();
  },

  async addSetTo(group) {
    const previous = group.sets[group.sets.length - 1];
    await workout.addSet({
      session: this.session,
      exercise: { id: group.exerciseId, name: group.name },
      weight: previous?.weight_lb ?? null,
      reps: previous?.reps ?? null,
      isWarmup: false,
      ownerEmail: this.email,
      existingSets: this.sets,
    });
    await this.data.refresh();
  },

  async edit(set, field, value) {
    await workout.updateSet(set, { [field]: value === '' ? null : Number(value) });
    await this.data.refresh();
  },

  /** Checking a set is what starts the rest clock — the moment you finish lifting. */
  async toggleDone(set) {
    const done = Boolean(set.completed_at);
    await workout.updateSet(set, { completed_at: done ? null : new Date().toISOString() });
    await this.data.refresh();

    if (!done) {
      this.startRest(workout.DEFAULT_REST_SECONDS);
      if (navigator.vibrate) navigator.vibrate(30);

      // Told at the moment it happens, not discovered in a stats screen weeks on.
      const group = this.groups.find((g) => g.sets.some((s) => s.id === set.id));
      if (group && workout.isRecord({ ...set, completed_at: new Date().toISOString() },
                                    this.bestBefore(group))) {
        Alpine.store('ui').flash(`PR · ${group.name}`);
        if (navigator.vibrate) navigator.vibrate([60, 50, 60]);
      }
    }
  },

  async dropSet(set) {
    await workout.removeSet(set.id);
    await this.data.refresh();
  },

  previous(group) {
    const best = this.data.prior.get(group.exerciseId ?? group.name)?.best;
    if (!best) return null;
    return `${best.weight_lb ?? '—'} lb × ${best.reps ?? '—'}`;
  },

  oneRm(set) { return workout.estimate1RM(set.weight_lb, set.reps); },

  /** Best estimated 1RM before this session — the bar a set has to clear. */
  /** Precomputed once per refresh; this used to rescan the whole log per set row. */
  bestBefore(group) {
    return this.data.prior.get(group.exerciseId ?? group.name)?.bestRm ?? null;
  },

  isRecord(set, group) { return workout.isRecord(set, this.bestBefore(group)); },

  /** What to load per side. Null for anything that isn't a barbell. */
  loadout(group, set) {
    if (!workout.usesBarbell(this.exerciseById(group.exerciseId), group.name)) return null;
    return workout.plateMath(set.weight_lb);
  },

  plateColour(size) { return workout.PLATE_COLOURS[size] ?? 'var(--color-text-muted)'; },

  // ---- rest timer ----------------------------------------------------------

  startRest(seconds) {
    this.restEndsAt = Date.now() + seconds * 1000;
    this.restLeft = seconds;
  },

  endRest(rang = false) {
    this.restEndsAt = null;
    this.restLeft = 0;
    if (rang && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  },

  addRest(seconds) {
    if (!this.restEndsAt) return this.startRest(Math.max(0, seconds));
    this.restEndsAt += seconds * 1000;
    this.restLeft = Math.ceil((this.restEndsAt - Date.now()) / 1000);
  },

  get restClock() { return workout.formatClock(this.restLeft); },

  // ---- misc ----------------------------------------------------------------

  sessionDate(session) {
    return new Date(session.started_at).toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  },

  sessionSummary(session) {
    const sets = workout.setsOf(this.data.index, session.id);
    const groups = workout.groupByExercise(sets);
    return `${groups.length} exercises · ${Math.round(workout.volume(sets)).toLocaleString()} lb`;
  },

  async deleteRoutine(routine) {
    await workout.deleteRoutine(routine, this.data.routineExercises);
    await this.data.refresh();
    Alpine.store('ui').flash('Routine deleted');
  },

  // ---- exercise history ----------------------------------------------------

  detail: null,   // { exerciseId, name, exercise }

  openExercise(exerciseId, name) {
    this.detail = {
      exerciseId,
      name,
      exercise: this.exerciseById(exerciseId) ?? { name },
    };
  },

  closeExercise() { this.detail = null; },

  get detailHistory() {
    if (!this.detail) return [];
    return workout.historyOf(this.data.index, this.detail.exerciseId, this.detail.name);
  },

  get detailBests() { return workout.personalBests(this.detailHistory); },

  detailDate(entry) {
    return new Date(entry.date).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  },

  /** "125 × 10, 125 × 8, 125 × 7" — the whole session at a glance. */
  setLine(entry) {
    return entry.sets
      .map((s) => `${s.weight_lb ?? '—'}×${s.reps ?? '—'}${s.is_warmup ? 'w' : ''}`)
      .join(', ');
  },

  // ---- routine builder -----------------------------------------------------

  // { routine, name, mode: 'view' | 'edit' } — null when closed. Opening a
  // routine shows what's in it; starting it is a deliberate second action, so a
  // curious tap can't accidentally begin a workout.
  builder: null,

  newRoutine() { this.builder = { routine: null, name: '', mode: 'edit' }; },

  openRoutine(routine) { this.builder = { routine, name: routine.name, mode: 'view' }; },

  toEdit() { this.builder.mode = 'edit'; },

  closeBuilder() { this.builder = null; },

  async startFromBuilder() {
    const routine = this.builder.routine;
    this.closeBuilder();
    await this.startFromRoutine(routine);
  },

  async deleteFromBuilder() {
    const routine = this.builder.routine;
    this.closeBuilder();
    await this.deleteRoutine(routine);
  },

  routineCount(routine) {
    return workout.routineExercises(this.data.routineExercises, routine.id).length;
  },

  /** Everything a routine card shows, all derived from history. */
  routineCard(routine) {
    const stats = workout.routineStats(routine, this.data.index);
    return {
      ...workout.coverage(routine, this.data.routineExercises, this.data.exercises),
      ...stats,
      exercises: this.routineCount(routine),
      lastLabel: workout.relativeDay(stats.last),
      volumeLabel: stats.avgVolume
        ? `${(stats.avgVolume / 1000).toFixed(1)}k lb`
        : null,
    };
  },

  /** What you last did, rather than a target — history is the better guide. */
  lastLine(row) {
    const p = workout.lastPerformance(
      this.data.sessionSets, this.data.sessions, this.email,
      row.item.exercise_id, row.name, null,
    );
    if (!p?.best) return 'Not done yet';
    return `Last: ${p.best.weight_lb ?? '—'} lb × ${p.best.reps ?? '—'}`;
  },

  get builderExercises() {
    if (!this.builder?.routine) return [];
    return workout.routineExercises(this.data.routineExercises, this.builder.routine.id)
      .map((item) => ({
        item,
        exercise: this.data.exercises.find((e) => e.id === item.exercise_id) ?? null,
        name: this.data.exercises.find((e) => e.id === item.exercise_id)?.name
          ?? item.notes ?? 'Exercise',
      }));
  },

  async saveRoutineName() {
    const name = this.builder.name.trim();
    if (!name) return;

    const routine = await workout.upsertRoutine(
      { id: this.builder.routine?.id, name }, this.email,
    );
    this.builder.routine = routine;
    await this.data.refresh();
  },

  /** Picker doubles as "add to routine" while the builder is open. */
  async addToRoutine(exercise) {
    if (!this.builder.routine) await this.saveRoutineName();

    await workout.addRoutineExercise({
      routineId: this.builder.routine.id,
      exercise,
      position: this.builderExercises.length,
      ownerEmail: this.email,
    });
    this.picker = false;
    this.pickerTerm = '';
    await this.data.refresh();
  },

  async editRoutineItem(item, field, value) {
    await workout.updateRoutineExercise(item, {
      [field]: value === '' ? null : (field === 'target_reps' ? value : Number(value)),
    });
    await this.data.refresh();
  },

  async dropRoutineItem(item) {
    await workout.removeRoutineExercise(item.id);
    await this.data.refresh();
  },

  // ---- Hevy import ---------------------------------------------------------

  hevy: null,

  async importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    this.hevy = { phase: 'reading' };
    try {
      const text = await file.text();
      await importHevy(text, {
        ownerEmail: this.email,
        existingExercises: this.data.exercises,
      }, (p) => { this.hevy = p; });

      await this.data.refresh();
      Alpine.store('ui').flash(
        `Imported ${this.hevy.sessions} workouts · ${this.hevy.routines} routines`);
    } catch (e) {
      this.hevy = { phase: 'error', message: e.message };
    } finally {
      event.target.value = '';   // let the same file be picked again after a fix
    }
  },

  get hevyLabel() {
    if (!this.hevy) return '';
    switch (this.hevy.phase) {
      case 'reading':   return 'Reading file…';
      case 'parsing':   return 'Parsing…';
      case 'exercises': return `Exercises: ${this.hevy.created} new of ${this.hevy.total}`;
      case 'sessions':  return `Workouts ${this.hevy.done}/${this.hevy.total} · ${this.hevy.sets} sets`;
      case 'done':      return `Done · ${this.hevy.sessions} workouts, ${this.hevy.sets} sets, ${this.hevy.routines} routines`;
      default:          return '';
    }
  },

  // ---- muscle map ----------------------------------------------------------
  // A drawn figure with the worked muscle lit, instead of a photographed
  // demonstration. Consistent, offline, and no licence attached.

  muscleMap(exerciseId, name) {
    return muscleMap(this.exerciseById(exerciseId), name);
  },

  /** Front and back together, for the detail sheet. */
  muscleMapPair(exerciseId, name) {
    return muscleMap(this.exerciseById(exerciseId), name, { both: true });
  },

  /** Written form cues. The figure says which muscle; these say how. */
  get detailInstructions() {
    const raw = this.detail?.exercise?.instructions;
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) return [raw];
    return [];
  },

  exerciseById(id) { return this.data.exercises.find((e) => e.id === id) ?? null; },

  // ---- Hevy import ---------------------------------------------------------

  hevy: null,

  async importFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    this.hevy = { phase: 'reading' };
    try {
      const text = await file.text();
      await importHevy(text, {
        ownerEmail: this.email,
        existingExercises: this.data.exercises,
      }, (p) => { this.hevy = p; });

      await this.data.refresh();
      Alpine.store('ui').flash(
        `Imported ${this.hevy.sessions} workouts · ${this.hevy.routines} routines`);
    } catch (e) {
      this.hevy = { phase: 'error', message: e.message };
    } finally {
      event.target.value = '';   // let the same file be picked again after a fix
    }
  },

  get hevyLabel() {
    if (!this.hevy) return '';
    switch (this.hevy.phase) {
      case 'reading':   return 'Reading file…';
      case 'parsing':   return 'Parsing…';
      case 'exercises': return `Exercises: ${this.hevy.created} new of ${this.hevy.total}`;
      case 'sessions':  return `Workouts ${this.hevy.done}/${this.hevy.total} · ${this.hevy.sets} sets`;
      case 'done':      return `Done · ${this.hevy.sessions} workouts, ${this.hevy.sets} sets, ${this.hevy.routines} routines`;
      default:          return '';
    }
  },

  // ---- muscle map ----------------------------------------------------------
  // A drawn figure with the worked muscle lit, instead of a photographed
  // demonstration. Consistent across every exercise, offline, no licence
  // attached — and it matches the app rather than looking like stock imagery.

  exerciseById(id) { return this.data.exercises.find((e) => e.id === id) ?? null; },

  muscleMap(exerciseId, name) {
    return muscleMap(this.exerciseById(exerciseId), name);
  },

  /** Front and back together, for the detail sheet. */
  muscleMapPair(exerciseId, name) {
    return muscleMap(this.exerciseById(exerciseId), name, { both: true });
  },

  /** Written form cues. The figure says which muscle; these say how. */
  get detailInstructions() {
    const raw = this.detail?.exercise?.instructions;
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) return [raw];
    return [];
  },

}));

// ---- stats -----------------------------------------------------------------

Alpine.data('statsPage', () => ({
  weighing: false,
  newWeight: '',

  get email() { return Alpine.store('auth').email; },
  get data() { return snapshot(); },

  // ---- body weight ---------------------------------------------------------

  get goal() { return food.currentGoal(this.data.goals, this.email); },

  get weight() { return stats.weightSeries(this.data.weightLog, this.email); },
  get weightSummary() { return stats.weightSummary(this.weight, this.goal); },

  get weightChart() {
    const line = stats.linePoints(this.weight.map((w) => w.lb), { width: 100, height: 46 });
    return stats.lineChart(line.points, { stroke: 'var(--color-protein)' });
  },

  async saveWeight() {
    const lb = Number(this.newWeight);
    if (!Number.isFinite(lb) || lb <= 0) return;

    await stats.logWeight(lb, this.email);
    this.newWeight = '';
    this.weighing = false;
    await this.data.refresh();
    Alpine.store('ui').flash(`Logged ${lb} lb`);
  },

  // ---- training ------------------------------------------------------------

  get weeks() { return stats.weeklyTraining(this.data.index); },

  get weekChart() {
    const weeks = this.weeks;
    const bars = stats.barGeometry(weeks.map((w) => w.volume)).map((bar, i) => ({
      ...bar,
      tip: `${weeks[i].start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: `
         + `${Math.round(bar.value).toLocaleString()} lb · ${weeks[i].sessions} sessions`,
    }));
    return stats.barChart(bars, { fill: 'var(--color-protein)', emphasiseLast: true });
  },

  get thisWeek() { return this.weeks[this.weeks.length - 1] ?? { volume: 0, sessions: 0 }; },

  get lifts() { return stats.topLifts(this.data.index); },

  // ---- nutrition -----------------------------------------------------------

  get days() { return stats.calorieDays(this.data.log, this.data.goals, this.email); },
  get calorieSummary() { return stats.calorieSummary(this.days); },

  get dayChart() {
    const days = this.days;
    const bars = stats.barGeometry(days.map((d) => d.kcal)).map((bar, i) => ({
      ...bar,
      logged: days[i].logged,
      tip: `${bar.value.toLocaleString()} kcal`,
    }));
    return stats.barChart(bars, { fill: 'var(--color-carbs)', dimUnlogged: true });
  },

  /** Where the target sits on the same scale as the bars. */
  get targetLine() {
    const target = this.calorieSummary?.target;
    if (!target) return null;
    const max = Math.max(...this.days.map((d) => d.kcal), target, 1);
    return 60 - (target / max) * 60;
  },

  round(n) { return Math.round(Number(n) || 0); },
  thousands(n) { return `${(Number(n) / 1000).toFixed(1)}k`; },

  // ---- targets -------------------------------------------------------------

  editing: false,
  draft: null,

  get phases() { return food.goalHistory(this.data.goals, this.email); },

  editGoal() {
    const g = this.goal;
    this.draft = {
      phase: g?.phase ?? 'maintain',
      calorie_target: g?.calorie_target ?? '',
      protein_target_g: g?.protein_target_g ?? '',
      carbs_target_g: g?.carbs_target_g ?? '',
      fat_target_g: g?.fat_target_g ?? '',
      target_weight_lb: g?.target_weight_lb ?? '',
    };
    this.editing = true;
  },

  /** Calories the macro split actually adds up to — a cheap sanity check. */
  get draftMacroKcal() { return this.draft ? food.caloriesFromMacros(this.draft) : null; },

  get draftMismatch() {
    const target = Number(this.draft?.calorie_target);
    const implied = this.draftMacroKcal;
    if (!target || !implied) return null;
    return Math.abs(implied - target) > 60 ? implied - target : null;
  },

  async saveGoal() {
    await food.updateGoal(this.goal ?? {}, this.draft, this.email);
    this.editing = false;
    await this.data.refresh();
    Alpine.store('ui').flash('Targets updated');
  },

  async saveNewPhase() {
    await food.startPhase(this.draft, this.goal, this.email);
    this.editing = false;
    await this.data.refresh();
    Alpine.store('ui').flash(`Started ${this.draft.phase}`);
  },
}));

// The offline shell. Registered after the app is up so it never delays first
// paint, and skipped in dev-by-file-protocol where it can't work anyway.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('Service worker registration failed:', e.message);
    });
  });
}

// Hand off from the static boot screen once the real shell is mounted.
document.addEventListener('alpine:initialized', () => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('is-done');
  setTimeout(() => boot.remove(), 200);
});

window.Alpine = Alpine;

// Console handle for poking at things during development. The client only ever
// holds the publishable key, so this exposes nothing the page didn't already ship.
window.plates = { supabase, local, sync, food };

Alpine.start();
