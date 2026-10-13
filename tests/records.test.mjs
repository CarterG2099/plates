/**
 * Knowing whether you are getting stronger: records, stalls, strength for your
 * size, and protein for your size.
 *
 * The record check is shared by the PR timeline and the stall flag, so these
 * pin what "improved" means once, and then what each view does with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const stats = await import('../docs/js/stats.js');
const workout = await import('../docs/js/workout.js');

const ME = 'me@example.com';
const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/**
 * An index from sessions written oldest first as
 *   [date, [[weight, reps, extra?], ...]]  for one exercise, 'squat'.
 */
function indexOf(sessions, { exercise = 'squat', name = 'Squat (Barbell)', open = null } = {}) {
  const rows = [];
  const sess = sessions.map(([date, sets], i) => {
    const id = `s${i}`;
    sets.forEach(([weight_lb, reps, extra = {}], j) => rows.push({
      id: `${id}-${j}`, owner_email: ME, session_id: id, exercise_id: exercise, exercise_name: name,
      set_index: j, weight_lb, reps, completed_at: date, is_warmup: false, ...extra,
    }));
    return { id, owner_email: ME, started_at: date, ended_at: id === open ? null : date };
  });
  return workout.buildIndex(rows, sess, ME);
}

const walkOf = (sessions) => stats.recordWalk(workout.historyOf(indexOf(sessions), 'squat', 'squat', Infinity));
const kindsOf = (sessions) => walkOf(sessions).map((s) => s.kinds);

const d = (n) => `2026-0${Math.floor(n / 28) + 1}-${String((n % 28) + 1).padStart(2, '0')}T12:00:00Z`;

// ---- what counts as a record ------------------------------------------------

test('the first session is the baseline and sets no record', () => {
  assert.deepEqual(kindsOf([[d(0), [[225, 5]]]]), [[]]);
});

test('a heavier top set is a weight record, and a 1RM one when it estimates higher', () => {
  assert.deepEqual(kindsOf([[d(0), [[225, 5]]], [d(7), [[235, 5]]]])[1].sort(), ['1rm', 'weight']);
});

test('more reps at the same weight is a rep record', () => {
  const walk = walkOf([[d(0), [[225, 8]]], [d(7), [[225, 9]]]]);
  assert.ok(walk[1].kinds.includes('reps'));
  assert.deepEqual(walk[1].repSet, { weight: 225, reps: 9 });
});

test('more reps at a lighter weight than you have already done more reps at is not a record', () => {
  // 205 x 10 after 225 x 10: you have done 10 at heavier, so 10 at 205 proves nothing.
  assert.deepEqual(kindsOf([[d(0), [[225, 10]]], [d(7), [[205, 10]]]])[1], []);
});

test('more reps at a lighter weight than anything heavier has managed is a rep record', () => {
  // 205 x 12 after 225 x 10: nothing at 205 or heavier ever reached 12.
  assert.ok(kindsOf([[d(0), [[225, 10]]], [d(7), [[205, 12]]]])[1].includes('reps'));
});

test('repeating the same session sets nothing', () => {
  assert.deepEqual(kindsOf([[d(0), [[245, 8], [245, 6]]], [d(7), [[245, 8], [245, 6]]]])[1], []);
});

test('warm-ups and unfinished sets cannot set records', () => {
  const kinds = kindsOf([
    [d(0), [[225, 5]]],
    [d(7), [[315, 5, { is_warmup: true }], [300, 5, { completed_at: null }], [225, 5]]],
  ]);
  assert.deepEqual(kinds[1], []);
});

test('a bodyweight lift records reps, never weight or 1RM', () => {
  assert.deepEqual(kindsOf([[d(0), [[null, 8]]], [d(7), [[null, 10]]]])[1], ['reps']);
});

// ---- the PR timeline ----------------------------------------------------------

test('the timeline lists records newest first, with the lift and when', () => {
  const index = indexOf([[d(0), [[225, 5]]], [d(7), [[235, 5]]], [d(14), [[235, 5]]], [d(21), [[235, 6]]]]);
  const { events, lastByKey } = stats.prTimeline(index);
  assert.deepEqual(events.map((e) => e.at), [d(21), d(7)]);
  assert.equal(events[0].name, 'Squat (Barbell)');
  assert.deepEqual(events[0].kinds.sort(), ['1rm', 'reps']);
  assert.equal(lastByKey.get('squat'), d(21));
});

test('the timeline is capped', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => [d(i * 3), [[200 + i * 5, 5]]]);
  assert.equal(stats.prTimeline(indexOf(sessions), { limit: 4 }).events.length, 4);
});

// ---- stalls -------------------------------------------------------------------

test('three sessions without a record is a stall, with one more rep as the next step', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[245, 8]]],
    [d(14), [[245, 8], [245, 6]]], [d(21), [[245, 8], [245, 6]]], [d(28), [[245, 8], [245, 5]]],
  ]), 'squat', 'squat', Infinity);
  const stall = stats.stallFor(history);
  assert.equal(stall.since, 3);
  assert.deepEqual(stall.top, { weight: 245, reps: 8 });
  assert.deepEqual(stall.next, { weight: 245, reps: 9 });
});

test('two sessions without a record is not yet a stall', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[245, 8]]], [d(14), [[245, 8]]], [d(21), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.equal(stats.stallFor(history), null);
});

test('at 12 reps the next step is five pounds more and back to 8', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[100, 12]]], [d(7), [[100, 12]]], [d(14), [[100, 12]]], [d(21), [[100, 12]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stats.stallFor(history).next, { weight: 105, reps: 8 });
});

test('a bodyweight stall only ever asks for another rep', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[null, 15]]], [d(7), [[null, 15]]], [d(14), [[null, 15]]], [d(21), [[null, 15]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stats.stallFor(history).next, { weight: 0, reps: 16 });
});

test('the stall map leaves out the session you are in the middle of', () => {
  const sessions = [
    [d(0), [[225, 8]]], [d(7), [[245, 8]]],
    [d(14), [[245, 8]]], [d(21), [[245, 8]]], [d(28), [[245, 8]]],
    [d(35), [[245, 8]]],                          // today, unfinished
  ];
  const index = indexOf(sessions, { open: 's5' });
  assert.equal(stats.stallMap(index, 's5').get('squat').since, 3);
});

// ---- strength for your size --------------------------------------------------

const weights = (...pairs) => pairs.map(([at, lb]) => ({ at, lb }));

test('relative strength divides the 1RM by the nearest weigh-in, now and ~3 months back', () => {
  const history = workout.historyOf(indexOf([
    ['2026-06-10T12:00:00Z', [[225, 5]]],         // 1RM 263
    ['2026-09-01T12:00:00Z', [[225, 5]]],         // same lift, lighter body
  ]), 'squat', 'squat', Infinity);
  const rs = stats.relativeStrength(history, weights(['2026-06-11T08:00:00Z', 200], ['2026-08-30T08:00:00Z', 180]));
  assert.equal(rs.ratio, 1.46);                    // 263 / 180
  assert.equal(rs.then.ratio, 1.32);               // 263 / 200
  assert.equal(rs.then.at, '2026-06-10T12:00:00Z');
});

test('a session with no weigh-in within two weeks has no ratio, rather than a guessed one', () => {
  const history = workout.historyOf(indexOf([['2026-09-01T12:00:00Z', [[225, 5]]]]), 'squat', 'squat', Infinity);
  assert.equal(stats.relativeStrength(history, weights(['2026-07-01T08:00:00Z', 180])), null);
  assert.equal(stats.relativeStrength(history, []), null);
});

// ---- protein for your size ------------------------------------------------------

const day = (protein, extra = {}) => ({ logged: true, complete: true, protein, proteinKnown: true, proteinTarget: 180, ...extra });

test('protein is averaged over complete days and divided by body weight', () => {
  const p = stats.proteinSummary([day(160), day(180), day(170)], 200);
  assert.deepEqual(p, { average: 170, days: 3, target: 180, perLb: 0.85, status: 'ok' });
});

test('a day with a food of unknown protein, or an unfinished day, stays out of the average', () => {
  const p = stats.proteinSummary([day(160), day(20, { proteinKnown: false }), day(40, { complete: false })], 200);
  assert.equal(p.average, 160);
  assert.equal(p.days, 1);
});

test('protein per lb is flagged against 0.7-1.0 g', () => {
  assert.equal(stats.proteinSummary([day(120)], 200).status, 'low');
  assert.equal(stats.proteinSummary([day(220)], 200).status, 'high');
});

test('no body weight still gives the average, just not per lb', () => {
  const p = stats.proteinSummary([day(150)], null);
  assert.equal(p.average, 150);
  assert.equal(p.perLb, null);
  assert.equal(p.status, null);
});

// ---- how long ago -------------------------------------------------------------

test('agoLabel gets coarser as it gets older, and pluralises', () => {
  assert.equal(stats.agoLabel(0), 'today');
  assert.equal(stats.agoLabel(1), '1 day ago');
  assert.equal(stats.agoLabel(9), '9 days ago');
  assert.equal(stats.agoLabel(14), '2 weeks ago');
  assert.equal(stats.agoLabel(59), '8 weeks ago');
  assert.equal(stats.agoLabel(95), '3 months ago');
});

// ---- where each one shows -------------------------------------------------------

test('the workout card shows the stall nudge, built once per refresh without the running session', async () => {
  const app = await source('../docs/js/app.js');
  assert.match(app, /raw\.stalls = stats\.stallMap\(raw\.index, running\?\.id \?\? null\)/);
  assert.match(app, /return `No PR in \$\{stats\.count\(stall\.since, 'session'\)\} · try \$\{step\}`/);
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="stall" x-show="stallLine\(group\)" x-cloak\s*x-text="stallLine\(group\)"><\/div>/);
});

test('the stats page has the PR timeline, and each lift its ratio and last PR', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="card-label">Personal records<\/div>/);
  assert.match(html, /x-for="e in prs\.events"/);
  assert.match(html, /<small x-text="liftMeta\(lift\)"><\/small>/);
  const app = await source('../docs/js/app.js');
  assert.match(app, /stats\.relativeStrength\(history, this\.weightYear\)/);
  assert.match(app, /this\.prs\.lastByKey\.get\(lift\.id \?\? lift\.name\)/);
});

test('the PR scan is cached per training-data change, not redone every render', async () => {
  assert.match(await source('../docs/js/app.js'), /if \(this\._prs\?\.version !== version\)/);
});

test('the calorie card shows protein per pound of body weight', async () => {
  assert.match(await source('../docs/index.html'), /class="stat-sub protein-line" x-show="protein"/);
  assert.match(await source('../docs/js/app.js'), /stats\.proteinSummary\(this\.days, this\.weightSummary\?\.latest/);
});

test('sets per muscle replaced the volume radar entirely', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="card-label">Sets per muscle<\/div>/);
  assert.doesNotMatch(html, /Muscle balance|radarMarks|muscleBalance/);
  assert.doesNotMatch(await source('../docs/js/app.js'), /muscleVolume|radarPlot|radarMarks/);
  assert.doesNotMatch(await source('../docs/css/pages.css'), /\.radar-/);
  assert.equal(stats.muscleVolume, undefined);
  assert.equal(stats.radarPlot, undefined);
});

test('calorieDays carries protein, and whether every food that day had a value', async () => {
  const src = await source('../docs/js/stats.js');
  assert.match(src, /protein: Math\.round\(totals\.protein_g\)/);
  assert.match(src, /proteinKnown: entries\.every\(\(e\) => e\.protein_g != null && e\.protein_g !== ''\)/);
});
