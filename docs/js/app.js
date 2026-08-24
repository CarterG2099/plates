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
import { lookupBarcode, draftsFromProducts } from './lookup.js';
import * as scanner from './scanner.js';
import * as photo from './photo.js';
import * as workout from './workout.js';
import { importHevy } from './import-hevy.js';
import { exerciseArt, exerciseArtPair } from './muscle-map.js';
import * as stats from './stats.js';
import * as push from './push.js';

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
 * Drag a row left to reveal its action.
 *
 * Pointer events, so a mouse does this as well as a finger — with no remove
 * button on the row any more, a touch-only gesture would leave a desktop with
 * no way to delete anything.
 *
 * Direction is decided on the first move and then locked: if the pointer goes
 * more vertical than horizontal it is a scroll, and the row must not creep
 * sideways while the list moves under it. On touch that verdict is the
 * browser's to make as well — `touch-action: pan-y` (set in CSS alongside the
 * transition) lets it keep vertical panning and hand us the horizontal, and it
 * sends `pointercancel` if it claims the gesture mid-drag.
 */
Alpine.magic('swipeRow', () => (wrap) => {
  if (!wrap || wrap.dataset.swipeRow) return;
  wrap.dataset.swipeRow = '1';

  // `.setrow` too: a set inside a workout is swiped away exactly like a food row.
  const slide = wrap.querySelector('.row, .setrow');
  if (!slide) return;

  const WIDTH = 96;             // matches .row-remove
  const THRESHOLD = 40;

  let startX = 0, startY = 0, dx = 0, pointerId = null;
  let dragging = false, locked = false, dragged = false;

  const isOpen = () => wrap.classList.contains('is-open');

  slide.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;      // primary button or touch; never a right-click

    // A mouse dragging sideways inside the weight or reps box is selecting
    // text, not swiping the row away. Only a mouse: dragging a finger across a
    // number field is a swipe, and excluding those columns on touch would
    // leave barely any of a set row to grab.
    if (e.pointerType === 'mouse' && e.target.closest('input, textarea, select')) return;

    // One row open at a time; two revealed actions is a mis-tap waiting.
    for (const other of document.querySelectorAll('.row-swipe.is-open')) {
      if (other !== wrap) other.classList.remove('is-open');
    }
    startX = e.clientX;
    startY = e.clientY;
    dx = isOpen() ? -WIDTH : 0;
    pointerId = e.pointerId;
    dragging = true;
    locked = false;
    slide.style.transition = 'none';
  });

  slide.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;

    const x = e.clientX - startX;
    const y = e.clientY - startY;

    if (!locked) {
      if (Math.abs(y) > Math.abs(x)) { dragging = false; slide.style.transition = ''; return; }
      if (Math.abs(x) < 6) return;                 // too small to call yet
      locked = true;
      dragged = true;
      // The action is not painted until this lands — see .row-remove.
      wrap.classList.add('is-sliding');
      // Captured only once the gesture is known to be ours, so a vertical drag
      // is left entirely to the browser.
      slide.setPointerCapture(pointerId);
    }

    dx = Math.min(0, Math.max(-WIDTH, (isOpen() ? -WIDTH : 0) + x));
    slide.style.transform = `translateX(${dx}px)`;
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    pointerId = null;
    slide.style.transition = '';
    slide.style.transform = '';        // the class drives it from here
    wrap.classList.remove('is-sliding');
    wrap.classList.toggle('is-open', dx < -THRESHOLD);
  };

  slide.addEventListener('pointerup', release);
  slide.addEventListener('pointercancel', release);

  // While open, a tap closes rather than logging. Capture phase, so it lands
  // before the row's own click handlers.
  slide.addEventListener('click', (e) => {
    // A mouse fires a click at the end of a drag; touch suppresses it once the
    // finger has moved past the browser's slop. Without this, dragging a row
    // open with a mouse would open and then immediately close it.
    if (dragged) {
      dragged = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove('is-open');
  }, true);
});

/**
 * Drag a card by its handle to reorder it among its siblings.
 *
 * Pointer events rather than touch, so the same code serves a finger and a
 * mouse. The dragged card is lifted with a transform and its siblings shift to
 * open a gap; nothing is written until the drop, and then only the new index is
 * reported — the caller owns what "order" means.
 *
 * Positions are measured once at drag start. Reading layout during the move
 * would be both slower and wrong, because the transforms being applied are
 * exactly what would be read back.
 *
 * The dragged card's identity is read off the DOM at drop time rather than
 * captured when the handle was bound. x-init runs once per element, and x-for
 * reuses elements across reorders — a captured scope reference is exactly the
 * kind of thing that ends up one position stale.
 *
 * @param {HTMLElement} handle  what you press to start dragging
 * @param {() => HTMLElement[]} cards  siblings in current display order
 * @param {(toIndex: number, key: string) => void} onDrop  only when the index changes
 */
Alpine.magic('dragCard', () => (handle, cards, onDrop) => {
  if (!handle || handle.dataset.dragCard) return;
  handle.dataset.dragCard = '1';

  handle.style.touchAction = 'none';

  handle.addEventListener('pointerdown', (down) => {
    // Left button or touch only; a right-click must not start a drag.
    if (down.button !== 0) return;

    const list = cards();
    const card = handle.closest('[data-card]');
    const from = list.indexOf(card);
    if (from === -1 || list.length < 2) return;

    down.preventDefault();
    handle.setPointerCapture(down.pointerId);

    const boxes = list.map((el) => el.getBoundingClientRect());
    const height = boxes[from].height;
    // Gap included, or every card shifts short by the flex gap and the stack
    // visibly overlaps as it opens.
    const stride = list.length > 1
      ? Math.abs((boxes[1].top - boxes[0].top) || height)
      : height;

    let to = from;
    card.classList.add('is-dragging');

    const move = (e) => {
      const dy = e.clientY - down.clientY;
      card.style.transform = `translateY(${dy}px)`;

      // Half a card's travel is one place. Rounding means the swap happens as
      // the dragged card's centre passes its neighbour's, which is where the
      // eye expects it.
      const next = Math.max(0, Math.min(list.length - 1, from + Math.round(dy / stride)));
      if (next === to) return;
      to = next;

      list.forEach((el, i) => {
        if (i === from) return;
        // Everything between the old and new slot steps one place the other way.
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -stride;
        else if (from > to && i >= to && i < from) shift = stride;
        el.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    /**
     * `commit` is what separates letting go from being interrupted. A
     * pointercancel is the system taking the gesture away — a notification, a
     * call, the browser deciding it was a scroll — and reordering somebody's
     * workout off the back of that is not something they asked for. Lifting a
     * finger commits; anything else puts the card back.
     */
    const finish = (commit) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);

      card.classList.remove('is-dragging');
      for (const el of list) el.style.transform = '';

      if (commit && to !== from) onDrop(to, card.dataset.key);
    };

    const up = () => finish(true);
    const cancel = () => finish(false);

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
  });
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
      // A completed pull may have brought in the other person's rows — but only
      // re-read if it actually brought something. Refreshing unconditionally
      // rebuilt the screen to show what it was already showing, and that was
      // the 0.15 layout shift a second after every load.
      if (wasSyncing && s.status === 'idle' && s.changed) Alpine.store('data').refresh();
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

/**
 * Read raw data while still re-rendering when it changes.
 *
 * There are two counters, not one, because `x-show` keeps a tab's component
 * mounted and reactive while it is hidden — Today and the log panel stay live
 * through an entire workout. On one shared counter, checking a set re-ran
 * `rankFoods` over the whole food log twice (Today's remaining-in-food line and
 * the log panel's results) before the tick could paint. Splitting them means a
 * set toggle touches the set rows and nothing else.
 */
function snapshot() {
  Alpine.store('data').version;        // registers the dependency
  return raw;
}

/** The training half: exercises, routines, sessions, sets, and the set index. */
function snapshotTraining() {
  Alpine.store('data').trainVersion;
  return raw;
}

/** For the one screen that reads both halves. */
function snapshotAll() {
  const store = Alpine.store('data');
  store.version;
  store.trainVersion;
  return raw;
}

Alpine.store('data', {
  ready: false,
  version: 0,        // the food half — see snapshot()
  trainVersion: 0,   // the training half — see snapshotTraining()
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
    // Excluding the workout in progress, which is what makes "previous" mean the
    // last time rather than the set you just did — and makes a PR a PR against
    // history rather than against yourself ten seconds ago.
    const running = workout.activeSession(sessions, Alpine.store('auth').email);
    raw.prior = workout.priorForm(raw.index, running?.id ?? null);
    this.trainVersion++;
  },

  /**
   * Splice one changed set into the data already in memory.
   *
   * A full refresh re-reads all eleven stores and rebuilds the whole set index —
   * thousands of rows with two years imported. Checking a set was paying that
   * twice, because the weight/reps input's `change` fires before the button's
   * `click`, and it is the single most repeated interaction in the app. Nothing
   * about one set changes any of the rest, so nothing else is recomputed.
   *
   * Updates only. Adding or removing a set changes ordering and grouping, and
   * those go through the full refresh.
   */
  patchSet(row) {
    const splice = (list) => {
      const i = list?.findIndex((s) => s.id === row.id) ?? -1;
      if (i !== -1) list[i] = row;
    };

    splice(raw.sessionSets);
    splice(raw.index.bySession.get(row.session_id));
    splice(raw.index.byExercise.get(row.exercise_id ?? row.exercise_name));

    const bucket = raw.index.bySession.get(row.session_id);
    if (bucket) raw.index.volumeBySession.set(row.session_id, workout.volume(bucket));

    this.trainVersion++;
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

  amountLabel(quantity, unit) { return food.amountLabel(quantity, unit); },

  // ---- editing a logged amount ---------------------------------------------
  //
  // Everything needed to correct a mis-tapped amount was already on the entry;
  // the row just had no way to be opened. Weight is offered as a lens over
  // servings rather than a second unit, so the entry keeps reading the way it
  // was logged no matter which box you typed the number into.

  edit: null,       // { entry, item, amount, lens }
  sizeInput: '',    // one-time capture, for a food with no serving size yet
  sizeUnit: 'g',

  openEdit(entry) {
    const item = this.data.foods.find((f) => f.id === entry.food_id) ?? null;
    this.edit = { entry, item, amount: Number(entry.quantity), lens: 'native' };
    this.sizeInput = '';
    this.sizeUnit = item?.serving_size_unit ?? 'g';
  },

  closeEdit() { this.edit = null; },

  /**
   * What one serving of this food measures. Null is not a failure — it means
   * nobody has told this food yet, and the sheet asks once.
   */
  get servingSize() {
    return Number(this.edit?.item?.serving_size) || null;
  },

  get servingSizeUnit() { return this.edit?.item?.serving_size_unit ?? 'g'; },

  /**
   * Only a serving can be looked at through a weight. A food already logged in
   * grams is its own lens, and one with no food row behind it — a deleted food,
   * or an entry from a photo estimate — has nothing to convert against.
   */
  get canMeasure() {
    return !!this.edit?.item && this.edit.entry.unit === 'serving';
  },

  /**
   * The number in the box. Cleared to empty by the input while typing, which
   * would otherwise reach the macros as NaN and render every one of them blank.
   */
  get editAmount() { return Number(this.edit?.amount) || 0; },

  /** Switching lens converts the number in the box. The entry is not touched. */
  setLens(lens) {
    if (!this.edit || this.edit.lens === lens) return;

    const per = this.servingSize;
    if (per) {
      this.edit.amount = lens === 'measure'
        ? Math.round(this.editAmount * per * 10) / 10
        : Math.round((this.editAmount / per) * 100) / 100;
    }
    this.edit.lens = lens;
  },

  /**
   * Teach the food what one serving measures.
   *
   * Written onto the food rather than held for this edit, so it is asked once
   * and then known everywhere — including the next time this food is logged.
   */
  async applyServingSize() {
    const size = Number(this.sizeInput);
    if (!(size > 0) || !this.edit?.item) return;

    this.edit.item = await food.saveFood({
      ...this.edit.item,
      serving_size: size,
      serving_size_unit: this.sizeUnit.trim() || 'g',
    });
    this.edit.amount = Math.round(this.editAmount * size * 10) / 10;
    this.sizeInput = '';
    await Alpine.store('data').refresh();
  },

  /** The number in the box, back in the entry's own unit. */
  get editQuantity() {
    if (!this.edit) return 0;
    const per = this.servingSize;
    if (this.edit.lens === 'measure' && per) {
      return Math.round((this.editAmount / per) * 100) / 100;
    }
    return this.editAmount;
  },

  /** The step follows the lens: half a serving, or ten of whatever it weighs. */
  editStep(direction) {
    if (!this.edit) return;
    const size = this.edit.lens === 'measure' || this.edit.entry.unit !== 'serving' ? 10 : 0.5;
    const next = this.editAmount + Math.sign(direction) * size;
    this.edit.amount = Math.max(0, Math.round(next * 100) / 100);
  },

  get editMacros() {
    // Empty object rather than null, for the reason sheetMacros gives: Alpine
    // flushes this sheet's bindings after `edit` is cleared but before the
    // template unmounts, and a null throws on every one of them.
    if (!this.edit) return {};
    return food.scaleEntry(this.edit.entry, this.editQuantity, this.edit.item);
  },

  async saveEdit() {
    const { entry, item } = this.edit;
    await food.updateEntry({ entry, quantity: this.editQuantity, food: item });

    this.closeEdit();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Updated');
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

/** Digits only, and the length of a real UPC or EAN. */
const isBarcode = (term) => /^\d{8,14}$/.test(term);

/** One shape for the food form, whether typed by hand or filled from a lookup. */
function blankDraft(name = '') {
  return {
    id: null,
    name,
    brand: '',
    barcode: null,
    serving_qty: 100,
    serving_unit: 'g',
    serving_size: null,
    serving_size_unit: null,
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
  menu: false,
  photoBusy: '',        // '' | 'label' | 'meal'
  photoError: '',
  estimate: null,       // { items, confidence, note }
  meal: null,           // { id, name, items: [{food_id, name, quantity, unit}] }
  mealTerm: '',
  mealOnline: { status: 'idle', results: [], error: '', term: '' },
  // Keyed by state slot, so both searches share the machinery without sharing
  // results. See queueSearch().
  _timers: {},
  _gens: {},

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
    this.$watch('term', () => this.queueSearch('online', this.term));

    // The ingredient picker searches the internet too. An ingredient you have
    // never logged is exactly as likely as a food you have never logged.
    this.$watch('mealTerm', () => this.queueSearch('mealOnline', this.mealTerm));
  },

  get email() { return Alpine.store('auth').email; },
  get data() { return snapshot(); },

  amountLabel(quantity, unit) { return food.amountLabel(quantity, unit); },

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

  // ---- menu ----------------------------------------------------------------
  // Everything that isn't searching lives here, so the page below the search
  // stays results and nothing else. Buttons stacked under the results just sank
  // further down the page as the list grew.

  openMenu() { this.menu = true; },
  closeMenu() { this.menu = false; },

  /** Your own foods and meals, without typing anything. */
  browseMine() {
    this.term = '';
    this.filter = 'mine';
    this.closeMenu();
  },

  fromMenu(action) {
    this.closeMenu();
    action();
  },

  // ---- photos --------------------------------------------------------------
  // A label is transcription; a meal is estimation. They are different kinds of
  // claim and the UI keeps them apart on purpose.

  /** A Nutrition Facts panel becomes a draft, reviewed like any lookup hit. */
  async readLabel(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    this.photoBusy = 'label';
    this.photoError = '';
    try {
      const result = await photo.readLabel(file);
      // Straight to the review form, never saved on the model's say-so: this is
      // OCR of small print at an angle, and a misread digit is a wrong food.
      this.acceptLookup(result);
    } catch (e) {
      this.photoError = e.message ?? String(e);
    } finally {
      this.photoBusy = '';
    }
  },

  /** A plate becomes a set of estimates, shown as estimates. */
  async readMeal(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    this.photoBusy = 'meal';
    this.photoError = '';
    try {
      this.estimate = await photo.estimateMeal(file);
    } catch (e) {
      this.photoError = e.message ?? String(e);
    } finally {
      this.photoBusy = '';
    }
  },

  closeEstimate() { this.estimate = null; },

  /**
   * Build a saved meal out of an estimated plate.
   *
   * The items keep their own macros rather than becoming foods. A plate you ate
   * once is not a food worth keeping, and creating one per item would fill the
   * list you search with guesses.
   */
  async buildMealFromPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    this.photoBusy = 'meal';
    this.photoError = '';
    try {
      const result = await photo.estimateMeal(file);
      this.meal = {
        id: null,
        name: '',
        items: result.items.map((i) => ({
          food_id: null,
          name: i.portion ? `${i.name} (${i.portion})` : i.name,
          quantity: 1,
          unit: 'serving',
          calories: i.calories,
          protein_g: i.protein_g,
          carbs_g: i.carbs_g,
          fat_g: i.fat_g,
          fiber_g: null,
          sodium_mg: null,
        })),
      };
      this.mealTerm = '';
    } catch (e) {
      this.photoError = e.message ?? String(e);
    } finally {
      this.photoBusy = '';
    }
  },

  removeEstimateItem(index) {
    this.estimate.items.splice(index, 1);
    if (!this.estimate.items.length) this.estimate = null;
  },

  get estimateTotals() {
    return photo.mealTotals(this.estimate?.items ?? []);
  },

  get confidenceLabel() {
    return {
      high: 'Rough estimate',
      medium: 'Rough estimate — portion size is a guess',
      low: 'Very rough — portion size and hidden fat are guesses',
    }[this.estimate?.confidence] ?? 'Rough estimate';
  },

  /**
   * Log the estimate.
   *
   * Each item logs as its own entry with its own macros and no food_id: these
   * are one-off guesses about one plate, not foods worth keeping. Putting them
   * in your food list would poison the search you rely on.
   */
  async logEstimate() {
    const slot = food.inferMealSlot();
    let logged = 0;

    for (const item of this.estimate.items) {
      await food.logFood({
        food: {
          id: null,
          name: item.portion ? `${item.name} (${item.portion})` : item.name,
          brand: null,
          serving_qty: 1,
          serving_unit: 'serving',
          calories: item.calories,
          protein_g: item.protein_g,
          carbs_g: item.carbs_g,
          fat_g: item.fat_g,
          fiber_g: null,
          sodium_mg: null,
        },
        quantity: 1,
        unit: 'serving',
        mealSlot: slot,
        ownerEmail: this.email,
        date: this.date,
      });
      logged += 1;
    }

    const kcal = this.estimateTotals.calories;
    this.closeEstimate();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Logged ${logged} items · ~${kcal} kcal`);
  },

  // ---- meals ---------------------------------------------------------------
  // A meal is several foods logged together under one name. Stored as a recipe
  // of references, not a snapshot — see saveCombo().

  startMeal() {
    this.meal = { id: null, name: this.term.trim(), items: [] };
    this.mealTerm = '';
  },

  editMeal(combo) {
    this.meal = {
      id: combo.id,
      name: combo.name,
      items: (combo.items ?? []).map((i) => ({ ...i })),
    };
    this.mealTerm = '';
  },

  closeMeal() {
    this.meal = null;
    this.mealTerm = '';
    this._gens.mealOnline = (this._gens.mealOnline ?? 0) + 1;   // strand any in-flight lookup
    this.mealOnline = { status: 'idle', results: [], error: '', term: '' };
  },


  get mealOnlineResults() {
    if (this.mealOnline.term !== this.mealTerm.trim()) return [];
    const local = this.mealChoices;
    return this.mealOnline.results.filter((r) => !local.some((f) => food.matchesDraft(f, r.draft)));
  },

  get mealOnlineBusy() {
    return this.mealOnline.status === 'searching' && this.mealOnline.term === this.mealTerm.trim();
  },

  /**
   * Add a food the app has never seen as an ingredient.
   *
   * Unlike logging, this has to write the food first: a meal's items reference
   * food_id, so there is nothing to point at until the row exists.
   */
  async addOnlineIngredient(result) {
    const saved = await this.persistDraft({ ...blankDraft(''), ...result.draft });
    await Alpine.store('data').refresh();
    this.addIngredient(saved);
  },

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

  /**
   * Saving is all this sheet does. Logging happens from the meal's row, which
   * is where every other one-tap log in the app lives — a Log button here made
   * building a meal and eating one the same gesture, which they are not.
   */
  async saveMeal() {
    if (!this.canSaveMeal) return;

    const saved = await food.saveCombo(this.meal, this.email);
    this.closeMeal();
    this.term = '';
    await Alpine.store('data').refresh();
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

  online: { status: 'idle', results: [], error: '', term: '', unmatched: [] },

  get looksLikeBarcode() {
    return isBarcode(this.term.trim());
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

  /** A word nothing matched. Reads as "did you mean", without guessing at one. */
  get onlineUnmatched() {
    if (this.online.term !== this.term.trim()) return [];
    return this.online.unmatched ?? [];
  },

  /**
   * The one online search, used by the main field and the ingredient picker.
   *
   * Those had separate copies of the debounce, the generation guard and the
   * offline check. Two implementations of the same thing is how the picker ends
   * up behaving differently from the search above it, so `slot` names the state
   * property to write into and everything else is shared.
   *
   * Debounced so a network call isn't fired per keystroke, and generation-
   * guarded so a slow response for "ch" can't land on top of results for
   * "chicken".
   */
  queueSearch(slot, raw) {
    clearTimeout(this._timers[slot]);
    const term = raw.trim();
    const state = this[slot];

    // Already asked, or asking. Covers retyping the same word and the scanner,
    // which fires its own immediate lookup the instant it reads a code.
    if (term && term === state.term && state.status !== 'idle') return;

    // Two characters match half your foods; there is nothing useful to ask for.
    if (term.length < 3 && !isBarcode(term)) {
      this._gens[slot] = (this._gens[slot] ?? 0) + 1;
      this[slot] = { status: 'idle', results: [], error: '', term: '', unmatched: [] };
      return;
    }

    this._timers[slot] = setTimeout(() => this.runSearch(slot, term), 350);
  },

  async runSearch(slot, term) {
    if (!navigator.onLine) {
      this[slot] = { status: 'done', results: [], error: '', term, unmatched: [] };
      return;
    }

    const mine = (this._gens[slot] = (this._gens[slot] ?? 0) + 1);
    this[slot] = { status: 'searching', results: [], error: '', term, unmatched: [] };

    let next;
    try {
      next = isBarcode(term)
        ? await this.lookupByBarcode(term)
        : await this.lookupByName(term);
    } catch (e) {
      next = { results: [], error: e.message ?? String(e) };
    }

    if (mine !== this._gens[slot]) return;      // a newer search already started
    this[slot] = { status: 'done', ...next, term };
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

  /**
   * Both sources at once, merged into one ranked list.
   *
   * USDA's Branded set is manufacturer-submitted, so store brands are patchy —
   * Great Value milk simply is not in it. Open Food Facts is crowd-sourced and
   * covers exactly that gap, and its ODbL licence permits storing what it
   * returns, which is what makes it usable in a local-first app at all.
   *
   * Neither is allowed to take the other down: each is caught separately, and
   * one source failing still returns the other's results.
   */
  async lookupByName(term) {
    let data;
    try {
      const res = await supabase.functions.invoke('lookup-usda', { body: { query: term } });
      if (res.error) throw res.error;
      data = res.data;
    } catch (e) {
      return {
        results: [],
        unmatched: [],
        sources: { usda: 0, usdaError: e.message ?? String(e), off: 0, offFetched: 0, offError: 'not reached' },
        error: e.message ?? String(e),
      };
    }

    const usda = (data.results ?? []).map((r) => ({
      draft: r.draft,
      missing: r.missing ?? [],
      source: r.dataType ?? 'USDA',
    }));

    // Mapped here with the same code the barcode path uses, so serving basis and
    // sodium conversion cannot drift between the two.
    const offProducts = data.off ?? [];
    const off = draftsFromProducts(offProducts);

    // USDA first on a collision: its values are lab-measured or label-verified,
    // where OFF is whatever the last person to scan it typed in.
    const results = food.mergeDrafts([usda, off], term);

    return {
      results,
      // Only trust the typo hint when the word is missing from both sources.
      unmatched: (data.unmatched ?? []).filter(
        (t) => !off.some((r) => `${r.draft.name} ${r.draft.brand ?? ''}`.toLowerCase().includes(t)),
      ),
      // Which source produced what. Both failure modes are silent by design —
      // one source going down must not take the other with it — so without this
      // there is no way to tell a source that returned nothing from one that
      // never answered.
      sources: {
        usda: usda.length,
        usdaError: data.error ?? '',
        off: off.length,
        offFetched: offProducts.length,
        offError: data.offError ?? '',
      },
      error: results.length ? '' : (data.error ?? ''),
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

    // Immediately, not debounced: a scan is not a keystroke.
    await this.runSearch('online', code);
    if (this.online.term !== code) return;      // superseded while we waited

    const hit = this.online.results[0];

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

  /**
   * One photo, whichever kind of thing it turns out to be.
   *
   * A barcode is looked up; anything else is treated as a plate and estimated.
   * You should not have to decide which of those you are photographing before
   * you photograph it — the picture already says.
   *
   * Barcode first because it is cheap, local, and exact: if there is a code in
   * the frame the packet tells us what this is, and no estimate can beat that.
   */
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
    } catch {
      code = null;                         // not a barcode; the plate path may still work
    }

    if (code) {
      await this.acceptCode(code);
      return;
    }

    this.scan = { ...(this.scan ?? {}), status: 'reading', message: 'No barcode — reading the food…' };

    try {
      const result = await photo.estimateMeal(file);
      this.closeScanner();
      this.estimate = result;
    } catch (e) {
      this.scan = { ...(this.scan ?? {}), status: 'ready', message: e.message ?? String(e) };
      this.resumeDecoding();
    }
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
    this.draft.serving_size = size;
    this.draft.serving_size_unit = unit;
    this.draft.basis = `${size} ${unit}`;
    this.servingSize = '';
  },

  get draftBasis() { return food.basisLabel(this.draft); },

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
      serving_size: numeric(d.serving_size),
      serving_size_unit: (d.serving_size_unit ?? '').trim() || null,
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
  replacing: null,  // the group whose exercise is being swapped out; null = adding

  // A workout in progress otherwise fills the tab, so there is no way to look at
  // a routine or last week's numbers without finishing or discarding it. Folded
  // away it becomes one bar, and the rest of the tab comes back.
  collapsed: false,
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
        await Alpine.store('data').refreshTraining();
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
  get data() { return snapshotTraining(); },

  // Off the index, which resolved it once when the data was last refreshed.
  // Deriving it here meant a filter-and-sort over every session you have ever
  // logged, on every one of the dozens of reads a single render makes.
  get session() { return this.data.index.active; },
  get sets() { return this.session ? workout.setsOf(this.data.index, this.session.id) : []; },
  /**
   * Cards, each carrying what you did for that exercise last time.
   *
   * Attached here rather than looked up per row: `groups` is read once by the
   * x-for, whereas a getter called from inside the loop would rebuild the whole
   * lookup for every set on screen.
   */
  get groups() {
    return workout.groupByExercise(this.sets).map((group) => ({
      ...group,
      previous: this.data.prior.get(group.exerciseId ?? group.name)?.previous ?? [],
    }));
  },

  /** The greyed number in a row: that set last time, else the last one there was. */
  placeholderFor(group, index) {
    const previous = group.previous ?? [];
    return previous[index] ?? previous[previous.length - 1] ?? null;
  },

  /** The PREVIOUS column. Blank past what you actually did, rather than repeating. */
  previousLabel(group, index) {
    const set = (group.previous ?? [])[index];
    if (!set) return '';
    return `${set.weight_lb ?? '—'}lb × ${set.reps ?? '—'}`;
  },

  placeholderWeight(group, index) {
    const p = this.placeholderFor(group, index);
    return p?.weight_lb == null ? '' : String(p.weight_lb);
  },

  placeholderReps(group, index) {
    const p = this.placeholderFor(group, index);
    return p?.reps == null ? '' : String(p.reps);
  },
  get routines() { return workout.routinesFor(this.data.routines, this.email); },
  // `history` lives with the past-session code below, since it depends on
  // historyOwner rather than always meaning "mine".

  get elapsed() {
    this.tick;   // read so Alpine re-evaluates each second
    return this.session ? workout.elapsed(this.session.started_at) : '00:00';
  },

  get volume() { return Math.round(workout.volume(this.sets)); },

  // ---- session lifecycle ---------------------------------------------------

  async startEmpty() {
    await workout.startSession({ name: null, ownerEmail: this.email });
    await Alpine.store('data').refreshTraining();
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

      // As many sets as the routine plans. target_sets is recorded when a routine
      // is saved from a session or imported from Hevy; only a hand-built one
      // leaves it empty, and one set is the right floor for that.
      //
      // Deliberately empty. Last time's numbers show as placeholders instead, so
      // tapping a box gives you an empty field rather than a value to clear —
      // and checking the set without typing adopts them. See toggleDone.
      const planCount = Math.max(1, Number(item.target_sets) || 1);
      for (let n = 0; n < planCount; n++) {
        const { set } = await workout.addSet({
          session,
          exercise,
          weight: null,
          reps: null,
          isWarmup: false,
          ownerEmail: this.email,
          existingSets: existing,
        });
        existing = [...existing, set];
      }
    }

    await Alpine.store('data').refreshTraining();
  },

  /**
   * The routine this workout was started from, if it is still around.
   *
   * Null for an empty workout, and for one whose routine has since been
   * deleted — in both cases there is nothing to offer updating.
   */
  get startedFrom() {
    if (!this.session?.routine_id) return null;
    return this.routines.find((r) => r.id === this.session.routine_id) ?? null;
  },

  /** Off by default: a workout is usually a one-off, not a new plan. */
  updateRoutine: false,

  async finishSession() {
    const name = this.routineName.trim();
    const source = this.startedFrom;
    const rewriting = this.updateRoutine && source;

    if (name) {
      await workout.saveSessionAsRoutine({
        name, session: this.session, sets: this.data.sessionSets, ownerEmail: this.email,
      });
    }
    if (rewriting) {
      await workout.updateRoutineFromSession({
        routine: source,
        session: this.session,
        sets: this.data.sessionSets,
        ownerEmail: this.email,
        allRoutineExercises: this.data.routineExercises,
      });
    }

    await workout.finishSession(this.session);
    this.finishing = false;
    this.routineName = '';
    this.updateRoutine = false;
    this.endRest();
    await Alpine.store('data').refreshTraining();

    Alpine.store('ui').flash(
      name ? `Finished · saved “${name}”`
        : rewriting ? `Finished · updated “${source.name}”`
          : 'Workout finished',
    );
  },

  async discard() {
    await workout.discardSession(this.session, this.data.sessionSets);
    this.finishing = false;
    this.endRest();
    await Alpine.store('data').refreshTraining();
    Alpine.store('ui').flash('Workout discarded');
  },

  // ---- sets ----------------------------------------------------------------

  get library() {
    return workout.searchExercises(
      workout.libraryFor(this.data.exercises, this.email), this.pickerTerm,
    );
  },

  /**
   * The picker serves three callers — add, replace, and the routine builder —
   * so which one opened it has to be remembered while it is up.
   */
  openPicker(group = null) {
    this.replacing = group;
    this.pickerTerm = '';
    this.picker = true;
  },

  closePicker() {
    this.picker = false;
    this.replacing = null;
    this.pickerTerm = '';
  },

  async addExercise(exercise) {
    await workout.addSet({
      session: this.session, exercise, weight: null, reps: null,
      isWarmup: false, ownerEmail: this.email, existingSets: this.sets,
    });
    this.closePicker();
    await Alpine.store('data').refreshTraining();
  },

  /** Sets you have already done stay behind — see workout.replaceExercise. */
  async applyReplace(exercise) {
    const group = this.replacing;
    await workout.replaceExercise({
      session: this.session,
      group,
      exercise,
      prefill: this.data.prior.get(exercise.id ?? exercise.name)?.best ?? null,
      ownerEmail: this.email,
      existingSets: this.sets,
    });

    const kept = group.sets.some((s) => s.completed_at);
    this.closePicker();
    await Alpine.store('data').refreshTraining();
    Alpine.store('ui').flash(
      kept ? `Rest of ${group.name} → ${exercise.name}` : `${group.name} → ${exercise.name}`,
    );
  },

  /** Empty, like the planned sets — the placeholder carries the suggestion. */
  async addSetTo(group) {
    await workout.addSet({
      session: this.session,
      exercise: { id: group.exerciseId, name: group.name },
      weight: null,
      reps: null,
      isWarmup: false,
      ownerEmail: this.email,
      existingSets: this.sets,
    });
    await Alpine.store('data').refreshTraining();
  },

  /**
   * The set as it stands right now.
   *
   * Handlers close over the set object as it was when the row rendered, and by
   * the time one runs that copy can be a revision behind — typing reps fires
   * `change` and then the checkmark's `click`, and the click's copy predates the
   * reps. The in-memory index is the current truth, so read from that.
   */
  currentSet(set) {
    return this.sets.find((s) => s.id === set.id) ?? set;
  },

  async edit(set, field, value) {
    const next = { [field]: value === '' ? null : Number(value) };

    // Painted from memory first, persisted after. Three IndexedDB round trips
    // and a sync nudge sit inside updateSet, and none of them are the reason a
    // number appears in a box.
    //
    // What updateSet returns is deliberately thrown away. Its row is a snapshot
    // from whenever its own write ran, which can predate a later change: typing
    // reps and then checking the set made this one resolve holding
    // completed_at: null, and patching that in flicked the tick off and back on.
    // Memory is advanced only by the optimistic patches, which run synchronously
    // in event order and so can never go backwards; the serialised writes make
    // storage converge on the same thing.
    Alpine.store('data').patchSet({ ...this.currentSet(set), ...next });
    await workout.updateSet(set, next);
  },

  /**
   * Checking a set is what starts the rest clock — the moment you finish lifting.
   *
   * `fallback` is the greyed placeholder the row was showing. Checking a set you
   * never typed into means "yes, that again", so the placeholder becomes the
   * value — which is the whole point of them being placeholders rather than
   * prefilled text you would have to clear first.
   */
  toggleDone(set, fallback = null) {
    const done = Boolean(set.completed_at);
    const current = this.currentSet(set);
    const next = { completed_at: done ? null : new Date().toISOString() };

    // Adopted in the same object as the checkmark, so the numbers filling in and
    // the row going green are one patch and therefore one repaint. Setting them
    // separately showed as two steps.
    if (!done) {
      if (current.weight_lb == null && fallback?.weight_lb != null) next.weight_lb = fallback.weight_lb;
      if (current.reps == null && fallback?.reps != null) next.reps = fallback.reps;
    }

    const optimistic = { ...current, ...next };
    Alpine.store('data').patchSet(optimistic);

    if (!done) {
      this.startRest(workout.DEFAULT_REST_SECONDS);
      if (navigator.vibrate) navigator.vibrate(30);
      this.announceRecord(optimistic);
    }

    // Started, not awaited, so the handler returns and the frame paints. It was
    // briefly deferred to requestAnimationFrame instead, which was a mistake: a
    // backgrounded tab never gets a frame, so tapping the tick and switching
    // away would have dropped the write silently. Measured at 0.014 ms against
    // 6,000 stored sets, it was never worth moving off the path anyway.
    //
    // Result discarded for the reason given in edit(): a later-resolving write
    // can carry an older row, and patching it in is what made the tick flicker.
    // A failure still has to be said out loud, or the row on screen quietly
    // stops matching what is stored.
    workout.updateSet(set, next).catch((error) => {
      Alpine.store('ui').flash(`Could not save that set · ${error?.message ?? error}`);
    });
  },

  /**
   * Told at the moment it happens, not discovered in a stats screen weeks on.
   *
   * Split out because finding the set's card rebuilds every card, which is far
   * too much to do between a tap and the frame that answers it.
   */
  announceRecord(set) {
    const group = this.groups.find((g) => g.sets.some((s) => s.id === set.id));
    if (!group || !workout.isRecord(set, this.bestBefore(group))) return;

    Alpine.store('ui').flash(`PR · ${group.name}`);
    if (navigator.vibrate) navigator.vibrate([60, 50, 60]);
  },

  async dropSet(set) {
    await workout.removeSet(set.id);
    await Alpine.store('data').refreshTraining();
  },

  // ---- the exercise card's menu --------------------------------------------

  exMenu: null,   // the group whose menu is open

  openExMenu(group) { this.exMenu = group; },
  closeExMenu() { this.exMenu = null; },

  /** Reopens the picker in swap mode — see workout.replaceExercise. */
  replaceFromMenu() {
    const group = this.exMenu;
    this.closeExMenu();
    this.openPicker(group);
  },

  async addWarmupFromMenu() {
    const group = this.exMenu;
    this.closeExMenu();

    // Warm-ups start well under the working weight; half is the usual first
    // rung and is easier to correct than an empty box.
    const working = group.sets.find((s) => !s.is_warmup && s.weight_lb);
    await workout.addWarmupSet({
      session: this.session,
      group,
      exercise: { id: group.exerciseId, name: group.name },
      weight: working ? Math.round((Number(working.weight_lb) / 2) / 5) * 5 : null,
      ownerEmail: this.email,
      existingSets: this.sets,
    });
    await Alpine.store('data').refreshTraining();
  },

  async duplicateFromMenu() {
    const group = this.exMenu;
    this.closeExMenu();

    const made = await workout.duplicateExercise({
      session: this.session,
      group,
      ownerEmail: this.email,
      existingSets: this.sets,
    });
    await Alpine.store('data').refreshTraining();
    Alpine.store('ui').flash(`${made.length} more ${group.name}`);
  },

  async removeFromMenu() {
    const group = this.exMenu;
    this.closeExMenu();

    const count = await workout.removeExercise(group);
    await Alpine.store('data').refreshTraining();
    Alpine.store('ui').flash(`Removed ${group.name} · ${count} sets`);
  },

  /** Menu equivalent of dragging: one place up or down the card list. */
  async nudgeExercise(direction) {
    const group = this.exMenu;
    const groups = this.groups;
    const at = groups.findIndex((g) => g.key === group.key);
    const to = at + direction;
    if (at === -1 || to < 0 || to >= groups.length) return;

    this.closeExMenu();
    await this.reorderTo(group.key, to);
  },

  get exMenuIndex() {
    if (!this.exMenu) return -1;
    return this.groups.findIndex((g) => g.key === this.exMenu.key);
  },

  /**
   * Move a card to a position. Both the menu and the drag handle end here, so
   * there is one definition of what reordering means.
   */
  async reorderTo(key, toIndex) {
    const ordered = workout.orderGroups(this.groups, key, toIndex);
    await workout.reindexSets(ordered.flatMap((g) => g.sets));
    await Alpine.store('data').refreshTraining();
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

  // ---- idle-workout reminders ----------------------------------------------
  //
  // Server-sent, because the app cannot notice this itself: a backgrounded PWA
  // is suspended within moments, so no timer in the page survives long enough
  // to fire. See supabase/functions/notify-idle-workouts.

  reminders: 'unknown',   // 'unknown' | 'unsupported' | 'off' | 'on' | 'blocked'

  async loadReminderState() {
    if (!push.isSupported()) { this.reminders = 'unsupported'; return; }
    if (push.permission() === 'denied') { this.reminders = 'blocked'; return; }

    // Silently repairs a subscription bound to a key the server has rotated
    // away from. Best-effort: offline, this is not worth surfacing.
    try { await push.healSubscription(); } catch { /* reported by the toggle */ }

    this.reminders = (await push.isSubscribed()) ? 'on' : 'off';
  },

  /** Must run from the click: a permission prompt with no gesture is ignored. */
  async toggleReminders() {
    if (this.reminders === 'on') {
      await push.disable();
      this.reminders = 'off';
      Alpine.store('ui').flash('Reminders off');
      return;
    }

    const result = await push.enable();
    if (result === 'granted') {
      this.reminders = 'on';
      Alpine.store('ui').flash('Reminders on');
    } else if (result === 'denied') {
      // Not recoverable from script — the browser has to be told directly.
      this.reminders = 'blocked';
    }
  },

  get reminderLabel() {
    return {
      unknown: 'Idle-workout reminders',
      unsupported: 'Reminders not supported here',
      off: 'Remind me if I leave a workout running',
      on: 'Reminders on · tap to turn off',
      blocked: 'Notifications blocked in browser settings',
    }[this.reminders];
  },

  // ---- past sessions -------------------------------------------------------
  //
  // Whose history you are looking at. RLS already allows this both ways — the
  // policies on sessions and session_sets are can_read(), which honours
  // share_grants — so the other person's sessions are already in IndexedDB. All
  // that was missing was somewhere to look at them.

  past: null,        // a finished session being read back
  historyOwner: '',  // '' means you; set from the chips below

  /** You first, then anyone whose training you can see. */
  get trainingPeople() {
    const me = this.email;
    const label = (m) => m.display_name || (m.email ?? '').split('@')[0];

    return [
      { email: me, name: 'You' },
      ...Alpine.store('auth').members
        .filter((m) => m.email && m.email.toLowerCase() !== me.toLowerCase())
        .map((m) => ({ email: m.email, name: label(m) })),
    ];
  },

  get viewingOwner() { return this.historyOwner || this.email; },
  get viewingSelf() { return this.viewingOwner.toLowerCase() === this.email.toLowerCase(); },

  get history() {
    return workout.recentSessions(this.data.sessions, this.viewingOwner, 20);
  },

  openSession(session) { this.past = session; },
  closeSession() { this.past = null; },

  get pastIsMine() {
    return (this.past?.owner_email ?? '').toLowerCase() === this.email.toLowerCase();
  },

  get pastOwnerName() {
    const person = this.trainingPeople.find(
      (p) => p.email.toLowerCase() === (this.past?.owner_email ?? '').toLowerCase(),
    );
    return person?.name ?? this.past?.owner_email ?? '';
  },

  get pastGroups() {
    if (!this.past) return [];
    return workout.groupByExercise(workout.setsOf(this.data.index, this.past.id));
  },

  /** How long it ran. Sessions abandoned without finishing have no end. */
  sessionLength(session) {
    if (!session?.ended_at) return null;
    const minutes = Math.round(
      (new Date(session.ended_at) - new Date(session.started_at)) / 60_000,
    );
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  },

  /** "135 × 10, 135 × 8" for one exercise within a past session. */
  groupLine(group) {
    return group.sets
      .map((s) => `${s.weight_lb ?? '—'}×${s.reps ?? '—'}${s.is_warmup ? 'w' : ''}`)
      .join(', ');
  },

  async deleteRoutine(routine) {
    await workout.deleteRoutine(routine, this.data.routineExercises);
    await Alpine.store('data').refreshTraining();
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
    await Alpine.store('data').refreshTraining();
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
    await Alpine.store('data').refreshTraining();
  },

  async editRoutineItem(item, field, value) {
    await workout.updateRoutineExercise(item, {
      [field]: value === '' ? null : (field === 'target_reps' ? value : Number(value)),
    });
    await Alpine.store('data').refreshTraining();
  },

  async dropRoutineItem(item) {
    await workout.removeRoutineExercise(item.id);
    await Alpine.store('data').refreshTraining();
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

      await Alpine.store('data').refreshTraining();
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
    return exerciseArt(this.exerciseById(exerciseId), name);
  },

  /** The drawing for the detail sheet, or front and back together without one. */
  muscleMapPair(exerciseId, name) {
    return exerciseArtPair(this.exerciseById(exerciseId), name);
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

      await Alpine.store('data').refreshTraining();
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
    return exerciseArt(this.exerciseById(exerciseId), name);
  },

  /** The drawing for the detail sheet, or front and back together without one. */
  muscleMapPair(exerciseId, name) {
    return exerciseArtPair(this.exerciseById(exerciseId), name);
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
  get data() { return snapshotAll(); },

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
    await Alpine.store('data').refresh();
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
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Targets updated');
  },

  async saveNewPhase() {
    await food.startPhase(this.draft, this.goal, this.email);
    this.editing = false;
    await Alpine.store('data').refresh();
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
