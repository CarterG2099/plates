/**
 * The checkmark on a set, driven through the real Train screen code in app.js.
 *
 * The tick paints from memory and is written to IndexedDB behind it. A full
 * refresh — which a sync runs whenever the pull brought anything, so whenever
 * the other person logs something — re-reads every store, and a read that began
 * before the tick's write landed carries the row without it. Assigning that
 * over memory took the tick back off the screen until the next refresh, which
 * is what tapping the check and watching it go grey again was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';
import { reset } from './helpers/fake-idb.mjs';

installBrowser();

// The rest of the browser Alpine itself touches on import. Nothing here mounts
// a DOM; the stores and the Train component are driven directly.
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.Element = window.Element = class {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.history = window.history = { state: null, replaceState() {}, pushState() {}, back() {} };

const Alpine = (await import('../docs/js/vendor/alpine.esm.js')).default;
Alpine.start = () => {};
const components = {};
const register = Alpine.data;
Alpine.data = (name, factory) => { components[name] = factory; return register(name, factory); };

await import('../docs/js/app.js');
const local = await import('../docs/js/local.js');

const ME = 'me@example.com';
const STARTED = '2026-10-15T10:00:00.000Z';

async function workoutWithOneSet() {
  reset();
  navigator.onLine = false;   // the sync nudge after each write stays out of it
  Alpine.store('auth').session = { user: { email: ME } };

  const session = await local.save('sessions', { name: 'Push', started_at: STARTED, ended_at: null }, ME);
  const set = await local.save('session_sets', {
    session_id: session.id, exercise_id: null, exercise_name: 'Bench Press',
    set_index: 0, weight_lb: 135, reps: 8, completed_at: null, is_warmup: false,
  }, ME);

  await Alpine.store('data').refreshTraining();
  const train = Alpine.reactive(components.trainPage());
  return { train, set: train.sets.find((s) => s.id === set.id) };
}

/** Until every queued write has landed, so storage is what memory says. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a tick shows straight away', async () => {
  const { train, set } = await workoutWithOneSet();
  train.toggleDone(set);
  assert.ok(train.currentSet(set).completed_at);
});

test('a refresh already reading when the tick lands does not take the tick back off', async () => {
  const { train, set } = await workoutWithOneSet();

  const refreshing = Alpine.store('data').refreshTraining();   // a sync brought something in
  train.toggleDone(set);
  await refreshing;

  assert.ok(train.currentSet(set).completed_at, 'the set went back to unticked');
  await settle();
  assert.ok((await local.get('session_sets', set.id)).completed_at, 'and storage has it too');
});

test('an untick is not undone by a refresh in flight either', async () => {
  const { train, set } = await workoutWithOneSet();
  train.toggleDone(set);
  await settle();
  await Alpine.store('data').refreshTraining();

  const refreshing = Alpine.store('data').refreshTraining();
  train.toggleDone(train.currentSet(set));
  await refreshing;

  assert.equal(train.currentSet(set).completed_at, null);
});

test('a refresh that starts after the tick shows what was stored', async () => {
  const { train, set } = await workoutWithOneSet();
  train.toggleDone(set);
  await settle();
  await Alpine.store('data').refreshTraining();
  assert.ok(train.currentSet(set).completed_at);
});

test('a tap on a row holding an older copy of the set goes by what the screen shows', async () => {
  const { train, set } = await workoutWithOneSet();
  const rendered = set;   // the row's copy, from before the tick
  train.toggleDone(set);

  // The row is green, so a second tap means untick — not tick it again.
  train.toggleDone(rendered);
  assert.equal(train.currentSet(set).completed_at, null);
});
