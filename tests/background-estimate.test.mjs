/**
 * An AI estimate whose sheet is closed while it runs finishes anyway, waits,
 * and opens where it would have opened.
 *
 * app.js registers Alpine components at import and cannot be loaded here, so
 * these read its source the way the other component tests do: they pin the
 * handful of lines that make the difference between "kept" and "thrown away".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const app = await source('../docs/js/app.js');
const html = await source('../docs/index.html');

const fn = (name) => {
  const start = app.indexOf(`  ${name}`);
  assert.ok(start > -1, `${name} is missing`);
  return app.slice(start, app.indexOf('\n  },\n', start));
};

test('a photo estimate whose sheet was closed is kept, not dropped', () => {
  const body = fn('async readMealPhoto() {');
  assert.match(body, /if \(this\.mealPhoto !== pending\) \{\s*this\.keepForLater\(result, pending\.target, pending\.note \|\| 'Your photo'\);/);
  assert.doesNotMatch(body, /if \(this\.mealPhoto !== pending\) return;/, 'the old silent drop');
});

test('a described meal whose sheet was closed is kept, not dropped', () => {
  const body = fn('async readDescription() {');
  assert.match(body, /if \(this\.describing !== pending\) \{\s*this\.keepForLater\(result, 'estimate', pending\.text\);/);
  assert.doesNotMatch(body, /if \(this\.describing !== pending\) return;/);
});

test('a failure after the sheet has gone is said out loud', () => {
  for (const name of ['async readMealPhoto() {', 'async readDescription() {']) {
    assert.match(fn(name), /Alpine\.store\('ui'\)\.flash\(`Estimate failed · \$\{e\.message \?\? e\}`\)/, name);
  }
});

test('the running banner clears however the estimate ends', () => {
  for (const name of ['async readMealPhoto() {', 'async readDescription() {']) {
    assert.match(fn(name), /finally \{[\s\S]*?Alpine\.store\('ui'\)\.estimatingAway = '';/, name);
  }
});

test('closing either sheet mid-estimate raises the running banner', () => {
  assert.match(fn('closeMealPhoto() {'), /this\.noteRunningAway\(/);
  assert.match(fn('closeDescribe() {'), /this\.noteRunningAway\(/);
  assert.match(fn('noteRunningAway(label) {'), /this\.photoBusy === 'meal' \|\| this\.photoBusy === 'describe'/);
});

test('the kept result is stored with whose it is, and reopened in the right place', () => {
  assert.match(fn('keepForLater(result, target, label) {'), /owner: this\.email/);
  assert.match(app, /return r && r\.owner === Alpine\.store\('auth'\)\.email \? r : null;/);
  assert.match(app, /if \(ready\.target === 'meal'\) this\.mealFromEstimate\(ready\.result\);\s*else this\.estimate = ready\.result;/);
});

test('it survives closing the app, for a day', () => {
  assert.match(app, /const READY_ESTIMATE_MAX_MS = 24 \* 3600_000;/);
  assert.match(app, /if \(Date\.now\(\) - Date\.parse\(saved\.at\) > READY_ESTIMATE_MAX_MS\) return null;/);
  assert.match(app, /readyEstimate: readReadyEstimate\(\),/);
});

test('Today shows the running and ready banners, with review and discard', () => {
  assert.match(html, /class="estimate-banner" x-show="\$store\.ui\.estimatingAway"/);
  assert.match(html, /class="estimate-banner is-ready" x-show="!\$store\.ui\.estimatingAway && \$store\.ui\.myReadyEstimate"/);
  assert.match(html, /@click="\$store\.ui\.reviewEstimate\(\)"/);
  assert.match(html, /@click="\$store\.ui\.dropReadyEstimate\(\)"/);
});

test('banner labels are one line', () => {
  // shortLabel, copied out of app.js and run.
  const src = app.slice(app.indexOf('function shortLabel(text) {'), app.indexOf('\n}\n', app.indexOf('function shortLabel(text) {')) + 2);
  const shortLabel = new Function(`${src}; return shortLabel;`)();
  assert.equal(shortLabel('  two   eggs\nand toast '), 'two eggs and toast');
  const long = shortLabel('a'.repeat(100));
  assert.equal(long.length, 58);
  assert.ok(long.endsWith('…'));
});
