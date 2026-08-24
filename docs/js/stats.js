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

// ---- chart geometry --------------------------------------------------------
//
// Charts are built as plain SVG in the template. These return the numbers the
// markup needs so no arithmetic lives in the HTML.

/** Bars sized to the tallest value, floored so an empty week still shows a stub. */
export function barGeometry(values, { height = 60, gap = 2 } = {}) {
  const max = Math.max(...values, 1);
  const width = 100 / values.length;

  return values.map((v, i) => ({
    x: i * width,
    width: width - gap,
    height: Math.max(v > 0 ? 2 : 0, (v / max) * height),
    y: height - Math.max(v > 0 ? 2 : 0, (v / max) * height),
    value: v,
  }));
}

/** A polyline through a series, padded so the extremes aren't clipped. */
export function linePoints(values, { width = 100, height = 50, pad = 4 } = {}) {
  if (values.length < 2) return { points: '', last: null };

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const coords = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return { x, y, v };
  });

  return {
    points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '),
    last: coords[coords.length - 1],
  };
}


// ---- chart markup ----------------------------------------------------------
//
// Returned as strings rather than driven by x-for, for two reasons: a <template>
// inside an <svg> is parsed as an SVG element with no `.content`, so Alpine
// cannot clone it — and building 26 bars as reactive bindings costs more than
// generating the markup once.

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function barChart(bars, { fill, emphasiseLast = false, dimUnlogged = false } = {}) {
  return bars.map((bar, i) => {
    const last = emphasiseLast && i === bars.length - 1;
    const opacity = dimUnlogged ? (bar.logged ? 0.9 : 0.25) : (last ? 1 : 0.55);
    return `<rect x="${bar.x.toFixed(2)}" y="${bar.y.toFixed(2)}"`
      + ` width="${bar.width.toFixed(2)}" height="${bar.height.toFixed(2)}"`
      + ` rx="1.2" fill="${fill}" opacity="${opacity}">`
      + `<title>${esc(bar.tip ?? '')}</title></rect>`;
  }).join('');
}

export function lineChart(points, { stroke }) {
  if (!points) return '';
  return `<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="2"`
    + ' stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
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
 * The gap since the previous weigh-in, in words.
 *
 * Lives here rather than in the template because "1 days" is the mistake this
 * project keeps shipping — it reached production as "1serving" and again as
 * "2 serving" — and a template string is not somewhere a test can reach.
 */
export function gapLabel(days) {
  if (days == null) return 'First reading';
  return `${days} day${days === 1 ? '' : 's'} after the one before`;
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
