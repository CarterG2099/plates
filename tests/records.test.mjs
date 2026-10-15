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

// "Today" for the stall checks: just after these sessions, so they are all
// inside the six-month window that records and suggestions are measured over.
const SOON = Date.parse('2026-03-01T12:00:00Z');
const stallOf = (history, opts = {}) => stats.stallFor(history, { now: SOON, ...opts });

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
  const stall = stallOf(history);
  assert.equal(stall.since, 3);
  assert.deepEqual(stall.top, { weight: 245, reps: 8 });
  assert.deepEqual(stall.next, { weight: 245, reps: 9 });
});

test('two sessions without a record is not yet a stall', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[245, 8]]], [d(14), [[245, 8]]], [d(21), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.equal(stallOf(history), null);
});

test('the suggestion is a real record: one more rep than ever at that weight or heavier', () => {
  // 245 x 10 back in the baseline, 245 x 8 lately: 245 x 9 would not be a PR.
  const history = workout.historyOf(indexOf([
    [d(0), [[245, 10]]], [d(7), [[245, 8]]], [d(14), [[245, 8]]], [d(21), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(history).next, { weight: 245, reps: 11 });
});

test('heavier sets count against a weight too: 275 x 10 means 245 needs 11', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[275, 10]]], [d(7), [[245, 8]]], [d(14), [[245, 8]]], [d(21), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(history).next, { weight: 245, reps: 11 });
});

test('past 12 reps the step is five pounds more, at whatever beats that weight', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[100, 12], [105, 9]]], [d(7), [[100, 12]]], [d(14), [[100, 12]]], [d(21), [[100, 12]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(history).next, { weight: 105, reps: 10 });
});

test('up to 12 reps the step stays at the same weight', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[100, 11]]], [d(7), [[100, 11]]], [d(14), [[100, 11]]], [d(21), [[100, 11]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(history).next, { weight: 100, reps: 12 });
});

test('heavy lifts stop at 8 reps and climb in weight until a record fits', () => {
  // 225 x 8 every time: 225 x 9 would be over the ceiling, and 230 has never
  // been lifted — any rep there is a record, so it asks for the floor, 5.
  const plain = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[225, 8]]], [d(14), [[225, 8]]], [d(21), [[225, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(plain, { ceiling: 8, floor: 5 }).next, { weight: 230, reps: 5 });

  // With 235 x 6 and 240 x 3 in the past, the first weight with a record at
  // 8 reps or fewer is 230 (beat 235 x 6 with 7), already above the floor.
  const deeper = workout.historyOf(indexOf([
    [d(0), [[225, 8], [235, 6], [240, 3]]], [d(7), [[225, 8]]], [d(14), [[225, 8]]], [d(21), [[225, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stallOf(deeper, { ceiling: 8, floor: 5 }).next, { weight: 230, reps: 7 });
});

test('a heavier suggestion never asks for a single, nor for more than the ceiling', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[225, 8]]], [d(14), [[225, 8]]], [d(21), [[225, 8]]],
  ]), 'squat', 'squat', Infinity);
  const { next } = stallOf(history, { ceiling: 8, floor: 5 });
  assert.ok(next.reps >= 5 && next.reps <= 8, `${next.reps}`);
  // A floor above the ceiling is clamped to it rather than looping forever.
  assert.deepEqual(stallOf(history, { ceiling: 8, floor: 10 }).next, { weight: 230, reps: 8 });
});

test('heavy lifts floor at 5 reps, everything else at 8', () => {
  assert.equal(stats.repFloor('Squat (Barbell)'), 5);
  assert.equal(stats.repFloor('Romanian Deadlift'), 5);
  assert.equal(stats.repFloor('Lat Pulldown'), 8);
});

test('squats, deadlifts and the barbell presses are heavy; everything else gets 12', () => {
  for (const name of ['Squat (Barbell)', 'Hack Squat (Machine)', 'Front Squat', 'Deadlift', 'Romanian Deadlift',
    'Sumo Deadlift', 'Bench Press (Barbell)', 'Overhead Press', 'Military Press']) {
    assert.equal(stats.repCeiling(name), 8, name);
  }
  for (const name of ['Bench Press (Dumbbell)', 'Lat Pulldown', 'Leg Extension', 'Hip Thrust', 'Bent Over Row (Barbell)']) {
    assert.equal(stats.repCeiling(name), 12, name);
  }
});

test('the stall map uses each lift\'s own ceiling', async () => {
  assert.match(await source('../docs/js/stats.js'), /stallFor\(history, \{ ceiling: repCeiling\(name\), floor: repFloor\(name\), now \}\)/);
});

// ---- the six-month window -------------------------------------------------------

const iso = (s) => `${s}T12:00:00Z`;
const OCT = Date.parse(iso('2026-10-14'));

test('a set from more than six months ago no longer sets the bar', () => {
  // 275 x 10 last winter; 245 x 8 all autumn. Against all time 245 needed 11;
  // against six months it needs 9.
  const history = workout.historyOf(indexOf([
    [iso('2026-01-10'), [[275, 10]]],
    [iso('2026-09-01'), [[245, 8]]], [iso('2026-09-15'), [[245, 8]]],
    [iso('2026-09-29'), [[245, 8]]], [iso('2026-10-06'), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.deepEqual(stats.stallFor(history, { now: OCT }).next, { weight: 245, reps: 9 });
});

test('beating the last six months is a record even below an older best', () => {
  const index = indexOf([
    [iso('2026-01-10'), [[275, 10]]],
    [iso('2026-09-01'), [[245, 8]]],
    [iso('2026-09-15'), [[245, 9]]],               // a record now, not against January
  ]);
  const { events } = stats.prTimeline(index);
  assert.deepEqual(events.map((e) => e.at.slice(0, 10)), ['2026-09-15']);
});

test('the first session back after a long break is a baseline, not a record or a stall', () => {
  const walk = stats.recordWalk(workout.historyOf(indexOf([
    [iso('2026-01-10'), [[225, 5]]],
    [iso('2026-09-01'), [[185, 5]]],               // 8 months later: nothing in the window
  ]), 'squat', 'squat', Infinity));
  assert.equal(walk[1].baseline, true);
  assert.deepEqual(walk[1].kinds, []);
});

test('the stall count restarts at a baseline, as it would at a record', () => {
  const history = workout.historyOf(indexOf([
    [iso('2026-01-10'), [[225, 5]]], [iso('2026-01-17'), [[225, 5]]],
    [iso('2026-01-24'), [[225, 5]]], [iso('2026-01-31'), [[225, 5]]],
    [iso('2026-09-01'), [[185, 5]]],               // back after a break
    [iso('2026-09-08'), [[185, 5]]], [iso('2026-09-15'), [[185, 5]]],
  ]), 'squat', 'squat', Infinity);
  assert.equal(stats.stallFor(history, { now: OCT }), null, 'two since the baseline is not yet three');
});

test('a lift not done in six months gets no nudge: today would be a baseline', () => {
  const history = workout.historyOf(indexOf([
    [iso('2026-01-03'), [[225, 5]]], [iso('2026-01-10'), [[225, 5]]],
    [iso('2026-01-17'), [[225, 5]]], [iso('2026-01-24'), [[225, 5]]],
  ]), 'squat', 'squat', Infinity);
  assert.notEqual(stats.stallFor(history, { now: Date.parse(iso('2026-02-01')) }), null);
  assert.equal(stats.stallFor(history, { now: OCT }), null);
});

// ---- breaking a stall, live ---------------------------------------------------

const frontier = [{ weight: 275, reps: 10 }, { weight: 245, reps: 10 }, { weight: 225, reps: 12 }];
const doneSet = (weight_lb, reps, extra = {}) => ({ weight_lb, reps, completed_at: d(30), is_warmup: false, ...extra });

test('a set beats the frontier with more reps than ever at its weight or heavier', () => {
  assert.equal(stats.beatsFrontier(doneSet(245, 11), frontier), true);
  assert.equal(stats.beatsFrontier(doneSet(245, 10), frontier), false, 'equal is not more');
  assert.equal(stats.beatsFrontier(doneSet(225, 11), frontier), false, '225 x 12 already done');
  assert.equal(stats.beatsFrontier(doneSet(260, 10), frontier), false, '275 x 10 already beats it');
  assert.equal(stats.beatsFrontier(doneSet(260, 11), frontier), true);
});

test('heavier than ever is a record at any reps', () => {
  assert.equal(stats.beatsFrontier(doneSet(285, 1), frontier), true);
});

test('unfinished sets, warm-ups and cardio never break a stall', () => {
  assert.equal(stats.beatsFrontier(doneSet(245, 12, { completed_at: null }), frontier), false);
  assert.equal(stats.beatsFrontier(doneSet(245, 12, { is_warmup: true }), frontier), false);
  assert.equal(stats.beatsFrontier(doneSet(null, null, { distance_m: 5000 }), frontier), false);
});

test('meeting the suggestion always breaks the stall it came from', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[275, 10]]], [d(7), [[245, 8]]], [d(14), [[245, 8]]], [d(21), [[245, 8]]],
  ]), 'squat', 'squat', Infinity);
  const stall = stallOf(history);
  const { weight, reps } = stall.next;
  assert.equal(stats.beatsFrontier(doneSet(weight, reps), stall.frontier), true);
  assert.equal(stats.beatsFrontier(doneSet(weight, reps - 1), stall.frontier), false);
});

test('a bodyweight stall asks for another rep up to the ceiling', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[null, 10]]], [d(7), [[null, 10]]], [d(14), [[null, 10]]], [d(21), [[null, 10]]],
  ]), 'squat', 'squat', Infinity);
  const stall = stallOf(history);
  assert.deepEqual(stall.next, { weight: 0, reps: 11 });
  assert.equal(stall.addedWeight, true);
});

test('past 12 a bodyweight lift adds weight instead: +5 lb at the floor', () => {
  // 12 pull-ups done; 13 is over the ceiling, so the step is a weighted set,
  // which is a record at any reps — asked at the floor, 8.
  const history = workout.historyOf(indexOf([
    [d(0), [[null, 12]]], [d(7), [[null, 12]]], [d(14), [[null, 12]]], [d(21), [[null, 12]]],
  ]), 'squat', 'squat', Infinity);
  const stall = stallOf(history);
  assert.deepEqual(stall.next, { weight: 5, reps: 8 });
  assert.equal(stall.addedWeight, true);
  // And that weighted set breaks the stall.
  assert.equal(stats.beatsFrontier(doneSet(5, 8), stall.frontier), true);
});

test('a loaded lift is not marked as added weight', () => {
  const history = workout.historyOf(indexOf([
    [d(0), [[225, 8]]], [d(7), [[225, 8]]], [d(14), [[225, 8]]], [d(21), [[225, 8]]],
  ]), 'squat', 'squat', Infinity);
  assert.equal(stallOf(history).addedWeight, false);
});

test('the nudge says +5 lb for weight on top of body weight', async () => {
  const app = await source('../docs/js/app.js');
  assert.match(app, /return addedWeight \? `\+\$\{w\} lb × \$\{reps\}` : `\$\{w\} × \$\{reps\}`;/);
  assert.match(app, /if \(!w\) return stats\.count\(Number\(reps\), 'rep'\);/);
});

test('the stall map leaves out the session you are in the middle of', () => {
  const sessions = [
    [d(0), [[225, 8]]], [d(7), [[245, 8]]],
    [d(14), [[245, 8]]], [d(21), [[245, 8]]], [d(28), [[245, 8]]],
    [d(35), [[245, 8]]],                          // today, unfinished
  ];
  const index = indexOf(sessions, { open: 's5' });
  assert.equal(stats.stallMap(index, 's5', { now: SOON }).get('squat').since, 3);
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
  assert.match(app, /return `No PR in \$\{stats\.count\(stall\.since, 'session'\)\} · try \$\{this\.setText\(weight, reps, stall\.addedWeight\)\}`/);
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="stall" x-show="stallLine\(group\)" x-cloak\s*x-text="stallLine\(group\)"><\/div>/);
});

test('a ticked set that beats the stall swaps the nudge for the celebration, live', async () => {
  const app = await source('../docs/js/app.js');
  // The nudge steps aside as soon as a live row beats the frontier...
  assert.match(app, /if \(!stall \|\| this\.stallBreaker\(group\)\) return null;/);
  // ...read off the rows as they are now, not as they were stored.
  assert.match(app, /const set = this\.currentSet\(s\);\s*if \(!stats\.beatsFrontier\(set, stall\.frontier\)\) continue;/);
  assert.match(app, /return `Stall broken · \$\{what\} · best in 6 months`;/);
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="stall-broken" x-show="brokenLine\(group\)" x-cloak\s*x-text="brokenLine\(group\)"><\/div>/);
});

test('breaking the stall is announced once, ahead of a plain PR', async () => {
  const app = await source('../docs/js/app.js');
  const fn = app.slice(app.indexOf('  announceRecord(set) {'), app.indexOf('  async dropSet(set)'));
  assert.ok(fn.indexOf('Stall broken') < fn.indexOf('`PR · ${group.name}`'), 'stall message is checked first');
  assert.match(fn, /const earlier = group\.sets\.some\(\(s\) => s\.id !== set\.id/);
});

test('the celebration respects reduced motion', async () => {
  const css = await source('../docs/css/pages.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.stall-broken \{ animation: none; \}/);
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
