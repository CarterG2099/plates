/**
 * How a lift compares with other lifters: which lifts are rated, where a ratio
 * lands, DOTS, and the card that puts them together.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const standards = await import('../docs/js/standards.js');
const stats = await import('../docs/js/stats.js');
const workout = await import('../docs/js/workout.js');

const ME = 'me@example.com';
const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

// ---- which lifts ------------------------------------------------------------

test('free-weight lifts are rated under the names they are logged as', () => {
  const rated = {
    'Squat (Barbell)': 'squat', Squat: 'squat', 'Back Squat': 'squat',
    'Bench Press (Barbell)': 'bench', 'Bench Press': 'bench',
    Deadlift: 'deadlift', 'Deadlift (Barbell)': 'deadlift',
    'Overhead Press': 'press', 'Military Press': 'press',
    'Bent Over Row (Barbell)': 'row', 'Barbell Row': 'row',
  };
  for (const [name, key] of Object.entries(rated)) assert.equal(standards.liftKey(name), key, name);
});

test('machines, variations and other implements are not rated', () => {
  for (const name of ['Hack Squat (Machine)', 'Front Squat', 'Romanian Deadlift', 'Sumo Deadlift',
    'Bench Press (Dumbbell)', 'Incline Bench Press (Barbell)', 'Seated Overhead Press (Barbell)',
    'Shoulder Press (Machine Plates)', 'Row (Dumbbell)', 'Leg Press']) {
    assert.equal(standards.liftKey(name), null, name);
  }
});

// ---- where a ratio lands ----------------------------------------------------

test('a ratio exactly at a level reaches it, at that level\'s percentile', () => {
  assert.deepEqual(standards.rate('squat', 'male', 1.5),
    { level: 'Intermediate', percentile: 50, next: { level: 'Advanced', ratio: 2.25 } });
  assert.equal(standards.rate('bench', 'male', 1.0).percentile, 50);
});

test('between levels the percentile reads along the line', () => {
  // Halfway from intermediate (1.5, 50%) to advanced (2.25, 80%).
  assert.equal(standards.rate('squat', 'male', 1.875).percentile, 65);
});

test('below beginner and beyond elite stay inside 1-99', () => {
  const low = standards.rate('deadlift', 'male', 0.2);
  assert.equal(low.level, 'Below beginner');
  assert.ok(low.percentile >= 1 && low.percentile < 5);
  const high = standards.rate('deadlift', 'male', 5);
  assert.equal(high.level, 'Elite');
  assert.equal(high.percentile, 99);
  assert.equal(high.next, null);
});

test('the same ratio ranks higher against women\'s standards', () => {
  const m = standards.rate('bench', 'male', 0.9).percentile;
  const f = standards.rate('bench', 'female', 0.9).percentile;
  assert.ok(f > m, `${f} vs ${m}`);
});

test('no sex, no lift, or no ratio is no rating', () => {
  assert.equal(standards.rate('squat', null, 1.5), null);
  assert.equal(standards.rate('curl', 'male', 1.5), null);
  assert.equal(standards.rate('squat', 'male', 0), null);
});

test('every standard climbs from beginner to elite', () => {
  for (const [lift, s] of Object.entries(standards.STANDARDS)) {
    for (const sex of ['male', 'female']) {
      const t = s[sex];
      assert.equal(t.length, 5, `${lift} ${sex}`);
      for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], `${lift} ${sex} step ${i}`);
    }
  }
});

// ---- DOTS -------------------------------------------------------------------

test('DOTS matches the published formula', () => {
  const lb = (kg) => kg / 0.45359237;
  // A 100 kg man with a 700 kg total scores ~431 (the figure meet results show).
  assert.equal(standards.dots(lb(700), lb(100), 'male'), 431);
  // A 60 kg woman with 400 kg: worked by hand from the women's coefficients,
  // denominator 451.04, so 400 x 500 / 451.04 = 443.
  assert.equal(standards.dots(lb(400), lb(60), 'female'), 443);
});

test('DOTS needs a total, a body weight and a sex', () => {
  assert.equal(standards.dots(0, 180, 'male'), null);
  assert.equal(standards.dots(1000, 0, 'male'), null);
  assert.equal(standards.dots(1000, 180, null), null);
});

// ---- the card -----------------------------------------------------------------

const day = (n) => new Date(Date.parse('2026-10-01T12:00:00Z') - n * 86_400_000).toISOString();

function indexOf(lifts) {
  const sets = [];
  const sessions = [];
  lifts.forEach(([name, when, weight, reps], i) => {
    const id = `s${i}`;
    sessions.push({ id, owner_email: ME, started_at: when, ended_at: when });
    sets.push({ id: `${id}-0`, owner_email: ME, session_id: id, exercise_id: name, exercise_name: name,
      set_index: 0, weight_lb: weight, reps, completed_at: when, is_warmup: false });
  });
  return workout.buildIndex(sets, sessions, ME);
}

const NOW = Date.parse('2026-10-01T12:00:00Z');
const bw = [{ at: day(1), lb: 180 }, { at: day(40), lb: 182 }].reverse();

test('each rated lift is ranked from its latest session at the nearest weigh-in', () => {
  const index = indexOf([
    ['Squat (Barbell)', day(2), 270, 5],                 // e1RM 315 -> 1.75x
    ['Bench Press (Barbell)', day(3), 185, 5],
    ['Leg Press', day(2), 500, 10],                      // machine: never listed
  ]);
  const { rows } = stats.standings(index, bw, 'male', { now: NOW });
  assert.deepEqual(rows.map((r) => r.lift), ['squat', 'bench']);
  const squat = rows[0];
  assert.equal(squat.oneRm, 315);
  assert.equal(squat.ratio, 1.75);
  assert.equal(squat.rating.level, 'Intermediate');
  assert.equal(squat.nextLb, 405, 'advanced at 2.25 x 180, to the nearest 5');
});

test('a lift logged under two names is rated from the more recent', () => {
  const index = indexOf([
    ['Squat', day(300), 315, 5],
    ['Squat (Barbell)', day(2), 225, 5],
  ]);
  const { rows } = stats.standings(index, bw, 'male', { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Squat (Barbell)');
});

test('without a weigh-in near the latest session the lift is listed, not rated', () => {
  const index = indexOf([['Deadlift', day(100), 405, 3]]);
  const { rows } = stats.standings(index, bw, 'male', { now: NOW });
  assert.equal(rows[0].ratio, null);
  assert.equal(rows[0].rating, null);
});

test('without a sex nothing is rated, but the lifts are still found', () => {
  const index = indexOf([['Squat (Barbell)', day(2), 270, 5]]);
  const { rows, dots } = stats.standings(index, bw, null, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rating, null);
  assert.equal(dots, null);
});

test('DOTS appears only when squat, bench and deadlift are all recent', () => {
  const recent = indexOf([
    ['Squat (Barbell)', day(2), 270, 5], ['Bench Press (Barbell)', day(3), 185, 5], ['Deadlift', day(4), 315, 5],
  ]);
  const d = stats.standings(recent, bw, 'male', { now: NOW }).dots;
  assert.equal(d.total, 315 + 216 + 368);
  assert.equal(d.bodyWeight, 180);
  assert.ok(d.score > 250 && d.score < 400, `score ${d.score}`);

  const stale = indexOf([
    ['Squat (Barbell)', day(2), 270, 5], ['Bench Press (Barbell)', day(3), 185, 5], ['Deadlift', day(400), 315, 5],
  ]);
  assert.equal(stats.standings(stale, bw, 'male', { now: NOW }).dots, null);
});

test('the card asks for the standards before rating, and saves the answer on the member row', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /<div class="card-label">How you compare<\/div>/);
  assert.match(html, /<template x-if="!mySex">[\s\S]*?setSex\('male'\)[\s\S]*?setSex\('female'\)/);
  const app = await source('../docs/js/app.js');
  assert.match(app, /\.from\('members'\)\s*\.update\(\{ sex \}\)\.eq\('email', this\.email\)/);
  const sb = await source('../docs/js/supabase.js');
  assert.match(sb, /db\('members'\)\.select\('[^']*\bsex\b[^']*'\)/, 'membership must load sex or the choice is asked again every session');
  const sql = await source('../supabase/schema.sql');
  assert.match(sql, /add column if not exists sex text check \(sex in \('male', 'female'\)\)/);
});

test('standards.js is precached', async () => {
  assert.match(await source('../docs/sw.js'), /'\/js\/standards\.js',/);
});
