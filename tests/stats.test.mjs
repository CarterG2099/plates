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
