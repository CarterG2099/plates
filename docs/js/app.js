/**
 * app.js — Alpine stores and the shell.
 *
 * Phase 1 only: sign in, prove membership, prove the sync loop runs. The food
 * and workout screens come next and will read from local.js, never the network.
 */

import Alpine from './vendor/alpine.esm.js';
import { supabase, signIn, signOut, loadMembership, describeError } from './supabase.js';
import * as local from './local.js';
import * as sync from './sync.js';

Alpine.store('auth', {
  ready: false,
  session: null,
  isMember: false,
  isAdmin: false,
  members: [],
  error: '',

  get email() {
    return this.session?.user?.email ?? '';
  },

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

    if (isMember) sync.start();
  },

  signIn() {
    return signIn().catch((e) => { this.error = e.message; });
  },

  async signOut() {
    // Wipe local data: this is a phone that might be handed to someone else.
    await local.wipe();
    await signOut();
  },
});

Alpine.store('sync', {
  online: navigator.onLine,
  status: 'idle',
  pending: 0,
  lastSyncedAt: null,
  error: null,

  init() {
    sync.subscribe((s) => Object.assign(this, s));
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

/** Counts straight out of IndexedDB — proof the local store is real. */
Alpine.data('localSummary', () => ({
  counts: {},
  loading: true,

  async init() {
    await this.refresh();
    // Cheap enough to just re-read whenever the tab regains focus.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh();
    });
  },

  async refresh() {
    const counts = {};
    for (const table of local.TABLES) {
      counts[table] = (await local.all(table)).length;
    }
    this.counts = counts;
    this.loading = false;
  },

  get rows() {
    return Object.entries(this.counts).map(([table, count]) => ({ table, count }));
  },

  syncNow() {
    return sync.sync().then(() => this.refresh());
  },
}));

Alpine.store('auth').init();
Alpine.store('sync').init();

window.Alpine = Alpine;
Alpine.start();
