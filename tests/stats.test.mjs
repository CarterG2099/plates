import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, NOW, daysAgo, atTime } from './helpers/browser.mjs';

installBrowser();
const stats = await import('../docs/js/stats.js');
const workout = await import('../docs/js/workout.js');

const ME = 'me@example.com';
const OTHER = 'aana@example.com';

// ---- body weight -----------------------------------------------------------

const weights = [
  { owner_email: ME, measured_at: daysAgo(60), weight_lb: 185 },
  { owner_email: ME, measured_at: daysAgo(30), weight_lb: 180 },
  { owner_email: ME, measured_at: daysAgo(1), weight_lb: 176.4 },
  { owner_email: OTHER, measured_at: daysAgo(1), weight_lb: 130 },
  { owner_email: ME, measured_at: daysAgo(2), weight_lb: 999, deleted_at: daysAgo(1) },
  { owner_email: ME, measured_at: daysAgo(200), weight_lb: 200 },      // outside the window
  { owner_email: ME, measured_at: daysAgo(3), weight_lb: 'not a number' },
];

test('weightSeries is mine, alive, in range, numeric, oldest first', async () => {
  await atTime(NOW, () => {
    const series = stats.weightSeries(weights, ME, 90);
    assert.deepEqual(series.map((w) => w.lb), [185, 180, 176.4]);
  });
});

test('weightSeries respects the window', async () => {
  await atTime(NOW, () => {
    assert.equal(stats.weightSeries(weights, ME, 7).length, 1);
    assert.equal(stats.weightSeries(weights, ME, 365).length, 4);
  });
});

test('weightSummary reports change, latest and distance to target', async () => {
  await atTime(NOW, () => {
    const summary = stats.weightSummary(stats.weightSeries(weights, ME, 90), { target_weight_lb: 165 });
    assert.equal(summary.latest, 176.4);
    assert.equal(summary.change, -8.6);      // 176.4 from 185
    assert.equal(summary.target, 165);
    assert.equal(summary.toGo, 11.4);
    assert.equal(summary.span, 3);
  });
});

test('weightSummary copes with no goal and no data', async () => {
  await atTime(NOW, () => {
    const summary = stats.weightSummary(stats.weightSeries(weights, ME, 90), null);
    assert.equal(summary.target, null);
    assert.equal(summary.toGo, null);
    assert.equal(stats.weightSummary([], null), null);
  });
});

test('a single weighing has zero change rather than NaN', async () => {
  await atTime(NOW, () => {
    const summary = stats.weightSummary(stats.weightSeries([weights[2]], ME, 90), null);
    assert.equal(summary.change, 0);
  });
});

// ---- nutrition -------------------------------------------------------------

const goals = [{ owner_email: ME, starts_on: '2020-01-01', ends_on: null, calorie_target: 2100 }];

test('calorieDays returns one entry per day, oldest first', async () => {
  await atTime(NOW, () => {
    const days = stats.calorieDays([], goals, ME, 14);
    assert.equal(days.length, 14);
    assert.ok(days[0].date < days[13].date);
    assert.equal(days.every((d) => d.target === 2100), true);
  });
});

test('calorieDays marks days with nothing logged', async () => {
  await atTime(NOW, () => {
    const log = [{ owner_email: ME, logged_at: new Date().toISOString(), calories: 500 }];
    const days = stats.calorieDays(log, goals, ME, 3);
    assert.equal(days[days.length - 1].logged, true);
    assert.equal(days[0].logged, false);
    assert.equal(days[0].kcal, 0);
  });
});

test('calorieSummary averages only days that were logged', async () => {
  const days = [
    { kcal: 2000, target: 2100, logged: true },
    { kcal: 0, target: 2100, logged: false },      // must not drag the mean to 1000
    { kcal: 2200, target: 2100, logged: true },
  ];
  const summary = stats.calorieSummary(days);
  assert.equal(summary.average, 2100);
  assert.equal(summary.loggedDays, 2);
  assert.equal(summary.totalDays, 3);
  assert.equal(summary.delta, 0);
});

test('calorieSummary is null when nothing was logged at all', () => {
  assert.equal(stats.calorieSummary([{ kcal: 0, logged: false }]), null);
  assert.equal(stats.calorieSummary([]), null);
});

// ---- training --------------------------------------------------------------

function buildSets(sessionId, exerciseId, name, sets) {
  return sets.map((s, i) => ({
    id: `${sessionId}-${i}`, session_id: sessionId, exercise_id: exerciseId, exercise_name: name,
    weight_lb: s.w, reps: s.r, completed_at: '2026-08-10T10:00:00.000Z', is_warmup: s.warmup ?? false,
  }));
}

test('weeklyTraining buckets finished sessions into Monday-anchored weeks', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 's1', owner_email: ME, started_at: daysAgo(2), ended_at: daysAgo(2) },
      { id: 's2', owner_email: ME, started_at: daysAgo(3), ended_at: daysAgo(3) },
      { id: 's3', owner_email: ME, started_at: daysAgo(1), ended_at: null },      // unfinished
    ];
    const sets = [...buildSets('s1', 'e1', 'Bench', [{ w: 100, r: 10 }]),
                  ...buildSets('s2', 'e1', 'Bench', [{ w: 100, r: 10 }])];
    const index = workout.buildIndex(sets, sessions, ME);
    const weeks = stats.weeklyTraining(index, 12);

    assert.equal(weeks.length, 12);
    assert.equal(weeks.reduce((a, w) => a + w.sessions, 0), 2);   // s3 excluded
    assert.equal(weeks.reduce((a, w) => a + w.volume, 0), 2000);
  });
});

test('weeklyTraining leaves empty weeks in place rather than omitting them', async () => {
  await atTime(NOW, () => {
    const index = workout.buildIndex([], [], ME);
    const weeks = stats.weeklyTraining(index, 6);
    assert.equal(weeks.length, 6);
    assert.equal(weeks.every((w) => w.sessions === 0 && w.volume === 0), true);
  });
});

test('topLifts ranks by how often you do the lift, not how heavy it is', () => {
  const sessions = [
    { id: 's1', owner_email: ME, started_at: daysAgo(3), ended_at: daysAgo(3) },
    { id: 's2', owner_email: ME, started_at: daysAgo(2), ended_at: daysAgo(2) },
  ];
  const sets = [
    ...buildSets('s1', 'bench', 'Bench Press', [{ w: 185, r: 5 }, { w: 185, r: 5 }]),
    ...buildSets('s2', 'bench', 'Bench Press', [{ w: 195, r: 5 }]),
    ...buildSets('s1', 'dead', 'Deadlift', [{ w: 405, r: 1 }]),      // heavier, done once
  ];
  const index = workout.buildIndex(sets, sessions, ME);
  const lifts = stats.topLifts(index, 6);

  assert.equal(lifts[0].name, 'Bench Press');
  assert.ok(lifts[0].best > 0);
  assert.equal(lifts.some((l) => l.name === 'Deadlift'), true);
});

test('topLifts ignores warm-ups and uncompleted sets', () => {
  const sessions = [{ id: 's1', owner_email: ME, started_at: daysAgo(1), ended_at: daysAgo(1) }];
  const sets = [
    ...buildSets('s1', 'bench', 'Bench Press', [{ w: 45, r: 10, warmup: true }]),
    { id: 'x', session_id: 's1', exercise_id: 'bench', exercise_name: 'Bench Press', weight_lb: 500, reps: 5, completed_at: null },
  ];
  const index = workout.buildIndex(sets, sessions, ME);
  assert.deepEqual(stats.topLifts(index), []);
});

test('topLifts flags a new best', () => {
  const sessions = [
    { id: 's1', owner_email: ME, started_at: daysAgo(9), ended_at: daysAgo(9) },
    { id: 's2', owner_email: ME, started_at: daysAgo(1), ended_at: daysAgo(1) },
  ];
  const sets = [
    ...buildSets('s1', 'b', 'Bench', [{ w: 185, r: 5 }]),
    ...buildSets('s2', 'b', 'Bench', [{ w: 205, r: 5 }]),
  ];
  const lift = stats.topLifts(workout.buildIndex(sets, sessions, ME))[0];
  assert.equal(lift.isBest, true);
  assert.ok(lift.delta > 0);
});

// ---- chart geometry --------------------------------------------------------

test('barGeometry scales to the tallest bar and floors the rest', () => {
  const bars = stats.barGeometry([0, 5, 10], { height: 60, gap: 2 });
  assert.equal(bars.length, 3);
  assert.equal(bars[0].height, 0);          // zero stays flat
  assert.equal(bars[2].height, 60);         // tallest fills
  assert.ok(bars[1].height >= 2);           // non-zero gets a visible stub
  assert.ok(bars[2].y + bars[2].height <= 60.001);
});

test('barGeometry of all zeros does not divide by zero', () => {
  const bars = stats.barGeometry([0, 0, 0]);
  assert.equal(bars.every((b) => Number.isFinite(b.height)), true);
});

test('barGeometry bars are evenly spaced across 100 units', () => {
  const bars = stats.barGeometry([1, 1, 1, 1]);
  assert.equal(bars[0].x, 0);
  assert.equal(bars[3].x, 75);
});

test('linePoints needs two points to draw anything', () => {
  assert.equal(stats.linePoints([]).points, '');
  assert.equal(stats.linePoints([5]).points, '');
  assert.equal(stats.linePoints([5]).last, null);
});

test('linePoints pads so the extremes are not clipped', () => {
  const { points, last } = stats.linePoints([10, 20, 15], { width: 100, height: 50, pad: 4 });
  const ys = points.split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(Math.min(...ys) >= 4);
  assert.ok(Math.max(...ys) <= 46);
  assert.equal(last.v, 15);
});

test('linePoints handles a flat series without dividing by zero', () => {
  const { points } = stats.linePoints([10, 10, 10]);
  assert.equal(points.split(' ').every((p) => Number.isFinite(Number(p.split(',')[1]))), true);
});

// ---- chart markup ----------------------------------------------------------

test('barChart escapes tooltip text rather than injecting it raw', () => {
  const html = stats.barChart([{ x: 0, y: 0, width: 10, height: 10, tip: '<script>alert(1)</script>' }], { fill: 'red' });
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('barChart emphasises the last bar when asked', () => {
  const bars = [{ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }];
  const html = stats.barChart(bars, { fill: 'blue', emphasiseLast: true });
  assert.ok(html.includes('opacity="1"'));
  assert.ok(html.includes('opacity="0.55"'));
});

test('lineChart returns nothing for an empty series', () => {
  assert.equal(stats.lineChart('', { stroke: 'red' }), '');
});

// ---- weight in detail -------------------------------------------------------
// Four readings is not a trend. Everything here reports what it had to work
// with, so the card can be careful rather than confident.

const DAY_MS = 86_400_000;
const ago = (d) => new Date(NOW.getTime() - d * DAY_MS).toISOString();

/** The real shape as of writing: four weigh-ins across seventeen days. */
const sparse = [
  { at: ago(17), lb: 178.4 },
  { at: ago(11), lb: 177.2 },
  { at: ago(4), lb: 176.5 },
  { at: ago(0), lb: 176.1 },
];

test('readings come back newest first, each with its step', () => {
  const rows = stats.weightReadings(sparse);
  assert.deepEqual(rows.map((r) => r.lb), [176.1, 176.5, 177.2, 178.4]);
  assert.equal(rows[0].delta, -0.4);
  assert.equal(rows[0].daysSincePrevious, 4);
  assert.equal(rows.at(-1).delta, null, 'the first reading has nothing to compare to');
  assert.equal(rows.at(-1).daysSincePrevious, null);
});

test('a trend needs three readings before it says anything', () => {
  assert.deepEqual(stats.weightTrend(sparse.slice(0, 2)), { enough: false, points: 2, needed: 3 });
  assert.equal(stats.weightTrend([]).enough, false);
  assert.equal(stats.weightTrend(sparse).enough, true);
});

test('readings all from one day are a scatter, not a slope', () => {
  // Would otherwise divide by zero and report an infinite rate of loss.
  const sameDay = [{ at: ago(3), lb: 176 }, { at: ago(3), lb: 177 }, { at: ago(3), lb: 175 }];
  const trend = stats.weightTrend(sameDay);
  assert.equal(trend.enough, false);
  assert.equal(trend.sameDay, true);
});

test('the trend is reported per week, with a fit to judge it by', () => {
  const trend = stats.weightTrend(sparse, { target: 170, now: NOW.getTime() });
  assert.equal(trend.lbPerWeek, -0.9);
  assert.equal(trend.direction, 'down');
  assert.ok(trend.r2 > 0.9, 'these readings sit close to the line');
  assert.equal(trend.noisy, false);
  assert.equal(trend.spanDays, 17);
});

test('a scattered series says so instead of looking authoritative', () => {
  const noisy = [
    { at: ago(20), lb: 176 }, { at: ago(15), lb: 181 }, { at: ago(10), lb: 174 },
    { at: ago(5), lb: 180 }, { at: ago(0), lb: 175 },
  ];
  const trend = stats.weightTrend(noisy);
  assert.equal(trend.enough, true);
  assert.ok(trend.r2 < 0.5);
  assert.equal(trend.noisy, true, 'a slope through this must not be trusted');
});

test('a target is only projected when the line points at it', () => {
  const gaining = [{ at: ago(14), lb: 170 }, { at: ago(7), lb: 173 }, { at: ago(0), lb: 176 }];
  assert.equal(stats.weightTrend(gaining, { target: 165 }).projectedAt, null,
    'going the wrong way: no date, rather than one in the past');

  const losing = stats.weightTrend(sparse, { target: 170, now: NOW.getTime() });
  assert.ok(losing.projectedAt, 'going the right way: a date');
  assert.ok(losing.weeksAway > 0);
});

test('a window compares averages, and distinguishes flat from unknown', () => {
  const week = stats.weightWindows(sparse, 7, NOW.getTime());
  assert.equal(week.recentCount, 2);
  assert.equal(week.priorCount, 1);
  assert.equal(week.change, -0.9);

  // Nothing to compare against is null, not zero — "no change" is a claim.
  const alone = stats.weightWindows(sparse.slice(-1), 7, NOW.getTime());
  assert.equal(alone.change, null);
  assert.equal(alone.prior, null);
});

test('extremes report the readings a trend line hides', () => {
  const ends = stats.weightExtremes(sparse);
  assert.equal(ends.high.lb, 178.4);
  assert.equal(ends.low.lb, 176.1);
  assert.equal(ends.range, 2.3);
  assert.equal(stats.weightExtremes([]), null);
});

// ---- plot geometry ----------------------------------------------------------

test('the plot puts every point inside the box, left to right', () => {
  const plot = stats.weightPlot(sparse, { target: 170 });
  assert.equal(plot.points.length, 4);
  assert.ok(plot.points.every((p) => p.x >= 0 && p.x <= plot.width));
  assert.ok(plot.points.every((p) => p.y >= 0 && p.y <= plot.height));
  assert.ok(plot.points.every((p, i, a) => i === 0 || p.x >= a[i - 1].x), 'x is monotonic');
});

test('the y-axis frames the data rather than starting at zero', () => {
  // Two pounds of movement against a value near 180 is invisible from a zero
  // baseline, and this chart exists to show exactly that movement.
  const plot = stats.weightPlot(sparse);
  assert.ok(plot.lo > 170, `floor was ${plot.lo}`);
  assert.ok(plot.hi < 185, `ceiling was ${plot.hi}`);
});

test('a target outside the readings pulls the axis to include it', () => {
  const plot = stats.weightPlot(sparse, { target: 160 });
  assert.ok(plot.lo <= 160, 'otherwise the target line is drawn off the chart');
  assert.ok(plot.targetY >= 0 && plot.targetY <= plot.height);
});

test('a flat or single-reading series does not divide by zero', () => {
  const one = stats.weightPlot([{ at: ago(0), lb: 176 }]);
  assert.equal(one.points.length, 1);
  assert.ok(Number.isFinite(one.points[0].x) && Number.isFinite(one.points[0].y));

  const flat = stats.weightPlot([{ at: ago(5), lb: 176 }, { at: ago(0), lb: 176 }]);
  assert.ok(flat.points.every((p) => Number.isFinite(p.y)));
  assert.equal(stats.weightPlot([]), null);
});

test('the area path closes back along the baseline', () => {
  const plot = stats.weightPlot(sparse);
  assert.ok(plot.area.startsWith('M'), 'starts where the line does');
  assert.ok(plot.area.endsWith('Z'), 'and closes, or the fill leaks');
  assert.ok(plot.area.includes(`L${plot.points[0].x} ${plot.height}`));
});

test('a one-day gap is not "1 days"', () => {
  assert.equal(stats.gapLabel(1), '1 day after the one before');
  assert.equal(stats.gapLabel(13), '13 days after the one before');
  assert.equal(stats.gapLabel(null), 'First reading');
});

// ---- training, in detail ---------------------------------------------------

const week = (i, volume, sessions) => ({
  start: new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 7 * 86_400_000),
  volume,
  sessions,
});

test('volumePlot scales to the tallest week and stays inside the box', () => {
  const plot = stats.volumePlot([week(0, 10_000, 3), week(1, 40_000, 4), week(2, 0, 0)]);

  assert.equal(plot.max, 40_000);
  assert.equal(plot.bars.length, 3);
  assert.equal(plot.bars[1].h, plot.height);            // the tallest fills it
  assert.equal(plot.bars[1].y, 0);
  assert.ok(plot.bars[0].h > 0 && plot.bars[0].h < plot.height);
  for (const bar of plot.bars) {
    assert.ok(bar.y >= 0 && bar.y + bar.h <= plot.height + 1e-9, 'inside the box');
    assert.ok(bar.x >= 0 && bar.x + bar.w <= plot.width + 1e-9, 'inside the box');
  }
});

test('volumePlot draws a stub for a small week but nothing for an untrained one', () => {
  const plot = stats.volumePlot([week(0, 400, 1), week(1, 40_000, 5), week(2, 0, 0)]);
  assert.ok(plot.bars[0].h >= 0.8, 'a trained week is visible');
  assert.equal(plot.bars[2].h, 0, 'an untrained week draws nothing');
});

test('volumePlot slots span the width so a pointer maps to a week', () => {
  const plot = stats.volumePlot([week(0, 1, 1), week(1, 2, 1), week(2, 3, 1), week(3, 4, 1)]);
  assert.equal(plot.slot, 25);
  assert.deepEqual(plot.bars.map((b) => b.x), [0, 25, 50, 75]);
});

test('volumePlot survives an empty history', () => {
  const plot = stats.volumePlot([]);
  assert.deepEqual(plot.bars, []);
  assert.equal(Number.isFinite(plot.slot), true);
  assert.equal(plot.max, 1);
});

test('volumeStats averages over weeks trained, not weeks elapsed', () => {
  const weeks = [week(0, 30_000, 4), week(1, 0, 0), week(2, 20_000, 3)];
  const s = stats.volumeStats(weeks, { now: weeks[2].start.getTime() + 6 * 86_400_000 });

  assert.equal(s.average, 25_000);        // not 16,667
  assert.equal(s.weeksTrained, 2);
  assert.equal(s.weeks, 3);
  assert.equal(s.sessions, 7);
});

test('volumeStats reports the current week as partial while it is running', () => {
  const weeks = [week(0, 30_000, 4), week(1, 12_000, 2)];
  const start = weeks[1].start.getTime();

  const midweek = stats.volumeStats(weeks, { now: start + 2 * 86_400_000 });
  assert.equal(midweek.partial, true);
  assert.equal(midweek.daysIn, 3);
  assert.equal(midweek.change, -18_000);  // still reported, but flagged as unfair

  const done = stats.volumeStats(weeks, { now: start + 6.5 * 86_400_000 });
  assert.equal(done.partial, false);
  assert.equal(done.daysIn, 7);
});

test('volumeStats picks the best week and needs no previous one', () => {
  const single = stats.volumeStats([week(0, 9_000, 2)], { now: week(0, 0, 0).start.getTime() });
  assert.equal(single.previous, null);
  assert.equal(single.change, null);
  assert.equal(single.best.volume, 9_000);

  const many = stats.volumeStats([week(0, 9_000, 2), week(1, 44_000, 5), week(2, 12_000, 3)]);
  assert.equal(many.best.volume, 44_000);
  assert.equal(many.best.start.getTime(), week(1, 0, 0).start.getTime());
});

test('volumeStats returns null rather than dividing by no weeks', () => {
  assert.equal(stats.volumeStats([]), null);
});

test('sessionSummaries counts what a finished session contained', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 's1', owner_email: ME, name: 'Push A',
        started_at: '2026-08-10T10:00:00.000Z', ended_at: '2026-08-10T11:05:00.000Z' },
      { id: 's2', owner_email: ME, started_at: daysAgo(1), ended_at: null },   // running
    ];
    const sets = [
      ...buildSets('s1', 'e1', 'Bench', [{ w: 100, r: 10 }, { w: 100, r: 8 }]),
      ...buildSets('s1', 'e2', 'Row', [{ w: 50, r: 10 }]),
    ];
    const rows = stats.sessionSummaries(workout.buildIndex(sets, sessions, ME));

    assert.equal(rows.length, 1, 'the running session is not history yet');
    assert.equal(rows[0].name, 'Push A');
    assert.equal(rows[0].sets, 3);
    assert.equal(rows[0].exercises, 2);
    assert.equal(rows[0].minutes, 65);
    assert.equal(rows[0].volume, 2300);
  });
});

test('sessionSummaries refuses a duration from a session left running overnight', async () => {
  await atTime(NOW, () => {
    const sessions = [{ id: 's1', owner_email: ME, started_at: '2026-08-10T10:00:00.000Z',
                        ended_at: '2026-08-11T09:00:00.000Z' }];
    const rows = stats.sessionSummaries(
      workout.buildIndex(buildSets('s1', 'e1', 'Bench', [{ w: 100, r: 5 }]), sessions, ME));

    assert.equal(rows[0].minutes, null);
    assert.equal(rows[0].name, 'Workout');    // unnamed sessions still read as something
  });
});

test('sessionSummaries keeps a long but plausible session', async () => {
  await atTime(NOW, () => {
    const sessions = [{ id: 's1', owner_email: ME, started_at: '2026-08-10T10:00:00.000Z',
                        ended_at: '2026-08-10T12:20:00.000Z' }];
    const rows = stats.sessionSummaries(
      workout.buildIndex(buildSets('s1', 'e1', 'Bench', [{ w: 100, r: 5 }]), sessions, ME));
    assert.equal(rows[0].minutes, 140);
  });
});

test('sessionSummaries stops at the limit', async () => {
  await atTime(NOW, () => {
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`, owner_email: ME, started_at: daysAgo(i + 1), ended_at: daysAgo(i + 1),
    }));
    const rows = stats.sessionSummaries(workout.buildIndex([], sessions, ME), 5);
    assert.equal(rows.length, 5);
  });
});
