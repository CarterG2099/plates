/**
 * The phone's back gesture steps back through the app instead of closing it.
 *
 * Driven against a fake History that behaves like the real one where it matters:
 * pushState drops anything forward of the current entry, go() moves and fires
 * popstate, and going back past the first entry is the app closing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { backStack, topBackdrop } from '../docs/js/back.js';

/** An app with `open` layers and a current tab, and a History to go with it. */
function harness({ view = 'today' } = {}) {
  const app = { open: 0, view, closed: 0, left: false };
  const entries = [];
  let at = -1;
  let stack;

  const history = {
    replaceState(state) { entries[Math.max(at, 0)] = state; at = Math.max(at, 0); },
    pushState(state) { entries.splice(at + 1); entries.push(state); at += 1; },
    go(n) {
      if (at + n < 0) { app.left = true; return; }
      at += n;
      stack.onPop({ state: entries[at] });
    },
    back() { this.go(-1); },
  };

  stack = backStack({
    history,
    layers: () => app.open,
    closeTop: () => {
      // Like a click on the backdrop: the sheet goes, and the DOM change
      // reaches sync() just as the MutationObserver would deliver it.
      app.open -= 1;
      app.closed += 1;
      stack.sync();
    },
    getView: () => app.view,
    setView: (v) => { app.view = v; stack.sync(); },
  });

  const open = () => { app.open += 1; stack.sync(); };
  const closeByHand = () => { app.open -= 1; stack.sync(); };
  const tab = (v) => { app.view = v; stack.sync(); };
  const back = () => history.back();

  return { app, stack, open, closeByHand, tab, back, entries: () => entries.slice(0, at + 1) };
}

test('back closes an open sheet and stays in the app', () => {
  const h = harness();
  h.open();
  h.back();
  assert.equal(h.app.open, 0);
  assert.equal(h.app.closed, 1);
  assert.equal(h.app.left, false);
});

test('a sheet on a sheet closes one at a time', () => {
  const h = harness();
  h.open();
  h.open();
  h.back();
  assert.equal(h.app.open, 1, 'the top one only');
  h.back();
  assert.equal(h.app.open, 0);
  assert.equal(h.app.left, false);
});

test('back returns to the previous tab', () => {
  const h = harness();
  h.tab('train');
  h.tab('stats');
  h.back();
  assert.equal(h.app.view, 'train');
  h.back();
  assert.equal(h.app.view, 'today');
  assert.equal(h.app.left, false);
});

test('only back from Today with nothing open leaves the app', () => {
  const h = harness();
  h.tab('train');
  h.open();
  h.back();                     // closes the sheet
  h.back();                     // back to Today
  assert.equal(h.app.left, false);
  h.back();                     // and now out
  assert.equal(h.app.left, true);
});

test('a sheet open on a tab closes before the tab changes back', () => {
  const h = harness();
  h.tab('stats');
  h.open();
  h.back();
  assert.equal(h.app.open, 0);
  assert.equal(h.app.view, 'stats', 'still on Stats');
  h.back();
  assert.equal(h.app.view, 'today');
});

test('a sheet closed by its own button takes its history entry with it', () => {
  const h = harness();
  h.tab('train');
  h.open();
  h.closeByHand();
  assert.equal(h.app.closed, 0, 'nothing closed by the history pop it caused');
  assert.deepEqual(h.entries().map((e) => e.layers), [0, 0], 'the sheet\'s entry is gone');
  h.back();
  assert.equal(h.app.view, 'today', 'one press, not two, to leave Train');
});

test('two sheets closed together by hand go in one step', () => {
  const h = harness();
  h.open();
  h.open();
  h.app.open = 0;
  h.stack.sync();
  assert.equal(h.entries().length, 1);
  assert.equal(h.app.closed, 0);
});

test('the topmost backdrop is the highest stacking order, last in the page among equals', () => {
  const els = [{ id: 'a', z: 20 }, { id: 'nested', z: 30 }, { id: 'b', z: 20 }];
  const doc = { querySelectorAll: () => els };
  assert.equal(topBackdrop(doc, (el) => el.z).id, 'nested');
  assert.equal(topBackdrop({ querySelectorAll: () => [els[0], els[2]] }, (el) => el.z).id, 'b');
  assert.equal(topBackdrop({ querySelectorAll: () => [] }, () => 0), null);
});

test('app.js wires it: sheets by their backdrop, the log panel on a phone only', async () => {
  const src = await readFile(fileURLToPath(new URL('../docs/js/app.js', import.meta.url)), 'utf8');
  assert.match(src, /document\.querySelectorAll\('\.sheet-backdrop'\)\.length \+ \(panelIsLayer\(\) \? 1 : 0\)/);
  assert.match(src, /const panelIsLayer = \(\) => ui\.logOpen && !desktop\.matches;/);
  assert.match(src, /top\.dispatchEvent\(new MouseEvent\('click', \{ bubbles: true \}\)\)/);
  assert.match(src, /window\.addEventListener\('popstate', \(event\) => stack\.onPop\(event\)\)/);
  assert.match(src, /^backNavigation\(\);$/m);
});

test('every sheet closes on a tap of its backdrop, which is what back relies on', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const backdrops = html.match(/<div class="sheet-backdrop[^"]*"[^>]*>/g) ?? [];
  assert.ok(backdrops.length > 20);
  for (const tag of backdrops) assert.match(tag, /@click\.self=/, `no tap-to-close: ${tag}`);
});

test('back.js is precached', async () => {
  const sw = await readFile(fileURLToPath(new URL('../docs/sw.js', import.meta.url)), 'utf8');
  assert.match(sw, /'\/js\/back\.js',/);
});
