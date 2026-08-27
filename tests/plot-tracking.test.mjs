/**
 * tracksPointer — whether a pointer event should move a plot's readout.
 *
 * Sliced out of app.js as source text, the same way swipe-row.test.mjs does it
 * and for the same reason: app.js registers against a live Alpine and cannot be
 * imported in Node, and retyping the rule here would test a copy rather than the
 * code that ships. The slice throws if its marker moves.
 *
 * This exists because the stats plots were hover-only, and on a phone there is
 * no hover: `pointerleave` fires the instant a finger lifts, so a tap that did
 * register was wiped before it could be read. Plates is a phone app first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const start = src.indexOf('const tracksPointer =');
assert.ok(start !== -1, 'tracksPointer could not be located in app.js');
const end = src.indexOf(';', src.indexOf('=>', start));

const tracksPointer = new Function(`${src.slice(start, end + 1)} return tracksPointer;`)();

const at = (type, pointerType, buttons = 0) => ({ type, pointerType, buttons });

test('a mouse tracks on hover, with nothing held down', () => {
  assert.equal(tracksPointer(at('pointermove', 'mouse')), true);
  assert.equal(tracksPointer(at('pointerdown', 'mouse', 1)), true);
});

test('a tap reports, even though it never moves', () => {
  // The whole bug: this is most taps, and it used to report nothing at all.
  assert.equal(tracksPointer(at('pointerdown', 'touch', 1)), true);
});

test('a finger tracks while it is down, and is ignored once it is not', () => {
  assert.equal(tracksPointer(at('pointermove', 'touch', 1)), true, 'dragging along the plot');
  assert.equal(tracksPointer(at('pointermove', 'touch', 0)), false,
    'a stray move with nothing held is the page scrolling past, not a reading');
});

test('a pen behaves like a finger, not like a mouse', () => {
  assert.equal(tracksPointer(at('pointerdown', 'pen', 1)), true);
  assert.equal(tracksPointer(at('pointermove', 'pen', 1)), true);
  assert.equal(tracksPointer(at('pointermove', 'pen', 0)), false, 'hovering a pen is not a reading');
});
