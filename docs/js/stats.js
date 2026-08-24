/**
 * stats.js — trends, computed on the device.
 *
 * Everything here reads arrays already in IndexedDB. No queries, no aggregation
 * on the server, and it works offline — which matters because the interesting
 * data is two years of imported training history that already lives locally.
 */

import * as local from './local.js';
import * as sync from './sync.js';
import { estimate1RM, historyOf } from './workout.js';
import { dayBounds, addDays, toDateOnly, entriesForDay, sumTotals, currentGoal } from './food.js';

const DAY = 86_400_000;

// ---- body weight -----------------------------------------------------------

export function weightSeries(weightLog, ownerEmail, days = 90) {
  const cutoff = Date.now() - days * DAY;

  return weightLog
    .filter((w) => w.owner_email === ownerEmail && !w.deleted_at)
    .filter((w) => new Date(w.measured_at).getTime() >= cutoff)
    .map((w) => ({ at: w.measured_at, lb: Number(w.weight_lb) }))
    .filter((w) => Number.isFinite(w.lb))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function weightSummary(series, goal) {
  if (!series.length) return null;

  const latest = series[series.length - 1];
  const first = series[0];
  const target = Number(goal?.target_weight_lb) || null;

  return {
    latest: latest.lb,
    change: Math.round((latest.lb - first.lb) * 10) / 10,
    span: series.length,
    target,
    toGo: target ? Math.round((latest.lb - target) * 10) / 10 : null,
  };
}

export async function logWeight(lb, ownerEmail, at = new Date()) {
  const row = await local.save('weight_log', {
    measured_at: at.toISOString(),
    weight_lb: Number(lb),
  }, ownerEmail);
  sync.nudge();
  return row;
}

// ---- training --------------------------------------------------------------

/** Monday-anchored week start, so weeks line up with how people plan them. */
function weekStart(date) {
  const d = dayBounds(date).start;
  const shift = (d.getDay() + 6) % 7;
  return addDays(d, -shift);
}

export function weeklyTraining(index, weeks = 12) {
  const buckets = new Map();
  const firstWeek = weekStart(addDays(new Date(), -(weeks - 1) * 7));

  for (let i = 0; i < weeks; i++) {
    const start = addDays(firstWeek, i * 7);
    buckets.set(toDateOnly(start), { start, volume: 0, sessions: 0 });
  }

  for (const session of index.owned) {
    if (!session.ended_at) continue;
    const bucket = buckets.get(toDateOnly(weekStart(new Date(session.started_at))));
    if (!bucket) continue;

    bucket.sessions += 1;
    bucket.volume += index.volumeBySession.get(session.id) ?? 0;
  }

  return [...buckets.values()].map((b) => ({ ...b, volume: Math.round(b.volume) }));
}

/**
 * Best estimated 1RM per exercise, and whether it's moving.
 *
 * Ranked by how much you actually do the lift, not by how heavy it is — the
 * exercises you care about are the ones you keep coming back to.
 */
export function topLifts(index, limit = 6) {
  const counts = new Map();
  for (const [key, sets] of index.byExercise) {
    const working = sets.filter((s) => s.completed_at && !s.is_warmup);
    if (!working.length) continue;
    counts.set(key, { id: working[0].exercise_id, name: working[0].exercise_name, n: working.length });
  }

  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map(({ id, name }) => {
      const history = historyOf(index, id, name, 1000);
      const rms = history.map((h) => h.oneRm).filter(Boolean);
      if (!rms.length) return null;

      const best = Math.max(...rms);
      const latest = rms[0];                       // history is newest-first
      const previous = rms.slice(1, 6);            // recent form, not one lucky day
      const baseline = previous.length ? Math.max(...previous) : null;

      return {
        // Carried out because byExercise is keyed by id wherever a set has one,
        // so anything looking this lift up again needs the id and not just the
        // name — liftDetail found nothing at all without it.
        id,
        name,
        best,
        latest,
        delta: baseline ? latest - baseline : null,
        sessions: history.length,
        isBest: latest >= best,
      };
    })
    .filter(Boolean);
}

// ---- nutrition -------------------------------------------------------------

export function calorieDays(log, goals, ownerEmail, days = 14) {
  const out = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(new Date(), -i);
    const entries = entriesForDay(log, ownerEmail, date);
    const goal = currentGoal(goals, ownerEmail, date);

    out.push({
      date,
      label: date.toLocaleDateString(undefined, { weekday: 'narrow' }),
      kcal: Math.round(sumTotals(entries).calories),
      target: Number(goal?.calorie_target) || null,
      logged: entries.length > 0,
    });
  }
  return out;
}

/** Averages over days that were actually logged — a blank day isn't a zero-calorie day. */
export function calorieSummary(days) {
  const logged = days.filter((d) => d.logged);
  if (!logged.length) return null;

  const mean = logged.reduce((sum, d) => sum + d.kcal, 0) / logged.length;
  const target = logged[logged.length - 1].target;

  return {
    average: Math.round(mean),
    target,
    delta: target ? Math.round(mean - target) : null,
    loggedDays: logged.length,
    totalDays: days.length,
  };
}

// ---- body weight, in detail -------------------------------------------------
// Four readings is not a trend, and the honest thing is to say so rather than
// draw a confident line through noise. Everything here reports how much it had
// to work with so the UI can be careful.

/** Every reading, newest first, with the step from the one before it. */
export function weightReadings(series) {
  return series
    .map((point, i) => {
      const previous = i > 0 ? series[i - 1] : null;
      return {
        at: point.at,
        lb: point.lb,
        delta: previous ? round1(point.lb - previous.lb) : null,
        daysSincePrevious: previous
          ? Math.max(1, Math.round((Date.parse(point.at) - Date.parse(previous.at)) / DAY))
          : null,
      };
    })
    .reverse();
}

/**
 * A number with its sign shown, for a column where the direction is the point.
 *
 * `decimals` is explicit because the right precision is per-domain, not
 * universal: weight wants one, so that a column of "-1.0" and "-0.8" aligns
 * under tabular-nums, and calories want none, because "+300.0 kcal" claims a
 * tenth of a calorie nobody measured.
 */
export function signed(n, unit = '', decimals = 1) {
  if (n == null) return '\u2014';
  const value = Number(n);
  if (!Number.isFinite(value)) return '\u2014';
  return `${value > 0 ? '+' : ''}${value.toFixed(decimals)}${unit}`;
}

/**
 * "1 day", "2 days" — the plural this project keeps getting wrong.
 *
 * Shipped as "1serving", then "2 serving", then "1 days after the one before",
 * then "1 days logged". Four times is enough to stop writing it by hand in
 * template strings where no test can see it.
 */
export function count(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * The gap since the previous weigh-in, in words.
 *
 * Lives here rather than in the template because "1 days" is the mistake this
 * project keeps shipping — it reached production as "1serving" and again as
 * "2 serving" — and a template string is not somewhere a test can reach.
 */
export function gapLabel(days) {
  if (days == null) return 'First reading';
  return `${count(days, 'day')} after the one before`;
}

/**
 * Least squares over (days, lb), reported per week because that is the unit
 * people actually think in.
 *
 * r2 is carried out deliberately: a slope through scattered weigh-ins looks
 * exactly as authoritative as a slope through a clean run, and it should not.
 * Under three readings there is no line worth drawing at all.
 */
export function weightTrend(series, { target = null, now = Date.now() } = {}) {
  if (series.length < 3) {
    return { enough: false, points: series.length, needed: 3 };
  }

  const t0 = Date.parse(series[0].at);
  const xs = series.map((p) => (Date.parse(p.at) - t0) / DAY);
  const ys = series.map((p) => p.lb);
  const n = xs.length;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  // Every weigh-in on the same day: a vertical scatter, not a trend.
  if (sxx === 0) return { enough: false, points: n, needed: 3, sameDay: true };

  const slope = sxy / sxx;                       // lb per day
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

  const latest = series[series.length - 1];
  const lbPerWeek = round1(slope * 7);

  // Only project when the line actually points at the target. "142 lb by never"
  // is the truthful answer to a slope going the wrong way.
  let projectedAt = null;
  let weeksAway = null;
  if (target != null && slope !== 0) {
    const daysAway = (target - latest.lb) / slope;
    if (daysAway > 0 && daysAway < 365 * 3) {
      projectedAt = new Date(Date.parse(latest.at) + daysAway * DAY).toISOString();
      weeksAway = round1(daysAway / 7);
    }
  }

  return {
    enough: true,
    points: n,
    lbPerWeek,
    direction: lbPerWeek > 0.1 ? 'up' : lbPerWeek < -0.1 ? 'down' : 'flat',
    r2: Math.round(r2 * 100) / 100,
    // A line this scattered should be described, not trusted.
    noisy: r2 < 0.5,
    spanDays: Math.round((Date.parse(latest.at) - t0) / DAY),
    projectedAt,
    weeksAway,
    now,
  };
}

/**
 * This window against the one before it — the "compared to history" question.
 *
 * Averaged rather than compared endpoint-to-endpoint, because day-to-day body
 * weight swings by more than a week of real change.
 */
export function weightWindows(series, days = 7, now = Date.now()) {
  const inWindow = (from, to) => series.filter((p) => {
    const at = Date.parse(p.at);
    return at > from && at <= to;
  });

  const recent = inWindow(now - days * DAY, now);
  const prior = inWindow(now - 2 * days * DAY, now - days * DAY);
  const mean = (rows) => (rows.length ? round1(rows.reduce((a, b) => a + b.lb, 0) / rows.length) : null);

  const recentMean = mean(recent);
  const priorMean = mean(prior);

  return {
    days,
    recent: recentMean,
    prior: priorMean,
    recentCount: recent.length,
    priorCount: prior.length,
    // Null rather than zero when there is nothing to compare against: "no
    // change" and "no data" are different answers.
    change: recentMean != null && priorMean != null ? round1(recentMean - priorMean) : null,
  };
}

/** Highest, lowest and the whole range, which a trend line hides. */
export function weightExtremes(series) {
  if (!series.length) return null;
  const high = series.reduce((a, b) => (b.lb > a.lb ? b : a));
  const low = series.reduce((a, b) => (b.lb < a.lb ? b : a));
  return { high, low, range: round1(high.lb - low.lb) };
}

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Plot geometry for the weight chart, as data rather than as an SVG string.
 *
 * The older charts here build markup and hand it to x-html, which cannot carry a
 * hover layer — you get a picture, not a chart you can interrogate. This returns
 * coordinates so the template can render real elements and put a crosshair and a
 * tooltip on them.
 *
 * The y-axis is padded around the data rather than zeroed: body weight varies by
 * two or three pounds against a value near 180, and a zero baseline flattens
 * every real movement into a straight line.
 */
export function weightPlot(series, { width = 100, height = 46, pad = 3, target = null } = {}) {
  if (!series.length) return null;

  const lbs = series.map((p) => p.lb);
  let lo = Math.min(...lbs);
  let hi = Math.max(...lbs);
  if (target != null) { lo = Math.min(lo, target); hi = Math.max(hi, target); }

  // A flat series would divide by zero; give it a pound of air either side.
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  const headroom = (hi - lo) * 0.15;
  lo -= headroom;
  hi += headroom;

  const t0 = Date.parse(series[0].at);
  const t1 = Date.parse(series[series.length - 1].at);
  const spanMs = t1 - t0;

  const x = (at) => (spanMs === 0
    ? width / 2
    : pad + ((Date.parse(at) - t0) / spanMs) * (width - pad * 2));
  const y = (lb) => pad + (1 - (lb - lo) / (hi - lo)) * (height - pad * 2);

  const points = series.map((p) => ({
    at: p.at, lb: p.lb,
    x: round2(x(p.at)), y: round2(y(p.lb)),
  }));

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

  return {
    width, height, points, line,
    // Closed back along the baseline, so the line can carry a soft fill.
    area: `${line} L${points[points.length - 1].x} ${height} L${points[0].x} ${height} Z`,
    targetY: target == null ? null : round2(y(target)),
    lo: round1(lo), hi: round1(hi),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---- training, in detail ----------------------------------------------------

/**
 * Bars for the weekly-volume chart, as geometry rather than markup.
 *
 * The old chart was an SVG string with `preserveAspectRatio="none"`, which both
 * stretched the bars and left nothing for a pointer to interrogate. These are
 * real coordinates in a real aspect ratio, and `slot` is carried out so the
 * hover layer can turn a pointer x into a week index — a zero-volume week has
 * no rectangle to hit but is still a week you can ask about.
 */
export function volumePlot(weeks, { width = 100, height = 40, gap = 1.4 } = {}) {
  const slot = width / Math.max(weeks.length, 1);
  const max = Math.max(...weeks.map((w) => w.volume), 1);

  return {
    width,
    height,
    slot,
    max,
    bars: weeks.map((week, i) => {
      // A trained week always draws something: 400 lb against a 40k week
      // rounds to nothing, and "no bar" already means "no session".
      const h = week.volume > 0 ? Math.max(0.8, (week.volume / max) * height) : 0;
      return {
        i,
        x: i * slot,
        w: Math.max(slot - gap, 0.5),
        y: height - h,
        h,
        volume: week.volume,
        sessions: week.sessions,
        start: week.start,
      };
    }),
  };
}

/**
 * The numbers around the chart.
 *
 * Averaged over weeks that were actually trained, matching calorieSummary's
 * reasoning that a blank day is not a zero — twelve weeks of history that only
 * contains nine weeks of training should not report a quarter less volume than
 * was lifted.
 *
 * `partial` matters: the current week is compared against a finished one, so
 * the UI has to be able to say the comparison is not yet fair.
 */
export function volumeStats(weeks, { now = Date.now() } = {}) {
  if (!weeks.length) return null;

  const current = weeks[weeks.length - 1];
  const previous = weeks.length > 1 ? weeks[weeks.length - 2] : null;
  const trained = weeks.filter((w) => w.sessions > 0);

  const best = trained.reduce((top, w) => (top && top.volume >= w.volume ? top : w), null);
  const daysIn = Math.min(7, Math.floor((now - current.start.getTime()) / DAY) + 1);

  return {
    current: current.volume,
    previous: previous ? previous.volume : null,
    change: previous ? current.volume - previous.volume : null,
    average: trained.length
      ? Math.round(trained.reduce((sum, w) => sum + w.volume, 0) / trained.length)
      : 0,
    best: best ? { volume: best.volume, start: best.start } : null,
    sessions: weeks.reduce((sum, w) => sum + w.sessions, 0),
    weeksTrained: trained.length,
    weeks: weeks.length,
    perWeek: trained.length
      ? round1(weeks.reduce((sum, w) => sum + w.sessions, 0) / trained.length)
      : 0,
    partial: daysIn < 7,
    daysIn,
  };
}

/**
 * Finished sessions, newest first, with what each one actually contained.
 *
 * Duration comes from the timestamps rather than a stored field, so a session
 * left running and ended later reads as however long it was open. Past six
 * hours that is a forgotten timer rather than a workout — which is a thing this
 * app already sends a notification about — and no duration beats a wrong one.
 */
export function sessionSummaries(index, limit = 12) {
  const out = [];

  for (const session of index.owned) {
    if (!session.ended_at) continue;
    if (out.length >= limit) break;

    const sets = (index.bySession.get(session.id) ?? []).filter((s) => !s.deleted_at);
    const done = sets.filter((s) => s.completed_at);

    // Started, ended, nothing checked off. It is a mis-tap, not a workout, and
    // it read as "Workout · 0 sets · 0 exercises". Tested on completed sets
    // rather than on volume, so a run — which has no tonnage by design — stays.
    if (!done.length) continue;

    const minutes = Math.round(
      (Date.parse(session.ended_at) - Date.parse(session.started_at)) / 60_000);

    out.push({
      id: session.id,
      at: session.started_at,
      name: session.name || 'Workout',
      volume: Math.round(index.volumeBySession.get(session.id) ?? 0),
      sets: done.length,
      exercises: new Set(done.map((s) => s.exercise_id ?? s.exercise_name)).size,
      minutes: minutes > 0 && minutes <= 6 * 60 ? minutes : null,
    });
  }

  return out;
}

// ---- nutrition, in detail ---------------------------------------------------

/**
 * Bars for the calorie chart, plus where the target sits on the same scale.
 *
 * An unlogged day is not a zero-calorie day, so it gets no bar at all rather
 * than a bar of height zero — the gap is the honest mark for "we don't know".
 */
export function caloriePlot(days, { width = 100, height = 40, gap = 1.4 } = {}) {
  const slot = width / Math.max(days.length, 1);
  const target = days.reduce((t, d) => t ?? d.target, null) ?? null;
  const max = Math.max(...days.map((d) => d.kcal), target ?? 0, 1);

  return {
    width,
    height,
    slot,
    max,
    targetY: target ? height - (target / max) * height : null,
    target,
    bars: days.map((day, i) => {
      const h = day.logged && day.kcal > 0 ? Math.max(0.8, (day.kcal / max) * height) : 0;
      return {
        i,
        x: i * slot,
        w: Math.max(slot - gap, 0.5),
        y: height - h,
        h,
        kcal: day.kcal,
        date: day.date,
        label: day.label,
        logged: day.logged,
        target: day.target ?? null,
        over: day.target ? day.kcal > day.target : null,
      };
    }),
  };
}

/**
 * How the logged days sat against their targets.
 *
 * Counted only over days that were logged, and `unlogged` is reported so the
 * card can admit its own gaps instead of implying fourteen clean days. A day
 * within `slack` of target counts as on it: nobody eats to the calorie, and
 * "6 over" is not a miss worth colouring.
 */
export function calorieAdherence(days, { slack = 50 } = {}) {
  const logged = days.filter((d) => d.logged && d.target);
  if (!logged.length) return null;

  let over = 0;
  let under = 0;
  let on = 0;
  for (const day of logged) {
    const delta = day.kcal - day.target;
    if (Math.abs(delta) <= slack) on += 1;
    else if (delta > 0) over += 1;
    else under += 1;
  }

  const worst = logged.reduce((top, d) =>
    (top && Math.abs(top.kcal - top.target) >= Math.abs(d.kcal - d.target) ? top : d), null);

  return {
    days: logged.length,
    unlogged: days.length - days.filter((d) => d.logged).length,
    over,
    under,
    on,
    slack,
    biggest: worst ? { date: worst.date, kcal: worst.kcal, delta: worst.kcal - worst.target } : null,
  };
}

/**
 * The longest run of consecutive logged days ending today, and the best run in
 * the window. A streak that ended yesterday is not a current streak.
 */
export function loggingStreak(days) {
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (!days[i].logged) break;
    current += 1;
  }

  let best = 0;
  let run = 0;
  for (const day of days) {
    run = day.logged ? run + 1 : 0;
    if (run > best) best = run;
  }

  return { current, best };
}

// ---- a lift, in detail ------------------------------------------------------

/**
 * One lift's estimated 1RM over time, as a line plus the numbers around it.
 *
 * Built from historyOf, so it is one point per session — the best working set
 * of that day, not every set — because a session's 1RM is what its top set
 * says, and plotting all of them draws the warm-up ramp as a sawtooth.
 *
 * Reuses weightPlot for the geometry: the shape is identical (a value against a
 * date, an axis framed to the data), and there is no reason for two of them.
 */
export function liftDetail(index, lift, { limit = 30 } = {}) {
  const history = historyOf(index, lift.id, lift.name, limit)
    .filter((h) => h.oneRm)
    .reverse();                                   // historyOf is newest-first

  if (!history.length) return null;

  const series = history.map((h) => ({ at: h.date, lb: Math.round(h.oneRm) }));
  const first = series[0];
  const latest = series[series.length - 1];

  return {
    name: lift.name,
    series,
    plot: weightPlot(series, { height: 26 }),
    sessions: history.length,
    best: Math.max(...series.map((p) => p.lb)),
    latest: latest.lb,
    // Over the window shown, not over all time — the card says how long it is.
    change: series.length > 1 ? latest.lb - first.lb : null,
    heaviest: history.reduce((top, h) => (
      top && (top.best?.weight_lb ?? 0) >= (h.best?.weight_lb ?? 0) ? top : h), null),
    recent: history.slice(-6).reverse().map((h) => ({
      at: h.date,
      oneRm: Math.round(h.oneRm),
      weight: h.best?.weight_lb ?? null,
      reps: h.best?.reps ?? null,
      sets: h.sets.filter((s) => s.completed_at && !s.is_warmup).length,
    })),
  };
}
