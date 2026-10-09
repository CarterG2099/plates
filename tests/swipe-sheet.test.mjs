/**
 * $swipe — the drag-a-sheet-down-to-dismiss state machine.
 *
 * Same source-slice approach as swipe-row.test.mjs, for the same reason: app.js
 * cannot be imported in Node, and a re-typed handler would test a copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const start = src.indexOf("Alpine.magic('swipe'");
const end = src.indexOf("Alpine.magic('swipeRow'");
assert.ok(start !== -1 && end > start, '$swipe could not be located in app.js');

let factory;
new Function('Alpine', src.slice(start, end))({ magic: (_n, fn) => { factory = fn(); } });

const realTimeout = globalThis.setTimeout;
test.before(() => { globalThis.setTimeout = (fn) => fn(); });   // the close hides behind a 160ms animation
test.after(() => { globalThis.setTimeout = realTimeout; });

/**
 * A sheet holding a scrollable results list, like the exercise picker:
 * sheet > list > row, plus a search box directly on the sheet.
 */
function makeSheet() {
  const handlers = {};
  const sheet = {
    dataset: {},
    style: {},
    scrollTop: 0,
    parentElement: null,
    addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
  };
  const list = { scrollTop: 0, parentElement: sheet };
  const row = { scrollTop: 0, parentElement: list };
  const searchBox = { scrollTop: 0, parentElement: sheet };

  let closed = false;
  factory(sheet, () => { closed = true; });

  const fire = (type, target, y) =>
    handlers[type]?.forEach((fn) => fn({ target, touches: [{ clientY: y }] }));

  return {
    sheet,
    list,
    row,
    searchBox,
    get closed() { return closed; },
    start: (target, y) => fire('touchstart', target, y),
    move: (target, y) => fire('touchmove', target, y),
    endAt: (target, y) => fire('touchend', target, y),
    drag(target, from, to) {
      fire('touchstart', target, from);
      fire('touchmove', target, to);
      fire('touchend', target, to);
    },
  };
}

test('a long downward drag from the top of the list dismisses the sheet', () => {
  const s = makeSheet();
  s.drag(s.row, 100, 300);
  assert.equal(s.closed, true);
});

// The two-step rule: one gesture brings the list back to its top, and only the
// next one may take the sheet. Reaching the top mid-gesture must not convert a
// scroll into a dismiss — which it did when the check only read the sheet's own
// scrollTop, a number that never moves on a search sheet whose list scrolls.
test('the same drag with the list scrolled down only scrolls, never dismisses', () => {
  const s = makeSheet();
  s.list.scrollTop = 400;
  s.drag(s.row, 100, 300);
  assert.equal(s.closed, false);
});

test('a drag outside the list dismisses even while the list is scrolled', () => {
  const s = makeSheet();
  s.list.scrollTop = 400;
  s.drag(s.searchBox, 100, 300);
  assert.equal(s.closed, true);
});

test('a short drag springs back instead of dismissing', () => {
  const s = makeSheet();
  s.drag(s.row, 100, 150);   // under the 90px threshold
  assert.equal(s.closed, false);
  assert.equal(s.sheet.style.transform, '');
});

// Scroll up then pull back down in one motion: the sheet must not chase the
// finger while the list scrolls under it. Direction is decided once.
test('an upward drag disarms the gesture for good', () => {
  const s = makeSheet();
  s.start(s.row, 300);
  s.move(s.row, 250);   // upward: this gesture is a scroll
  s.move(s.row, 500);   // back down, past the threshold
  s.endAt(s.row, 500);
  assert.equal(s.closed, false);
});
