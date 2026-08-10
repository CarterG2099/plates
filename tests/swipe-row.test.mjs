/**
 * $swipeRow — the drag-a-row-to-reveal-its-action state machine.
 *
 * The factory is sliced out of app.js as source text and run against a stub DOM.
 * That is ugly, and the alternative was worse: app.js registers everything
 * against a live Alpine and cannot be imported in Node, and re-typing the
 * handler here would test a copy rather than the code that ships. The slice
 * throws if its markers move, so this fails loudly rather than silently testing
 * nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const start = src.indexOf("Alpine.magic('swipeRow'");
const end = src.indexOf("Alpine.magic('dragCard'");
assert.ok(start !== -1 && end > start, '$swipeRow could not be located in app.js');

const openRows = new Set();
globalThis.document = { querySelectorAll: () => [...openRows] };

let factory;
new Function('Alpine', src.slice(start, end))({ magic: (_n, fn) => { factory = fn(); } });

/** A row with just enough DOM for the handler, plus a record of what it did. */
function makeRow({ overInput = false } = {}) {
  const handlers = {};
  const classes = new Set();

  const slide = {
    style: {},
    captured: null,
    addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
    setPointerCapture: (id) => { slide.captured = id; },
  };

  const wrap = {
    dataset: {},
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => { classes.delete(c); if (c === 'is-open') openRows.delete(wrap); },
      toggle: (c, on) => {
        if (on) { classes.add(c); if (c === 'is-open') openRows.add(wrap); }
        else { classes.delete(c); if (c === 'is-open') openRows.delete(wrap); }
      },
    },
    querySelector: () => slide,
  };

  factory(wrap);

  const fire = (type, e = {}) => {
    for (const fn of handlers[type] ?? []) {
      fn({
        button: 0, pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0,
        target: { closest: () => (overInput ? {} : null) },
        preventDefault() { e.defaulted = true; },
        stopPropagation() { e.stopped = true; },
        ...e,
      });
    }
  };

  return {
    slide, fire,
    has: (c) => classes.has(c),
    isOpen: () => classes.has('is-open'),
    transform: () => slide.style.transform,
  };
}

const drag = (row, { from = 200, to = 200, y = 0, pointerType = 'touch' } = {}) => {
  row.fire('pointerdown', { clientX: from, clientY: 0, pointerType });
  row.fire('pointermove', { clientX: to, clientY: y, pointerType });
  row.fire('pointerup', { clientX: to, clientY: y, pointerType });
};

test('a decisive left drag opens the row, and dragging back closes it', () => {
  const r = makeRow();
  assert.equal(r.isOpen(), false);

  drag(r, { to: 140 });                       // 60px, past the 40px threshold
  assert.equal(r.isOpen(), true);
  assert.equal(r.transform(), '', 'the inline transform hands over to the class');

  drag(r, { to: 260 });
  assert.equal(r.isOpen(), false);
});

test('a short drag springs back', () => {
  const r = makeRow();
  drag(r, { to: 175 });                       // 25px, under the threshold
  assert.equal(r.isOpen(), false);

  drag(r, { to: 155 });                       // 45px, over it
  assert.equal(r.isOpen(), true);
});

test('a vertical drag is a scroll and must not move the row sideways', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200, clientY: 100 });
  r.fire('pointermove', { clientX: 190, clientY: 160 });
  r.fire('pointerup', { clientX: 190, clientY: 160 });

  assert.equal(r.isOpen(), false);
  assert.equal(r.transform(), undefined, 'never touched');
  assert.equal(r.slide.captured, null, 'and the browser keeps the gesture');
});

test('the pointer is captured only once the gesture is known to be horizontal', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200 });
  assert.equal(r.slide.captured, null);

  r.fire('pointermove', { clientX: 197 });    // 3px, under the 6px slop
  assert.equal(r.slide.captured, null, 'a twitch is not a drag');

  r.fire('pointermove', { clientX: 180 });
  assert.equal(r.slide.captured, 1);
});

test('a drag the browser cancels still settles rather than sticking mid-slide', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200 });
  r.fire('pointermove', { clientX: 120 });
  r.fire('pointercancel', {});

  assert.equal(r.isOpen(), true);
  assert.equal(r.transform(), '');
});

test('the click that ends a mouse drag does not immediately close the row', () => {
  // Touch suppresses this click once the finger passes the browser's slop;
  // a mouse does not, so without a guard the row opens and shuts at once.
  const r = makeRow();
  drag(r, { to: 140, pointerType: 'mouse' });
  assert.equal(r.isOpen(), true);

  const first = {};
  r.fire('click', first);
  assert.equal(first.stopped, true, 'swallowed');
  assert.equal(r.isOpen(), true, 'and the row stays open');

  const second = {};
  r.fire('click', second);
  assert.equal(r.isOpen(), false, 'the next real tap closes it');
});

test('a tap on a closed row reaches the row\'s own handler untouched', () => {
  const r = makeRow();
  const click = {};
  r.fire('click', click);
  assert.deepEqual([click.stopped, click.defaulted], [undefined, undefined]);
});

test('a mouse dragging inside a number field is selecting text, not swiping', () => {
  const mouse = makeRow({ overInput: true });
  drag(mouse, { to: 140, pointerType: 'mouse' });
  assert.equal(mouse.isOpen(), false);

  // Excluding those columns on touch would leave almost none of a set row to grab.
  const finger = makeRow({ overInput: true });
  drag(finger, { to: 140, pointerType: 'touch' });
  assert.equal(finger.isOpen(), true);
});

test('a right-button drag does nothing', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200, button: 2, pointerType: 'mouse' });
  r.fire('pointermove', { clientX: 120, pointerType: 'mouse' });
  r.fire('pointerup', { clientX: 120, pointerType: 'mouse' });
  assert.equal(r.isOpen(), false);
});

test('opening one row closes any other', () => {
  openRows.clear();
  const a = makeRow();
  const b = makeRow();

  drag(a, { to: 130 });
  assert.equal(a.isOpen(), true);

  drag(b, { to: 130 });
  assert.equal(b.isOpen(), true);
  assert.equal(a.isOpen(), false);
});

// ---- is-sliding: what keeps the red action off an idle row --------------------

test('the action is revealed only while sliding, then held open by is-open', () => {
  // A red "Remove" bleeding through the corner of every idle row is the bug
  // this class exists to prevent. It must never be left switched on.
  const r = makeRow();
  assert.equal(r.has('is-sliding'), false);

  r.fire('pointerdown', { clientX: 200 });
  assert.equal(r.has('is-sliding'), false, 'pressing alone reveals nothing');

  r.fire('pointermove', { clientX: 197 });
  assert.equal(r.has('is-sliding'), false, 'nor does a twitch');

  r.fire('pointermove', { clientX: 150 });
  assert.equal(r.has('is-sliding'), true);

  r.fire('pointerup', { clientX: 150 });
  assert.equal(r.has('is-sliding'), false);
  assert.equal(r.isOpen(), true, 'and is-open takes over keeping it visible');
});

test('a scroll leaves nothing revealed', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200, clientY: 100 });
  r.fire('pointermove', { clientX: 195, clientY: 170 });
  r.fire('pointerup', { clientX: 195, clientY: 170 });
  assert.deepEqual([r.has('is-sliding'), r.isOpen()], [false, false]);
});

test('a cancelled short drag does not strand a row showing red', () => {
  const r = makeRow();
  r.fire('pointerdown', { clientX: 200 });
  r.fire('pointermove', { clientX: 190 });
  r.fire('pointercancel', {});
  assert.deepEqual([r.has('is-sliding'), r.isOpen()], [false, false]);
});
