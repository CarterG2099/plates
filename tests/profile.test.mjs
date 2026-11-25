/**
 * The top right of the app: a bell for notifications and reminders, and the
 * person's initial for their profile (who is signed in, the watch, sign out).
 * It used to be one name in small caps that opened everything in one sheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine } = await loadApp();
const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const html = await source('../docs/index.html');
const header = html.slice(html.indexOf('<header class="app-bar">'), html.indexOf('</header>'));
const sheetOf = (open) => {
  const at = html.indexOf(`<template x-if="$store.ui.${open}">`);
  assert.ok(at !== -1, `${open} sheet exists`);
  return html.slice(at, html.indexOf('\n      </template>', at));
};

// ---- the store --------------------------------------------------------------

test('the initial is the first letter of the display name, capitalised', () => {
  const auth = Alpine.store('auth');
  auth.session = { user: { email: 'cgividen20@gmail.com' } };
  auth.members = [{ email: 'cgividen20@gmail.com', display_name: ' carter' }];
  assert.equal(auth.initial, 'C');
});

test('with no display name it falls back to the email\'s first letter', () => {
  const auth = Alpine.store('auth');
  auth.session = { user: { email: 'andragividen@gmail.com' } };
  auth.members = [];
  assert.equal(auth.initial, 'A');
});

test('the profile opens on its own, with no old watch code showing', () => {
  const ui = Alpine.store('ui');
  ui.settingsOpen = false;
  ui.watchCode = '12345678';
  ui.openProfile();
  assert.equal(ui.profileOpen, true);
  assert.equal(ui.settingsOpen, false, 'not the notifications sheet as well');
  assert.equal(ui.watchCode, null);
  ui.profileOpen = false;
});

// ---- the markup -------------------------------------------------------------

test('the bar has a bell to notifications and the initial to whose day it is, not the name', () => {
  assert.match(header, /<button class="tap" @click="\$store\.ui\.openSettings\(\)" aria-label="Notifications">\s*<svg/);
  assert.match(header, /<button class="tap avatar" @click="\$store\.ui\.openWho\(\)"/);
  assert.match(header, /x-text="\$store\.ui\.viewInitial"/);
  assert.match(header, /`\$\{\$store\.auth\.displayName\}, switch person or profile`/,
    'a screen reader still hears whose it is');
  assert.doesNotMatch(header, /app-bar-meta/);
});

test('the bell sheet is notifications and reminders only', () => {
  const sheet = sheetOf('settingsOpen');
  assert.match(sheet, /<h2>Notifications<\/h2>/);
  assert.match(sheet, /On for this phone/);
  assert.match(sheet, /kindPicking = true/);
  assert.doesNotMatch(sheet, /pairWatch|signOut/);
});

test('the profile sheet has who you are, the watch, and sign out', () => {
  const sheet = sheetOf('profileOpen');
  assert.match(sheet, /<h2>Profile<\/h2>/);
  assert.match(sheet, /x-text="\$store\.auth\.displayName"/);
  assert.match(sheet, /x-text="\$store\.auth\.email"/);
  assert.match(sheet, /@click="\$store\.ui\.pairWatch\(\)"/);
  assert.match(sheet, /x-text="\$store\.ui\.watchCodeText"/);
  assert.match(sheet, /@click="\$store\.auth\.signOut\(\)"/);
  assert.doesNotMatch(sheet, /reminderList/);
});

test('the initial is styled over .tap, which loads later in pages.css', async () => {
  const css = await source('../docs/css/base.css');
  assert.match(css, /\.tap\.avatar \{[^}]*color: var\(--color-text\)/,
    'a lone .avatar loses to .tap and the letter goes muted and oversized');
  assert.match(css, /\.app-bar:has\(> \.app-bar-actions\) \{\s*align-items: center;/);
});

// ---- the version ----------------------------------------------------------------

test('the profile says which version this phone is running, from the service worker cache', async () => {
  const ui = Alpine.store('ui');
  const original = globalThis.caches;
  try {
    globalThis.caches = { keys: async () => ['plates-v236', 'plates-v237', 'plates-photos', 'other-v900'] };
    await ui.loadVersion();
    assert.equal(ui.appVersion, '237', 'the newest Plates cache, while an old one is being cleared');

    globalThis.caches = { keys: async () => [] };
    await ui.loadVersion();
    assert.equal(ui.appVersion, '', 'no cache yet: nothing to say');

    globalThis.caches = undefined;
    await ui.loadVersion();
    assert.equal(ui.appVersion, '', 'no cache storage at all');
  } finally {
    globalThis.caches = original;
  }
});

test('the version line sits under Sign out, and opening the profile reads it', async () => {
  const sw = await source('../docs/sw.js');
  assert.match(sw, /const CACHE_VERSION = 'plates-v\d+';/, 'the cache name the line reads');
  assert.match(html, /@click="\$store\.auth\.signOut\(\)">Sign out<\/button>\s*<p class="setting-meta app-version" x-show="\$store\.ui\.appVersion" x-text="`Version \$\{\$store\.ui\.appVersion\}`"><\/p>/);
  const ui = Alpine.store('ui');
  let read = false;
  const real = ui.loadVersion;
  ui.loadVersion = async () => { read = true; };
  try { ui.openProfile(); } finally { ui.loadVersion = real; ui.profileOpen = false; }
  assert.equal(read, true);
});
