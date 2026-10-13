/**
 * The lift progress chart: weight, reps and volume on one indexed axis.
 *
 * The point of it is telling progress apart from a trade — heavier but fewer
 * reps, or the same weight for more — so the numbers each line is built from
 * have to describe real sets, and the index has to start where the chart does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const stats = await import('../docs/js/stats.js');

const done = '2026-09-01T12:00:00Z';
const set = (weight_lb, reps, extra = {}) => ({ weight_lb, reps, completed_at: done, is_warmup: false, ...extra });

/** historyOf() shape, newest first, from oldest-first input for readability. */
const history = (...sessions) => sessions
  .map(([date, sets]) => ({ date, sets }))
  .reverse();

const pts = (plot) => plot.points.map((p) => ({ weight: p.weight, reps: p.reps, volume: p.volume, pct: p.pct }));

test('each session is its heaviest working set, and volume over every working set', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(45, 12, { is_warmup: true }), set(100, 10), set(100, 8)]],
    ['2026-08-08T12:00:00Z', [set(110, 8), set(105, 9)]],
  ));
  assert.deepEqual(pts(plot).map(({ pct, ...rest }) => rest), [
    { weight: 100, reps: 10, volume: 1800 },
    { weight: 110, reps: 8, volume: 1825 },
  ]);
});

test('a tie on weight is the set with the most reps, so both lines describe one set', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 6), set(100, 9), set(100, 7)]],
    ['2026-08-08T12:00:00Z', [set(100, 10)]],
  ));
  assert.equal(plot.points[0].reps, 9);
});

test('every line starts at 0% and reads as change since the first session', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10)]],
    ['2026-08-08T12:00:00Z', [set(110, 8)]],
    ['2026-08-15T12:00:00Z', [set(100, 12)]],
  ));
  assert.deepEqual(plot.points[0].pct, { weight: 0, reps: 0, volume: 0 });
  // Heavier for fewer: weight up, reps down, volume a touch down.
  assert.deepEqual(plot.points[1].pct, { weight: 10, reps: -20, volume: -12 });
  // Same weight, more reps.
  assert.deepEqual(plot.points[2].pct, { weight: 0, reps: 20, volume: 20 });
  assert.deepEqual(plot.series.map((s) => [s.key, s.latest]), [['weight', 0], ['reps', 20], ['volume', 20]]);
  assert.equal(plot.since, '2026-08-01T12:00:00Z');
});

test('warm-ups, unfinished sets and repless sets count for nothing', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10), set(300, 1, { is_warmup: true }), set(200, 5, { completed_at: null }), set(150, 0)]],
    ['2026-08-08T12:00:00Z', [set(100, 10)]],
  ));
  assert.deepEqual(pts(plot)[0], { weight: 100, reps: 10, volume: 1000, pct: { weight: 0, reps: 0, volume: 0 } });
});

test('a session with no working sets is skipped, not drawn as a collapse to zero', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10)]],
    ['2026-08-05T12:00:00Z', [set(45, 10, { is_warmup: true })]],
    ['2026-08-08T12:00:00Z', [set(105, 10)]],
  ));
  assert.equal(plot.points.length, 2);
});

test('a bodyweight lift draws reps alone, in reps\' own colour slot', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(null, 8), set(null, 6)]],
    ['2026-08-08T12:00:00Z', [set(null, 10)]],
  ));
  assert.deepEqual(plot.series.map((s) => s.key), ['reps']);
  assert.equal(plot.series[0].latest, 25);
});

test('fewer than two sessions is no chart', () => {
  assert.equal(stats.progressPlot([]), null);
  assert.equal(stats.progressPlot(history(['2026-08-01T12:00:00Z', [set(100, 10)]])), null);
});

test('the 0% baseline is always inside the frame', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10)]],
    ['2026-08-08T12:00:00Z', [set(150, 10)]],
    ['2026-08-15T12:00:00Z', [set(200, 10)]],
  ));
  assert.ok(plot.zeroY > 0 && plot.zeroY < plot.height, `zeroY ${plot.zeroY}`);
  for (const s of plot.series) {
    for (const y of s.ys) assert.ok(y >= 0 && y <= plot.height, `${s.key} y ${y} out of frame`);
  }
});

test('lines are drawn oldest to newest, left to right', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10)]],
    ['2026-08-08T12:00:00Z', [set(110, 10)]],
  ));
  assert.ok(plot.points[0].x < plot.points[1].x);
  assert.match(plot.series[0].line, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
});

// ---- the time axis ------------------------------------------------------------

test('the axis runs first session to last in four even steps, under the points', () => {
  const plot = stats.progressPlot(history(
    ['2025-02-01T12:00:00Z', [set(100, 10)]],
    ['2025-06-01T12:00:00Z', [set(105, 10)]],
    ['2026-02-01T12:00:00Z', [set(110, 10)]],
  ));
  assert.equal(plot.ticks.length, 4);
  assert.equal(plot.ticks[0].at, '2025-02-01T12:00:00.000Z');
  assert.equal(plot.ticks[3].at, '2026-02-01T12:00:00.000Z');
  assert.equal(plot.ticks[0].x, plot.points[0].x, 'first tick sits under the first session');
  assert.equal(plot.ticks[3].x, plot.points[2].x, 'last tick sits under the last session');
  const gaps = plot.ticks.slice(1).map((t, i) => Math.round((t.x - plot.ticks[i].x) * 10));
  assert.ok(new Set(gaps).size === 1, `uneven ticks ${gaps}`);
});

test('a long chart labels months, a short one days', () => {
  const long = stats.progressPlot(history(
    ['2025-02-01T12:00:00Z', [set(100, 10)]],
    ['2025-09-01T12:00:00Z', [set(105, 10)]],
  ));
  const short = stats.progressPlot(history(
    ['2026-08-01T12:00:00Z', [set(100, 10)]],
    ['2026-09-15T12:00:00Z', [set(105, 10)]],
  ));
  assert.equal(long.tickUnit, 'month');
  assert.equal(short.tickUnit, 'day');
});

test('two sessions on the same day get one centred tick, not four on top of each other', () => {
  const plot = stats.progressPlot(history(
    ['2026-08-01T09:00:00Z', [set(100, 10)]],
    ['2026-08-01T09:00:00Z', [set(105, 10)]],
  ));
  assert.equal(plot.ticks.length, 1);
  assert.equal(plot.ticks[0].x, plot.width / 2);
});

test('the axis is drawn in HTML under the plot, ends aligned inward', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const block = html.slice(html.indexOf('<template x-if="detailProgress">'));
  assert.match(block, /class="progress-axis"[\s\S]*?x-for="\(t, i\) in detailProgress\.ticks"/);
  assert.match(block, /x-text="progressTick\(t\.at\)"/);
  const css = await readFile(fileURLToPath(new URL('../docs/css/pages.css', import.meta.url)), 'utf8');
  assert.match(css, /\.progress-axis span\.is-first\s*\{\s*transform:\s*none;/);
  assert.match(css, /\.progress-axis span\.is-last\s*\{\s*transform:\s*translateX\(-100%\);/);
});

test('the sheet shows it for lifts only, with a legend and dashes beside the colour', async () => {
  const app = await readFile(fileURLToPath(new URL('../docs/js/app.js', import.meta.url)), 'utf8');
  assert.match(app, /if \(!this\.detail \|\| this\.detailIsCardio\) return null;\s*return stats\.progressPlot\(this\.detailHistory\)/);

  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const block = html.slice(html.indexOf('<template x-if="detailProgress">'));
  assert.match(block, /class="progress-legend"/);
  assert.match(block, /x-html="progressMarks"/);

  const css = await readFile(fileURLToPath(new URL('../docs/css/pages.css', import.meta.url)), 'utf8');
  assert.match(css, /\.progress-line\.is-reps\s*\{[^}]*stroke-dasharray/);
  assert.match(css, /\.progress-line\.is-volume\s*\{[^}]*stroke-dasharray/);
});
