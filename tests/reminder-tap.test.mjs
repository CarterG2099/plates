/**
 * Tapping a reminder notification that can be checked off opens Plates on the
 * Notifications sheet, where its Taken button is. iPhone shows no buttons on a
 * web app's notification, so this tap is the only way to Taken there.
 *
 * The service worker's own click handler is run here, from docs/sw.js, against
 * a stand-in for the browser's clients.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine } = await loadApp();
const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const swSource = await source('../docs/sw.js');

const TAKEN = { url: 'https://x.supabase.co/functions/v1/reminder-taken', token: 't'.repeat(40) };

/** Fire one notification click at a fresh copy of sw.js; report what it did. */
async function click({ data, action = '', open = [] }) {
  const listeners = {};
  const did = { opened: [], focused: [], messages: [], fetched: [] };
  const windows = open.map((url) => ({
    url,
    focus: async () => { did.focused.push(url); },
    postMessage: (m) => { did.messages.push([url, m]); },
  }));
  const self = {
    location: { origin: 'https://plates.cartergividen.com' },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { did.opened.push(url); },
    },
  };
  vm.runInNewContext(swSource, {
    self, URL, console,
    fetch: async (url) => { did.fetched.push(url); return { ok: false, status: 500 }; },
    caches: {},
  });
  let work;
  listeners.notificationclick({
    action,
    notification: { data, close() {} },
    waitUntil: (p) => { work = p; },
  });
  await work;
  return did;
}

test('a tapped med reminder opens the app on the reminders', async () => {
  const did = await click({ data: { url: '/#today', taken: TAKEN } });
  assert.deepEqual(did.opened, ['/#reminders']);
  assert.deepEqual(did.fetched, [], 'a tap is not a Taken: nothing is marked');
});

test('with the app already open, it comes forward and is told to show them', async () => {
  const did = await click({ data: { url: '/#today', taken: TAKEN }, open: ['https://plates.cartergividen.com/'] });
  assert.deepEqual(did.focused, ['https://plates.cartergividen.com/']);
  assert.deepEqual(did.messages, [['https://plates.cartergividen.com/', 'open-reminders']]);
  assert.deepEqual(did.opened, []);
});

test('a notification with nothing to check off still goes where it always did', async () => {
  const did = await click({ data: { url: '/#train', taken: null } });
  assert.deepEqual(did.opened, ['/#train']);

  const open = await click({ data: { url: '/#train', taken: null }, open: ['https://plates.cartergividen.com/'] });
  assert.deepEqual(open.messages, [], 'an open window is only brought forward');
});

test('Taken that fails to record opens the reminders, where the button is', async () => {
  const did = await click({ data: { url: '/#today', taken: TAKEN }, action: 'taken' });
  assert.deepEqual(did.fetched, [TAKEN.url]);
  assert.deepEqual(did.opened, ['/#reminders']);
});

// ---- the app's side -----------------------------------------------------------

test('#reminders opens the Notifications sheet; anything else does not', () => {
  const ui = Alpine.store('ui');
  ui.settingsOpen = false;
  assert.equal(ui.openLink('#today'), false);
  assert.equal(ui.openLink(''), false);
  assert.equal(ui.settingsOpen, false);

  assert.equal(ui.openLink('#reminders'), true);
  assert.equal(ui.settingsOpen, true);
  ui.settingsOpen = false;
});

test('the app reads the link on start and listens for an open window being told', async () => {
  const app = await source('../docs/js/app.js');
  assert.match(app, /if \(this\.isMember && Alpine\.store\('ui'\)\.openLink\(globalThis\.location\?\.hash\)\) \{\s*history\.replaceState\(null, '', location\.pathname \+ location\.search\);/);
  assert.match(app, /navigator\.serviceWorker\.addEventListener\('message', \(event\) => \{\s*if \(event\.data === 'open-reminders'\) Alpine\.store\('ui'\)\.openLink\('#reminders'\);/);
});
