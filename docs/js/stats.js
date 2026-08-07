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
