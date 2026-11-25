/**
 * The rings on Today: how far each goes, and what happens past 100%.
 *
 * A ring over its target keeps going round in the same colour; the shadow at
 * the end of that second lap and the tick at the top are the only things that
 * say it lapped. These hold the geometry, so "110%" cannot quietly draw as 10%.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rings from '../docs/js/rings.js';

const C = (r) => Number((2 * Math.PI * r).toFixed(2));

test('half the target fills half the ring and nothing laps', () => {
  const a = rings.arc({ value: 50, target: 100, r: 80, width: 15, centre: 88 });
  assert.ok(Math.abs(a.first - C(80) / 2) < 0.02, `first lap ${a.first}`);
  assert.equal(a.second, 0);
  assert.equal(a.over, false);
});

test('110% fills the ring and laps another tenth of it', () => {
  const a = rings.arc({ value: 2310, target: 2100, r: 80, width: 15, centre: 88 });
  assert.equal(a.first, C(80));
  assert.ok(Math.abs(a.second - C(80) * 0.1) < 0.02, `second lap ${a.second}`);
  assert.equal(a.over, true);
});

test('past 200% the second lap is full, not a third', () => {
  const a = rings.arc({ value: 500, target: 100, r: 10, width: 4, centre: 22 });
  assert.equal(a.first, C(10));
  assert.equal(a.second, C(10));
});

test('no target draws an empty track rather than a made-up share', () => {
  for (const target of [null, undefined, 0]) {
    const a = rings.arc({ value: 120, target, r: 80, width: 15, centre: 88 });
    assert.equal(a.first, 0);
    assert.equal(a.over, false);
  }
});

test('a negative or missing amount counts as nothing eaten', () => {
  assert.equal(rings.arc({ value: -40, target: 100, r: 80, width: 15, centre: 88 }).first, 0);
  assert.equal(rings.arc({ value: undefined, target: 100, r: 80, width: 15, centre: 88 }).first, 0);
});

test('the cap sits where the second lap ends and the shadow just ahead of it', () => {
  // A quarter lap over: the end is a quarter turn round from the start.
  const r = 80;
  const a = rings.arc({ value: 125, target: 100, r, width: 15, centre: 88 });
  assert.ok(Math.abs(a.cap.x - 88) < 0.05 && Math.abs(a.cap.y - (88 + r)) < 0.05, JSON.stringify(a.cap));
  const angle = Math.atan2(a.shadow.y - 88, a.shadow.x - 88);
  assert.ok(angle > Math.PI / 2, 'the shadow is further round than the cap');
});

test('the tick crosses the ring at its start, wider than the stroke', () => {
  const a = rings.arc({ value: 120, target: 100, r: 80, width: 15, centre: 88 });
  assert.equal(a.tick.x1, 88 + 80 - 7.5 - 1);
  assert.equal(a.tick.x2, 88 + 80 + 7.5 + 1);
});

test('the four rings nest from calories outside to fat inside, without touching', () => {
  const big = [0, 1, 2, 3].map((i) => rings.radius(i, rings.SIZES.big));
  assert.deepEqual(big, [79.5, 61.5, 43.5, 25.5]);
  for (const size of Object.values(rings.SIZES)) {
    const r = [0, 1, 2, 3].map((i) => rings.radius(i, size));
    for (let i = 1; i < 4; i++) assert.ok(r[i - 1] - r[i] >= size.width, 'rings do not overlap');
    assert.ok(r[3] - size.width / 2 > 0, 'the innermost ring has a hole');
  }
});

test('the svg draws a track per ring, an arc only where there is food, and the lap marks only when over', () => {
  const svg = rings.svg(rings.fromTotals(
    { calories: 2310, protein_g: 90, carbs_g: 0, fat_g: 30 },
    { calories: 2100, protein_g: 180, carbs_g: 210, fat_g: 60 },
  ));
  assert.equal(svg.match(/class="ring-track/g).length, 4);
  // calories twice (both laps), protein once, carbs none, fat once.
  assert.equal(svg.match(/class="ring-arc ring-cal"/g).length, 2);
  assert.equal(svg.match(/class="ring-arc ring-p"/g).length, 1);
  assert.equal(svg.match(/class="ring-arc ring-c"/g), null);
  assert.equal(svg.match(/class="ring-arc ring-f"/g).length, 1);
  assert.equal(svg.match(/class="ring-shadow"/g).length, 1);
  assert.equal(svg.match(/class="ring-cap ring-cal"/g).length, 1);
  assert.equal(svg.match(/class="ring-tick"/g).length, 1);
});

test('the big rings are labelled for screen readers and the small ones are hidden', () => {
  assert.match(rings.svg({}, { kind: 'big', label: '1,449 kcal' }), /role="img" aria-label="1,449 kcal"/);
  assert.match(rings.svg({}, { kind: 'mini' }), /aria-hidden="true"/);
  assert.match(rings.svg({}, { kind: 'mini' }), /width="44" height="44" viewBox="0 0 44 44"/);
});

test('a label cannot break out of its attribute', () => {
  assert.doesNotMatch(rings.svg({}, { label: '"><script>x</script>' }), /<script>/);
});

test('fromTotals pairs each ring with its macro and target', () => {
  const v = rings.fromTotals({ calories: 1, protein_g: 2, carbs_g: 3, fat_g: 4 }, { calories: 5, protein_g: 6, carbs_g: 7, fat_g: 8 });
  assert.deepEqual(v, { cal: { value: 1, target: 5 }, p: { value: 2, target: 6 }, c: { value: 3, target: 7 }, f: { value: 4, target: 8 } });
});

test('each day status has its mark, and an empty or future day has none', () => {
  assert.match(rings.markIcon('complete'), /mark-complete/);
  assert.match(rings.markIcon('incomplete'), /mark-incomplete/);
  assert.match(rings.markIcon('unreviewed'), /mark-unreviewed/);
  assert.match(rings.markIcon('today'), /mark-today/);
  assert.equal(rings.markIcon('empty'), '');
  assert.equal(rings.markIcon('future'), '');
});
