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

// ---- auth ------------------------------------------------------------------

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
    await this.apply(data.session ?? null);
    supabase.auth.onAuthStateChange((_event, session) => this.apply(session ?? null));
    this.ready = true;
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
      await Alpine.store('data').refresh();
      sync.start();
    }
  },

  signIn() { return signIn().catch((e) => { this.error = e.message; }); },

  async signOut() {
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

Alpine.store('data', {
  ready: false,
  goals: [],
  foods: [],
  log: [],
  combos: [],
  templates: [],
  exercises: [],
  routines: [],
  routineExercises: [],
  sessions: [],
  sessionSets: [],

  async refresh() {
    const [goals, foods, log, combos, templates,
           exercises, routines, routineExercises, sessions, sessionSets] = await Promise.all([
      local.all('goals'),
      local.all('foods'),
      local.all('food_log'),
      local.all('meal_combos'),
      local.all('day_templates'),
      local.all('exercises'),
      local.all('routines'),
      local.all('routine_exercises'),
      local.all('sessions'),
      local.all('session_sets'),
    ]);
    this.goals = goals;
    this.foods = foods;
    this.log = log;
    this.combos = combos;
    this.templates = templates;
    this.exercises = exercises;
    this.routines = routines;
    this.routineExercises = routineExercises;
    this.sessions = sessions;
    this.sessionSets = sessionSets;
    this.ready = true;
  },
});

// ---- ui --------------------------------------------------------------------

Alpine.store('ui', {
  view: 'today',
  // The day being viewed and written to. Logging is always "to this date", which
  // is what makes meal prep work without a separate planning mode.
  viewDate: food.toDateOnly(new Date()),
  logOpen: false,
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

  get goal() {
    return food.currentGoal(Alpine.store('data').goals, this.email, this.date);
  },

  get entries() {
    return food.entriesForDay(Alpine.store('data').log, this.email, this.date);
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

  get templates() { return Alpine.store('data').templates; },

  /** Cook once, eat for the next N days. */
  async copyForward() {
    const targets = Array.from({ length: this.copyCount }, (_, i) => food.addDays(this.date, i + 1));
    const rows = await food.copyDay({
      log: Alpine.store('data').log,
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
      log: Alpine.store('data').log,
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

/** One shape for the food form, whether typed by hand or filled from a lookup. */
function blankDraft(name = '') {
  return {
    name,
    brand: '',
    barcode: null,
    serving_qty: 100,
    serving_unit: 'g',
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
  filter: 'frequent',
  sheet: null,      // { food, quantity, unit }
  creating: false,
  draft: null,

  init() {
    // Today's camera button raises this flag; the panel it opens is where the
    // scanner actually lives.
    this.$watch(() => Alpine.store('ui').scanRequested, (wanted) => {
      if (!wanted) return;
      Alpine.store('ui').scanRequested = false;
      this.openScanner();
    });
  },

  get email() { return Alpine.store('auth').email; },

  get ranked() {
    return food.rankFoods(Alpine.store('data').foods, Alpine.store('data').log, this.email);
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

  get combos() { return Alpine.store('data').combos; },

  get date() { return Alpine.store('ui').date; },
  get mealSlot() { return food.inferMealSlot(); },

  /** The one-tap path: log at the amount you last used for this food. */
  async quickLog(item) {
    const quantity = item.lastQuantity ?? item.serving_qty ?? 1;
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
    return food.countLoggedToday(Alpine.store('data').log, this.email, item.id, this.date);
  },

  /**
   * Exact inverse of the + button: takes back the most recent log of this food.
   * A mis-tap should be fixable where it happened, not by navigating to Today
   * and hunting for the row.
   */
  async undoLast(item) {
    const entry = food.lastEntryForFood(Alpine.store('data').log, this.email, item.id, this.date);
    if (!entry) return;

    await food.deleteEntry(entry.id);
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash(`Removed ${item.name}`);
  },

  openSheet(item) {
    this.sheet = {
      food: item,
      quantity: item.lastQuantity ?? item.serving_qty ?? 1,
      unit: item.lastUnit ?? item.serving_unit ?? 'g',
      prefilled: item.lastQuantity != null,
    };
  },

  closeSheet() { this.sheet = null; },

  step(delta) {
    const next = Number(this.sheet.quantity) + delta;
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
    const { food: item, quantity, unit } = this.sheet;
    await food.logFood({ food: item, quantity, unit, ownerEmail: this.email, date: this.date });
    this.closeSheet();
    await Alpine.store('data').refresh();
    Alpine.store('ui').flash('Logged');
  },

  async logCombo(combo) {
    const byId = new Map(Alpine.store('data').foods.map((f) => [f.id, f]));
    const rows = await food.logCombo({ combo, foodsById: byId, ownerEmail: this.email, date: this.date });
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
  // The cold path, for foods you've never eaten. Barcodes go to Open Food Facts
  // straight from the browser; names go to USDA through the Edge Function, which
  // holds the key. Either way the result is a draft you review, never a silent
  // write — OFF is crowd-sourced and USDA's name matching is loose.

  lookup: null,   // { status, results, error }

  get looksLikeBarcode() {
    return /^\d{8,14}$/.test(this.term.trim());
  },

  async searchOnline() {
    const term = this.term.trim();
    if (!term) return;

    this.lookup = { status: 'searching', results: [], error: '' };

    try {
      if (this.looksLikeBarcode) {
        const r = await lookupBarcode(term);

        if (r.status === 'found') {
          this.lookup = {
            status: 'done',
            results: [{ draft: r.draft, missing: r.missing, source: 'Open Food Facts' }],
            error: '',
          };
        } else {
          this.lookup = {
            status: 'done',
            results: [],
            error: {
              not_found: 'No product with that barcode. Try the name, or add it by hand.',
              offline: 'Offline — lookup needs a connection. You can still add it by hand.',
            }[r.status] ?? r.message ?? 'Lookup failed.',
          };
        }
      } else {
        const { data, error } = await supabase.functions.invoke('lookup-usda', { body: { query: term } });
        if (error) throw error;

        this.lookup = {
          status: 'done',
          results: (data.results ?? []).map((r) => ({
            draft: r.draft,
            missing: r.missing ?? [],
            source: r.dataType ?? 'USDA',
          })),
          error: data.error ?? '',
        };
      }
    } catch (e) {
      this.lookup = { status: 'done', results: [], error: e.message ?? String(e) };
    }
  },

  closeLookup() { this.lookup = null; },

  // ---- scanner -------------------------------------------------------------

  scan: null,   // { status, message, decoder }

  get canScan() { return scanner.isSupported(); },

  async openScanner() {
    this.scan = { status: 'starting', message: '', decoder: '' };

    // The template renders on the next tick; the video element must exist first.
    await new Promise((r) => requestAnimationFrame(r));
    const video = this.$refs.video;

    const result = await scanner.start(video);
    this.scan = result.ok
      ? { status: 'ready', message: '', decoder: result.decoder }
      : { status: 'error', message: result.reason, decoder: '' };
  },

  closeScanner() {
    scanner.stop(this.$refs.video);
    this.scan = null;
  },

  /** One tap, one frame. A miss says so and lets you try again. */
  async captureBarcode() {
    if (this.scan?.status !== 'ready') return;
    this.scan.status = 'reading';

    let code = null;
    try {
      code = await scanner.capture(this.$refs.video);
    } catch (e) {
      this.scan = { status: 'error', message: e.message, decoder: '' };
      return;
    }

    if (!code) {
      this.scan.status = 'ready';
      this.scan.message = 'No barcode in that shot — fill the frame and try again.';
      return;
    }

    if (navigator.vibrate) navigator.vibrate(40);
    this.closeScanner();

    // Hand straight to the existing lookup path: same results sheet, same
    // review form, same manual fallback.
    this.term = code;
    await this.searchOnline();
  },

  /** Pull a looked-up result into the same review form manual entry uses. */
  acceptLookup(result) {
    this.draft = { ...blankDraft(''), ...result.draft };
    this.creating = true;
    this.lookup = null;
  },

  cancelCreate() { this.creating = false; this.draft = null; },

  get canSaveDraft() {
    return this.draft?.name?.trim() && Number(this.draft.serving_qty) > 0;
  },

  async saveDraft() {
    const d = this.draft;
    const numeric = (v) => (v === '' || v == null ? null : Number(v));

    const saved = await food.saveFood({
      name: d.name.trim(),
      brand: (d.brand ?? '').trim() || null,
      // No external_id here: plates.foods has no such column. The barcode is the
      // provenance that matters, and a USDA fdcId with nowhere to live would
      // write to IndexedDB happily and then fail on sync.
      barcode: d.barcode || null,
      serving_qty: Number(d.serving_qty),
      serving_unit: d.serving_unit.trim() || 'g',
      calories: numeric(d.calories),
      protein_g: numeric(d.protein_g),
      carbs_g: numeric(d.carbs_g),
      fat_g: numeric(d.fat_g),
      fiber_g: numeric(d.fiber_g),
      sodium_mg: numeric(d.sodium_mg),
      source: d.source ?? 'manual',
    }, this.email);

    this.cancelCreate();
    this.term = '';
    await Alpine.store('data').refresh();

    // Straight into the quantity sheet — you added it because you're eating it.
    this.openSheet({ ...saved, lastQuantity: null, lastUnit: null });
  },
}));

// ---- boot ------------------------------------------------------------------

// ---- train -----------------------------------------------------------------

Alpine.data('trainPage', () => ({
  picker: false,
  pickerTerm: '',
  finishing: false,
  routineName: '',
  restEndsAt: null,
  restLeft: 0,
  tick: 0,          // bumped by an interval so the timers re-render

  init() {
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
  get data() { return Alpine.store('data'); },

  get session() { return workout.activeSession(this.data.sessions, this.email); },
  get sets() { return this.session ? workout.setsForSession(this.data.sessionSets, this.session.id) : []; },
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

      for (let i = 0; i < (item.target_sets || 1); i++) {
        const { set } = await workout.addSet({
          session,
          exercise,
          weight: item.target_weight_lb,
          reps: item.target_reps ? Number(item.target_reps) : null,
          isWarmup: false,
          ownerEmail: this.email,
          existingSets: existing,
        });
        existing = [...existing, set];
      }
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
    }
  },

  async dropSet(set) {
    await workout.removeSet(set.id);
    await this.data.refresh();
  },

  previous(group) {
    const p = workout.lastPerformance(
      this.data.sessionSets, this.data.sessions, this.email,
      group.exerciseId, group.name, this.session?.id,
    );
    if (!p?.best) return null;
    return `${p.best.weight_lb ?? '—'} lb × ${p.best.reps ?? '—'}`;
  },

  oneRm(set) { return workout.estimate1RM(set.weight_lb, set.reps); },

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
    const sets = workout.setsForSession(this.data.sessionSets, session.id);
    const groups = workout.groupByExercise(sets);
    return `${groups.length} exercises · ${Math.round(workout.volume(sets)).toLocaleString()} lb`;
  },

  async deleteRoutine(routine) {
    await workout.deleteRoutine(routine, this.data.routineExercises);
    await this.data.refresh();
    Alpine.store('ui').flash('Routine deleted');
  },

  // ---- routine builder -----------------------------------------------------

  builder: null,   // { routine, name } — null when closed

  newRoutine() { this.builder = { routine: null, name: '' }; },

  editRoutine(routine) { this.builder = { routine, name: routine.name }; },

  closeBuilder() { this.builder = null; },

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

  // ---- demonstration images ------------------------------------------------

  imageImport: null,

  imageFor(exercise) { return workout.imageFor(exercise); },

  exerciseById(id) { return this.data.exercises.find((e) => e.id === id) ?? null; },

  get imagesMissing() {
    return workout.libraryFor(this.data.exercises, this.email)
      .filter((e) => !(e.image_urls ?? []).length).length;
  },

  /** Fires and forgets: the screen stays usable while it works through the list. */
  async loadImages() {
    this.imageImport = { status: 'fetching', matched: 0, total: 0, done: 0 };
    try {
      await workout.importExerciseImages(
        this.data.exercises, this.email, (p) => { this.imageImport = p; },
      );
      await this.data.refresh();
      Alpine.store('ui').flash(`Images added to ${this.imageImport.matched} exercises`);
    } catch (e) {
      this.imageImport = { status: 'error', message: e.message };
    }
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

window.Alpine = Alpine;

// Console handle for poking at things during development. The client only ever
// holds the publishable key, so this exposes nothing the page didn't already ship.
window.plates = { supabase, local, sync, food };

Alpine.start();
