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

// ---- muscle balance --------------------------------------------------------

const EX = [
  { id: 'bench', name: 'Bench Press', primary_muscle: 'chest' },
  { id: 'row',   name: 'Barbell Row', primary_muscle: 'lats' },
  { id: 'squat', name: 'Back Squat',  primary_muscle: 'quadriceps' },
  { id: 'curl',  name: 'Bicep Curl',  primary_muscle: 'biceps' },
  { id: 'run',   name: 'Running',     primary_muscle: 'cardio', category: 'cardio' },
];

/** One finished session per call, sets given as [exerciseId, weight, reps, extra]. */
function trained(id, when, rows) {
  const session = { id, owner_email: ME, started_at: when, ended_at: when };
  const sets = rows.map(([ex, weight, reps, extra = {}], i) => ({
    id: `${id}-${i}`, owner_email: ME, session_id: id, exercise_id: ex,
    exercise_name: EX.find((e) => e.id === ex).name,
    set_index: i, weight_lb: weight, reps, completed_at: when, ...extra,
  }));
  return { session, sets };
}

test('muscleVolume splits tonnage across the six groups', async () => {
  await atTime(NOW, () => {
    const a = trained('s1', daysAgo(3), [
      ['bench', 100, 10],            // 1000 -> chest
      ['row',   100, 10],            //  1000 -> back
      ['squat', 200, 10],            // 2000 -> legs
    ]);
    const index = workout.buildIndex(a.sets, [a.session], ME);
    const out = stats.muscleVolume(index, EX, { weeks: 12, now: NOW });

    const by = Object.fromEntries(out.groups.map((g) => [g.key, g.volume]));
    assert.deepEqual(by, { chest: 1000, back: 1000, shoulders: 0, arms: 0, legs: 2000, core: 0 });
    assert.equal(out.total, 4000);
    assert.equal(out.sessions, 1);

    const legs = out.groups.find((g) => g.key === 'legs');
    assert.equal(Math.round(legs.share * 100), 50);
  });
});

test('muscleVolume counts work, not sets — and never counts a run', async () => {
  await atTime(NOW, () => {
    const a = trained('s1', daysAgo(2), [
      ['curl', 30, 10],                                  // 300 -> arms
      ['curl', 30, 10],                                  // 300 -> arms
      ['squat', 300, 5],                                 // 1500 -> legs, one set
      ['bench', 45, 10, { is_warmup: true }],            // warm-up, ignored
      ['bench', 100, 5, { completed_at: null }],         // unfinished, ignored
      ['run', null, null, { distance_m: 5000, duration_s: 1500 }],
    ]);
    const index = workout.buildIndex(a.sets, [a.session], ME);
    const out = stats.muscleVolume(index, EX, { weeks: 12, now: NOW });

    const by = Object.fromEntries(out.groups.map((g) => [g.key, g.volume]));
    assert.equal(by.arms, 600, 'two sets of curls');
    assert.equal(by.legs, 1500, 'one set of squats outweighs them');
    assert.equal(by.chest, 0, 'a warm-up and an unfinished set are not work');
    assert.equal(out.total, 2100, 'and the run contributes nothing at all');
  });
});

test('muscleVolume ignores other people, unfinished sessions and old ones', async () => {
  await atTime(NOW, () => {
    const mine = trained('s1', daysAgo(3), [['squat', 100, 10]]);
    const stale = trained('s2', daysAgo(200), [['squat', 100, 10]]);
    const running = trained('s3', daysAgo(1), [['squat', 100, 10]]);
    running.session.ended_at = null;
    const theirs = trained('s4', daysAgo(1), [['squat', 100, 10]]);
    theirs.session.owner_email = OTHER;

    const sessions = [mine, stale, running, theirs];
    const index = workout.buildIndex(sessions.flatMap((s) => s.sets), sessions.map((s) => s.session), ME);
    const out = stats.muscleVolume(index, EX, { weeks: 12, now: NOW });

    assert.equal(out.total, 1000, 'only the one finished session of mine inside the window');
    assert.equal(out.sessions, 1);
  });
});

test('work the map cannot place is set aside rather than silently dropped', async () => {
  await atTime(NOW, () => {
    const a = trained('s1', daysAgo(1), [['squat', 100, 10]]);
    a.sets.push({ id: 'x', owner_email: ME, session_id: 's1', exercise_id: 'mystery',
      exercise_name: 'Sled Drag', set_index: 9, weight_lb: 90, reps: 10,
      completed_at: daysAgo(1) });

    const index = workout.buildIndex(a.sets, [a.session], ME);
    const out = stats.muscleVolume(index, EX, { weeks: 12, now: NOW });

    assert.equal(out.unplaced, 900, 'counted, and countable');
    assert.equal(out.total, 1000, 'but not folded into a group it does not belong to');
  });
});

test('radarPlot scales to the biggest group, not to the whole', () => {
  const groups = [
    { key: 'chest', label: 'Chest', volume: 100, share: 0.5 },
    { key: 'back', label: 'Back', volume: 60, share: 0.3 },
    { key: 'legs', label: 'Legs', volume: 40, share: 0.2 },
  ];
  const plot = stats.radarPlot(groups, { size: 100 });

  // Straight up first, and the largest share reaches the rim — against 100% it
  // would sit at half the radius and the chart would look like a dot.
  const [first] = plot.points;
  assert.equal(first.key, 'chest');
  assert.equal(first.x, plot.cx, 'first spoke points straight up');
  assert.equal(Math.round(plot.cy - first.y), Math.round(plot.radius));
  assert.equal(first.percent, 50);

  const back = plot.points[1];
  assert.ok(Math.hypot(back.x - plot.cx, back.y - plot.cy) < plot.radius);
  assert.equal(plot.points.length, 3);
  assert.equal(plot.polygon.split(' ').length, 3);
});

test('radarPlot has nothing to draw without groups', () => {
  assert.equal(stats.radarPlot([]), null);
  assert.equal(stats.radarPlot(null), null);

  // Every group at zero is a real state — a week where nothing was finished.
  const empty = stats.radarPlot(
    ['chest', 'back'].map((key) => ({ key, label: key, volume: 0, share: 0 })), { size: 100 });
  assert.equal(empty.points.every((p) => p.x === empty.cx && p.y === empty.cy), true,
    'collapsed to the centre rather than NaN');
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

// ---- chart markup ----------------------------------------------------------

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
    const sets = sessions.flatMap((x) => buildSets(x.id, 'e1', 'Bench', [{ w: 100, r: 5 }]));
    const rows = stats.sessionSummaries(workout.buildIndex(sets, sessions, ME), 5);
    assert.equal(rows.length, 5);
  });
});

test('sessionSummaries drops a session with nothing checked off', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 'empty', owner_email: ME, started_at: daysAgo(1), ended_at: daysAgo(1) },
      { id: 'real', owner_email: ME, started_at: daysAgo(2), ended_at: daysAgo(2) },
    ];
    const sets = [
      // Present but never completed — the mis-tap case.
      { id: 'x1', session_id: 'empty', exercise_id: 'e1', exercise_name: 'Bench',
        set_index: 0, weight_lb: 100, reps: 5, completed_at: null },
      ...buildSets('real', 'e1', 'Bench', [{ w: 100, r: 5 }]),
    ];
    const rows = stats.sessionSummaries(workout.buildIndex(sets, sessions, ME));
    assert.deepEqual(rows.map((r) => r.id), ['real']);
  });
});

test('sessionSummaries keeps a cardio-only session, which has no tonnage', async () => {
  await atTime(NOW, () => {
    const sessions = [{ id: 'run', owner_email: ME, name: 'Easy run',
                        started_at: daysAgo(1), ended_at: daysAgo(1) }];
    const sets = [{ id: 'r1', session_id: 'run', exercise_id: 'c1', exercise_name: 'Running',
                    set_index: 0, weight_lb: null, reps: null,
                    distance_m: 5000, duration_s: 1500, completed_at: daysAgo(1) }];
    const rows = stats.sessionSummaries(workout.buildIndex(sets, sessions, ME));

    assert.equal(rows.length, 1);
    assert.equal(rows[0].volume, 0);
    assert.equal(rows[0].sets, 1);
  });
});

// ---- nutrition, in detail --------------------------------------------------

const day = (i, kcal, target, logged = true) => ({
  date: new Date(Date.parse('2026-08-01T12:00:00.000Z') + i * 86_400_000),
  label: 'W',
  kcal,
  target,
  logged,
});

test('caloriePlot gives an unlogged day no bar, not a zero bar', () => {
  const plot = stats.caloriePlot([day(0, 2000, 2100), day(1, 0, 2100, false), day(2, 2400, 2100)]);
  assert.ok(plot.bars[0].h > 0);
  assert.equal(plot.bars[1].h, 0, 'a gap, not a zero');
  assert.equal(plot.bars[1].logged, false);
  assert.ok(plot.bars[2].h > 0);
});

test('caloriePlot puts the target on the same scale as the bars', () => {
  const plot = stats.caloriePlot([day(0, 1000, 2000)], { height: 40 });
  assert.equal(plot.max, 2000);                 // the target, being the taller of the two
  assert.equal(plot.targetY, 0);                // so it sits at the top
  assert.equal(plot.bars[0].h, 20);             // and the bar is half of it
});

test('caloriePlot marks which days went over', () => {
  const plot = stats.caloriePlot([day(0, 2400, 2100), day(1, 1800, 2100)]);
  assert.equal(plot.bars[0].over, true);
  assert.equal(plot.bars[1].over, false);
});

test('caloriePlot with no target still draws', () => {
  const plot = stats.caloriePlot([day(0, 2000, null), day(1, 1800, null)]);
  assert.equal(plot.targetY, null);
  assert.equal(plot.max, 2000);
  assert.ok(plot.bars.every((b) => b.y >= 0 && b.y + b.h <= plot.height + 1e-9));
});

test('caloriePlot survives an empty window', () => {
  const plot = stats.caloriePlot([]);
  assert.deepEqual(plot.bars, []);
  assert.equal(Number.isFinite(plot.slot), true);
});

test('calorieAdherence counts near-target days as on target', () => {
  const a = stats.calorieAdherence([
    day(0, 2100, 2100),      // exact
    day(1, 2140, 2100),      // 40 over, inside the slack
    day(2, 2400, 2100),      // over
    day(3, 1500, 2100),      // under
  ]);
  assert.equal(a.on, 2);
  assert.equal(a.over, 1);
  assert.equal(a.under, 1);
  assert.equal(a.days, 4);
});

test('calorieAdherence ignores unlogged days but reports how many there were', () => {
  const a = stats.calorieAdherence([
    day(0, 2100, 2100),
    day(1, 0, 2100, false),
    day(2, 0, 2100, false),
  ]);
  assert.equal(a.days, 1);
  assert.equal(a.unlogged, 2);
});

test('calorieAdherence names the biggest miss in either direction', () => {
  const over = stats.calorieAdherence([day(0, 2400, 2100), day(1, 1200, 2100)]);
  assert.equal(over.biggest.delta, -900);       // under by more than the day over

  const under = stats.calorieAdherence([day(0, 3500, 2100), day(1, 1900, 2100)]);
  assert.equal(under.biggest.delta, 1400);
});

test('calorieAdherence returns null when no logged day has a target', () => {
  assert.equal(stats.calorieAdherence([]), null);
  assert.equal(stats.calorieAdherence([day(0, 2000, null)]), null);
  assert.equal(stats.calorieAdherence([day(0, 0, 2100, false)]), null);
});

test('loggingStreak counts only a run that reaches today', () => {
  const broken = stats.loggingStreak([
    day(0, 2000, 2100), day(1, 2000, 2100), day(2, 0, 2100, false),
  ]);
  assert.equal(broken.current, 0, 'it ended yesterday, so it is not current');
  assert.equal(broken.best, 2);

  const running = stats.loggingStreak([
    day(0, 2000, 2100), day(1, 0, 2100, false), day(2, 2000, 2100), day(3, 2000, 2100),
  ]);
  assert.equal(running.current, 2);
  assert.equal(running.best, 2);
});

test('loggingStreak of nothing is zero, not NaN', () => {
  assert.deepEqual(stats.loggingStreak([]), { current: 0, best: 0 });
});

test('signed carries the precision the domain needs', () => {
  // Weight: a column of "-1" beside "-0.8" reads as coarser, not rounder.
  assert.equal(stats.signed(-1, ' lb'), '-1.0 lb');
  assert.equal(stats.signed(-0.8, ' lb'), '-0.8 lb');
  assert.equal(stats.signed(0.4, ' lb'), '+0.4 lb');
  // Calories: no tenth of a calorie was ever measured.
  assert.equal(stats.signed(300, '', 0), '+300');
  assert.equal(stats.signed(-912, '', 0), '-912');
  assert.equal(stats.signed(0, '', 0), '0');
});

test('signed refuses a missing or unusable number', () => {
  assert.equal(stats.signed(null), '—');
  assert.equal(stats.signed(undefined), '—');
  assert.equal(stats.signed(NaN), '—');
  assert.equal(stats.signed('nope'), '—');
  // Number(null) is 0 and finite, which is how a null macro once became zero.
  assert.notEqual(stats.signed(null), '0.0');
});

// ---- a lift, in detail -----------------------------------------------------

test('liftDetail plots one point per session, newest last', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 's1', owner_email: ME, started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T11:00:00.000Z' },
      { id: 's2', owner_email: ME, started_at: '2026-08-08T10:00:00.000Z', ended_at: '2026-08-08T11:00:00.000Z' },
      { id: 's3', owner_email: ME, started_at: '2026-08-15T10:00:00.000Z', ended_at: '2026-08-15T11:00:00.000Z' },
    ];
    // Each session has a warm-up and two working sets; only the top working set counts.
    const sets = [
      ...buildSets('s1', 'e1', 'Bench', [{ w: 95, r: 10, warmup: true }, { w: 185, r: 5 }, { w: 175, r: 5 }]),
      ...buildSets('s2', 'e1', 'Bench', [{ w: 95, r: 10, warmup: true }, { w: 195, r: 5 }]),
      ...buildSets('s3', 'e1', 'Bench', [{ w: 205, r: 5 }]),
    ];
    const index = workout.buildIndex(sets, sessions, ME);
    const detail = stats.liftDetail(index, { id: 'e1', name: 'Bench' });

    assert.equal(detail.series.length, 3, 'one point per session, not per set');
    assert.deepEqual(detail.series.map((p) => p.at.slice(0, 10)),
      ['2026-08-01', '2026-08-08', '2026-08-15'], 'oldest first, so the line reads left to right');
    assert.ok(detail.series[2].lb > detail.series[0].lb);
    assert.equal(detail.latest, detail.series[2].lb);
    assert.equal(detail.best, detail.series[2].lb);
    assert.equal(detail.change, detail.series[2].lb - detail.series[0].lb);
    assert.equal(detail.sessions, 3);
  });
});

test('liftDetail hands back a plot inside its own box', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 's1', owner_email: ME, started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T11:00:00.000Z' },
      { id: 's2', owner_email: ME, started_at: '2026-08-08T10:00:00.000Z', ended_at: '2026-08-08T11:00:00.000Z' },
    ];
    const sets = [...buildSets('s1', 'e1', 'Bench', [{ w: 185, r: 5 }]),
                  ...buildSets('s2', 'e1', 'Bench', [{ w: 195, r: 5 }])];
    const detail = stats.liftDetail(workout.buildIndex(sets, sessions, ME), { id: 'e1', name: 'Bench' });

    assert.equal(detail.plot.points.length, 2);
    for (const pt of detail.plot.points) {
      assert.ok(pt.x >= 0 && pt.x <= detail.plot.width);
      assert.ok(pt.y >= 0 && pt.y <= detail.plot.height);
    }
  });
});

test('liftDetail reports the heaviest single set, which need not be the best 1RM', async () => {
  await atTime(NOW, () => {
    const sessions = [
      { id: 's1', owner_email: ME, started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T11:00:00.000Z' },
      { id: 's2', owner_email: ME, started_at: '2026-08-08T10:00:00.000Z', ended_at: '2026-08-08T11:00:00.000Z' },
    ];
    // 225x1 is heavier but 200x8 estimates higher.
    const sets = [...buildSets('s1', 'e1', 'Bench', [{ w: 225, r: 1 }]),
                  ...buildSets('s2', 'e1', 'Bench', [{ w: 200, r: 8 }])];
    const detail = stats.liftDetail(workout.buildIndex(sets, sessions, ME), { id: 'e1', name: 'Bench' });

    assert.equal(detail.heaviest.best.weight_lb, 225);
    assert.ok(detail.best > 225, 'the estimate can exceed anything actually lifted');
  });
});

test('liftDetail keeps the last six sessions, newest first, for the list', async () => {
  await atTime(NOW, () => {
    const sessions = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`, owner_email: ME,
      started_at: `2026-0${i < 4 ? 6 : 7}-0${(i % 4) + 1}T10:00:00.000Z`,
      ended_at: `2026-0${i < 4 ? 6 : 7}-0${(i % 4) + 1}T11:00:00.000Z`,
    }));
    const sets = sessions.flatMap((x, i) => buildSets(x.id, 'e1', 'Bench', [{ w: 100 + i, r: 5 }]));
    const detail = stats.liftDetail(workout.buildIndex(sets, sessions, ME), { id: 'e1', name: 'Bench' });

    assert.equal(detail.recent.length, 6);
    const dates = detail.recent.map((r) => Date.parse(r.at));
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'newest first');
  });
});

test('liftDetail returns null for a lift with no estimable set', async () => {
  await atTime(NOW, () => {
    const sessions = [{ id: 's1', owner_email: ME,
                        started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T11:00:00.000Z' }];
    // A cardio row: no weight, no reps, so no 1RM to plot.
    const sets = [{ id: 'r1', session_id: 's1', exercise_id: 'c1', exercise_name: 'Running',
                    set_index: 0, weight_lb: null, reps: null,
                    distance_m: 5000, duration_s: 1500, completed_at: '2026-08-01T10:30:00.000Z' }];
    const index = workout.buildIndex(sets, sessions, ME);

    assert.equal(stats.liftDetail(index, { id: 'c1', name: 'Running' }), null);
    assert.equal(stats.liftDetail(index, { id: 'nope', name: 'Never Done' }), null);
  });
});

test('a lift straight out of topLifts can be handed back to liftDetail', async () => {
  await atTime(NOW, () => {
    // The sets carry an exercise_id, so byExercise is keyed by id and a lookup
    // by name finds nothing. Building the lift by hand in the tests above hid
    // that topLifts was not passing the id on.
    const sessions = [
      { id: 's1', owner_email: ME, started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T11:00:00.000Z' },
      { id: 's2', owner_email: ME, started_at: '2026-08-08T10:00:00.000Z', ended_at: '2026-08-08T11:00:00.000Z' },
    ];
    const sets = [...buildSets('s1', 'ex-42', 'Bench Press (Barbell)', [{ w: 185, r: 5 }]),
                  ...buildSets('s2', 'ex-42', 'Bench Press (Barbell)', [{ w: 195, r: 5 }])];
    const index = workout.buildIndex(sets, sessions, ME);

    const lift = stats.topLifts(index)[0];
    assert.equal(lift.id, 'ex-42');

    const detail = stats.liftDetail(index, lift);
    assert.ok(detail, 'the round trip has to work, not just a hand-built lift');
    assert.equal(detail.sessions, 2);
  });
});

test('count pluralises the noun, which four shipped bugs did not', () => {
  assert.equal(stats.count(1, 'day'), '1 day');
  assert.equal(stats.count(2, 'day'), '2 days');
  assert.equal(stats.count(0, 'day'), '0 days');
  assert.equal(stats.count(1, 'serving'), '1 serving');
  assert.equal(stats.count(1, 'exercise', 'exercises'), '1 exercise');
  assert.equal(stats.count(3, 'exercise', 'exercises'), '3 exercises');
});

// ---- consistency -----------------------------------------------------------

/** Finished sessions on the given local dates, newest-first order not required. */
function sessionsOn(dates) {
  return dates.map((d, i) => ({
    id: `c${i}`, owner_email: ME,
    started_at: new Date(`${d}T18:00:00`).toISOString(),
    ended_at: new Date(`${d}T19:00:00`).toISOString(),
  }));
}

const consistencyIndex = (dates) => workout.buildIndex([], sessionsOn(dates), ME);
const AT = (d) => new Date(`${d}T12:00:00`).getTime();

test('a day streak counts back from today', () => {
  const index = consistencyIndex(['2026-08-22', '2026-08-23', '2026-08-24']);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.dayStreak, 3);
  assert.equal(c.daysSinceLast, 0);
});

test('not having trained yet today does not end the streak', () => {
  // Trained through yesterday; it is now 6am and nothing is logged.
  const index = consistencyIndex(['2026-08-22', '2026-08-23']);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.dayStreak, 2, 'still alive on a rest morning');
  assert.equal(c.daysSinceLast, 1);
});

test('a second empty day does end it', () => {
  const index = consistencyIndex(['2026-08-21', '2026-08-22']);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.dayStreak, 0);
  assert.equal(c.daysSinceLast, 2);
});

test('a week streak survives the rest days inside a week', () => {
  // Mondays and Thursdays for three weeks — no two days adjacent.
  const index = consistencyIndex([
    '2026-08-10', '2026-08-13',
    '2026-08-17', '2026-08-20',
    '2026-08-24',
  ]);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.weekStreak, 3);
  assert.equal(c.dayStreak, 1, 'the day streak is honest about it');
});

test('a week with nothing in it breaks the week streak', () => {
  const index = consistencyIndex(['2026-08-03', '2026-08-17', '2026-08-24']);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.weekStreak, 2, 'the week of the 10th is empty');
});

test('a quiet start to the week does not break the week streak', () => {
  // Trained last week, nothing yet this week, and it is only Monday.
  const index = consistencyIndex(['2026-08-17', '2026-08-20']);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.weekStreak, 1);
});

test('the best runs are the best ever, not the current ones', () => {
  const index = consistencyIndex([
    '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04',   // a four-day run
    '2026-08-24',
  ]);
  const c = stats.trainingConsistency(index, { now: AT('2026-08-24') });
  assert.equal(c.dayStreak, 1);
  assert.equal(c.bestDayStreak, 4);
  assert.ok(c.longestGap > 60, 'the summer off is the longest gap');
});

test('trainingConsistency counts sessions and days apart', () => {
  const sessions = [...sessionsOn(['2026-08-24']), ...sessionsOn(['2026-08-24'])]
    .map((s, i) => ({ ...s, id: `dup${i}` }));
  const c = stats.trainingConsistency(workout.buildIndex([], sessions, ME), { now: AT('2026-08-24') });
  assert.equal(c.sessions, 2, 'two workouts');
  assert.equal(c.trainedDays, 1, 'on one day');
  assert.equal(c.dayStreak, 1);
});

test('trainingConsistency ignores unfinished and deleted sessions', () => {
  const sessions = [
    { id: 'a', owner_email: ME, started_at: new Date('2026-08-24T18:00:00').toISOString(), ended_at: null },
    { id: 'b', owner_email: ME, started_at: new Date('2026-08-23T18:00:00').toISOString(),
      ended_at: new Date('2026-08-23T19:00:00').toISOString(), deleted_at: new Date().toISOString() },
  ];
  const c = stats.trainingConsistency(workout.buildIndex([], sessions, ME), { now: AT('2026-08-24') });
  assert.equal(c.any, false);
  assert.equal(c.dayStreak, 0);
  assert.equal(c.daysSinceLast, null);
});

test('trainingConsistency of an empty history does not divide by zero', () => {
  const c = stats.trainingConsistency(workout.buildIndex([], [], ME), { now: AT('2026-08-24') });
  assert.equal(c.any, false);
  assert.equal(c.bestDayStreak, 0);
  assert.equal(c.longestGap, null);
});

test('a late-evening workout counts as that local day, not the UTC one', () => {
  // 9pm Denver on the 24th is the 25th in UTC. The streak must not see a gap.
  const sessions = [{
    id: 'late', owner_email: ME,
    started_at: new Date('2026-08-24T21:00:00').toISOString(),
    ended_at: new Date('2026-08-24T22:00:00').toISOString(),
  }];
  const c = stats.trainingConsistency(workout.buildIndex([], sessions, ME), { now: AT('2026-08-24') });
  assert.equal(c.daysSinceLast, 0);
  assert.equal(c.dayStreak, 1);
});

test('trainingGrid lays out whole Monday-anchored weeks', () => {
  const grid = stats.trainingGrid(consistencyIndex(['2026-08-24']), { weeks: 4, now: AT('2026-08-24') });
  assert.equal(grid.length, 4);
  assert.ok(grid.every((col) => col.cells.length === 7));
  assert.equal(grid[0].start.getDay(), 1, 'columns start on Monday');

  const flat = grid.flatMap((c) => c.cells);
  assert.equal(flat.filter((c) => c.trained).length, 1);
  assert.equal(flat.find((c) => c.trained).key, '2026-08-24');
});

test('trainingGrid marks days that have not happened yet', () => {
  const grid = stats.trainingGrid(consistencyIndex([]), { weeks: 2, now: AT('2026-08-24') });
  const flat = grid.flatMap((c) => c.cells);
  // 2026-08-24 is a Monday, so the rest of its week is still to come.
  assert.equal(flat.filter((c) => c.future).length, 6);
  assert.equal(flat.filter((c) => c.trained).length, 0);
});

test('trainingGrid counts two workouts on one day as one trained cell', () => {
  const sessions = [...sessionsOn(['2026-08-24']), ...sessionsOn(['2026-08-24'])]
    .map((s, i) => ({ ...s, id: `g${i}` }));
  const grid = stats.trainingGrid(workout.buildIndex([], sessions, ME), { weeks: 1, now: AT('2026-08-24') });
  const cell = grid.flatMap((c) => c.cells).find((c) => c.key === '2026-08-24');
  assert.equal(cell.trained, true);
  assert.equal(cell.sessions, 2);
});

// ---- what the finish popup says --------------------------------------------

const first = (list) => list[0];

test('the first workout ever is called out as the first', () => {
  const note = stats.finishNote({ sessions: 1, dayStreak: 1, weekStreak: 1 }, {}, { pick: first });
  assert.equal(note.headline, 'First one logged');
});

test('a new best day streak beats the stock line', () => {
  const note = stats.finishNote(
    { sessions: 20, dayStreak: 5, bestDayStreak: 5, weekStreak: 3, bestWeekStreak: 6 }, {}, { pick: first });
  assert.equal(note.headline, '3 weeks in a row');
  assert.match(note.note, /5 days straight/);
  assert.match(note.note, /longest run yet/);
});

test('a new best week streak is said in weeks', () => {
  const note = stats.finishNote(
    { sessions: 40, dayStreak: 1, bestDayStreak: 6, weekStreak: 9, bestWeekStreak: 9 }, {}, { pick: first });
  assert.match(note.note, /9 weeks without missing one/);
});

test('coming back after a lapse is acknowledged, not scored as 1', () => {
  const note = stats.finishNote(
    { sessions: 30, dayStreak: 1, bestDayStreak: 5, weekStreak: 1, bestWeekStreak: 7 }, {}, { pick: first });
  assert.equal(note.headline, 'Back at it');
  assert.match(note.note, /restarts today/);
});

test('an ordinary session in a running streak looks forward', () => {
  const note = stats.finishNote(
    { sessions: 30, dayStreak: 1, bestDayStreak: 9, weekStreak: 3, bestWeekStreak: 7 }, {}, { pick: first });
  assert.equal(note.headline, '3 weeks in a row');
  assert.match(note.note, /next week makes 4/);
});

test('with nothing notable it reaches for the list', () => {
  const note = stats.finishNote(
    { sessions: 30, dayStreak: 1, bestDayStreak: 9, weekStreak: 1, bestWeekStreak: 1 }, {}, { pick: first });
  assert.equal(note.headline, 'Workout done');
  assert.equal(note.note, 'Logged. That is the part most people skip.');
});

test('finishNote pluralises its streaks', () => {
  const one = stats.finishNote(
    { sessions: 30, dayStreak: 2, bestDayStreak: 9, weekStreak: 1, bestWeekStreak: 1 }, {}, { pick: first });
  assert.equal(one.headline, '2 days in a row');
  assert.ok(!/\b1 days\b|\b1 weeks\b/.test(JSON.stringify(one)));
});

test('finishNote survives being handed nothing', () => {
  const note = stats.finishNote(null, {}, { pick: first });
  assert.ok(note.headline);
  assert.ok(note.note);
});
