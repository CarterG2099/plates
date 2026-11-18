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

test('the bar has a bell to notifications and the initial to the profile, not the name', () => {
  assert.match(header, /<button class="tap" @click="\$store\.ui\.openSettings\(\)" aria-label="Notifications">\s*<svg/);
  assert.match(header, /<button class="tap avatar" @click="\$store\.ui\.openProfile\(\)"/);
  assert.match(header, /x-text="\$store\.auth\.initial"/);
  assert.match(header, /:aria-label="`Profile, \$\{\$store\.auth\.displayName\}`"/,
    'a screen reader still hears whose profile it is');
  assert.doesNotMatch(header, /app-bar-meta/);
});

test('the bell sheet is notifications and reminders only', () => {
  const sheet = sheetOf('settingsOpen');
  assert.match(sheet, /<h2>Notifications<\/h2>/);
  assert.match(sheet, /Push notifications/);
  assert.match(sheet, /newReminder\('meds'\)/);
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
