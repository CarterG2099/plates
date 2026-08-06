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

  async refresh() {
    const [goals, foods, log, combos, templates] = await Promise.all([
      local.all('goals'),
      local.all('foods'),
      local.all('food_log'),
      local.all('meal_combos'),
      local.all('day_templates'),
    ]);
    this.goals = goals;
    this.foods = foods;
    this.log = log;
    this.combos = combos;
    this.templates = templates;
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

window.Alpine = Alpine;

// Console handle for poking at things during development. The client only ever
// holds the publishable key, so this exposes nothing the page didn't already ship.
window.plates = { supabase, local, sync, food };

Alpine.start();
