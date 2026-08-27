import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
const hevy = await import('../docs/js/import-hevy.js');
const local = await import('../docs/js/local.js');

// ---- CSV parsing -----------------------------------------------------------
// Every fixture has at least two columns: the parser drops rows with one field,
// which is how it ignores trailing blank lines.

test('parseCsv reads a header row into keyed objects', () => {
  assert.deepEqual(hevy.parseCsv('a,b\n1,2\n3,4'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('parseCsv keeps commas that are inside quotes', () => {
  const rows = hevy.parseCsv('title,note\n"Bench Press, Barbell","heavy, but fine"');
  assert.equal(rows[0].title, 'Bench Press, Barbell');
  assert.equal(rows[0].note, 'heavy, but fine');
});

test('parseCsv unescapes doubled quotes', () => {
  const rows = hevy.parseCsv('id,note\n1,"He said ""go"""');
  assert.equal(rows[0].note, 'He said "go"');
});

test('parseCsv keeps newlines inside a quoted field', () => {
  const rows = hevy.parseCsv('id,note\n1,"line one\nline two"');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'line one\nline two');
});

test('parseCsv survives CRLF line endings', () => {
  assert.deepEqual(hevy.parseCsv('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);
});

test('parseCsv returns nothing for an empty or header-only file', () => {
  assert.deepEqual(hevy.parseCsv(''), []);
  assert.deepEqual(hevy.parseCsv('a,b'), []);
});

test('parseCsv fills a short row rather than misaligning columns', () => {
  const rows = hevy.parseCsv('a,b,c\n1,2');
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].b, '2');
  assert.equal(rows[0].c, '');
});

// ---- dates -----------------------------------------------------------------

test('parseHevyDate reads the export format', () => {
  const d = hevy.parseHevyDate('12 Jan 2026, 07:30');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 12);
  assert.equal(d.getHours(), 7);
});

test('parseHevyDate covers every month name', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((name, i) => {
    assert.equal(hevy.parseHevyDate(`1 ${name} 2026, 00:00`).getMonth(), i);
  });
});

test('parseHevyDate returns null for junk rather than an Invalid Date', () => {
  for (const bad of ['', null, undefined, 'not a date', '32 Xxx 2026, 07:30']) {
    const d = hevy.parseHevyDate(bad);
    assert.ok(d === null || Number.isFinite(d.getTime()), `"${bad}" should be null or a valid Date`);
  }
});

// ---- import ----------------------------------------------------------------

const CSV = [
  'title,start_time,end_time,exercise_title,set_index,weight_lbs,reps,set_type',
  '"Push","12 Jan 2026, 07:30","12 Jan 2026, 08:15","Bench Press (Barbell)",0,45,10,warmup',
  '"Push","12 Jan 2026, 07:30","12 Jan 2026, 08:15","Bench Press (Barbell)",1,185,5,normal',
  '"Push","12 Jan 2026, 07:30","12 Jan 2026, 08:15","Overhead Press",0,95,8,normal',
  '"Pull","14 Jan 2026, 07:30","14 Jan 2026, 08:20","Deadlift (Barbell)",0,315,3,normal',
].join('\n');

/**
 * Import and read back what landed.
 *
 * importHevy writes through local.save and returns counts, so the counts and
 * the stored rows are both worth asserting — a summary that says "4 sets" while
 * writing three is exactly the kind of thing this should catch.
 */
async function runImport(csv, existingExercises = []) {
  const summary = await hevy.importHevy(csv, { ownerEmail: 'me@example.com', existingExercises });
  return {
    summary,
    sessions: await local.all('sessions'),
    sets: await local.all('session_sets'),
    exercises: await local.all('exercises'),
  };
}

test('importHevy groups rows into sessions and sets', async () => {
  const { summary } = await runImport(CSV);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.sets, 4);
});

test('the summary matches what was actually written', async () => {
  const before = (await local.all('session_sets')).length;
  const { summary, sets } = await runImport(CSV);
  assert.equal(sets.length - before, summary.sets);
});

test('importHevy creates one exercise per distinct title', async () => {
  const { summary } = await runImport(CSV);
  assert.equal(summary.exercises, 3);
});

test('importHevy reuses an exercise that already exists instead of duplicating it', async () => {
  const existing = [{ id: 'existing-bench', name: 'Bench Press (Barbell)' }];
  const { summary, sets } = await runImport(CSV, existing);

  assert.equal(summary.exercises, 2, 'bench already existed, so only two are new');
  assert.ok(sets.some((s) => s.exercise_id === 'existing-bench'),
    'its sets should point at the existing exercise');
});

test('importHevy preserves the warm-up flag', async () => {
  const { sets } = await runImport(CSV);
  assert.ok(sets.some((s) => s.is_warmup && s.weight_lb === 45));
  assert.ok(sets.some((s) => !s.is_warmup && s.weight_lb === 185));
});

test('importHevy snapshots the exercise name onto every set', async () => {
  const { sets } = await runImport(CSV);
  assert.equal(sets.every((s) => typeof s.exercise_name === 'string' && s.exercise_name), true);
});

test('imported sets are marked completed, or they count toward nothing', async () => {
  const { sets } = await runImport(CSV);
  assert.equal(sets.every((s) => Boolean(s.completed_at)), true);
});

test('importHevy stamps ownership on sessions', async () => {
  const { sessions } = await runImport(CSV);
  assert.equal(sessions.every((s) => s.owner_email === 'me@example.com'), true);
});

test('exercise definitions are shared, not owned by the importer', async () => {
  const { exercises } = await runImport(CSV);
  assert.equal(exercises.every((e) => e.owner_email === null), true);
});

test('importHevy rejects a file with no usable rows', async () => {
  const opts = { ownerEmail: 'me@example.com', existingExercises: [] };
  await assert.rejects(() => hevy.importHevy('title,start_time\n', opts), /No workout rows/);
  await assert.rejects(() => hevy.importHevy('nonsense', opts), /No workout rows/);
});

test('importHevy skips rows missing an exercise or a start time', async () => {
  const partial = [
    'title,start_time,end_time,exercise_title,set_index,weight_lbs,reps,set_type',
    '"Push","12 Jan 2026, 07:30","12 Jan 2026, 08:15","Bench Press (Barbell)",0,185,5,normal',
    '"Push","12 Jan 2026, 07:30","12 Jan 2026, 08:15","",1,100,5,normal',
    '"Push","","",Squat,0,225,5,normal',
  ].join('\n');

  const { summary } = await runImport(partial);
  assert.equal(summary.sets, 1);
});

test('importHevy reports progress so a long import is not silent', async () => {
  const phases = [];
  await hevy.importHevy(CSV, { ownerEmail: 'me@example.com', existingExercises: [] }, (p) => phases.push(p.phase));
  assert.ok(phases.includes('parsing'));
  assert.ok(phases.includes('done'));
});

test('a repeated workout title becomes a routine, a one-off does not', async () => {
  const header = 'title,start_time,end_time,exercise_title,set_index,weight_lbs,reps,set_type';
  const rows = [header];
  // Five "Legs" sessions clears the routine threshold; one "Cardio" does not.
  for (let d = 1; d <= 5; d++) {
    rows.push(`"Legs","${d} Feb 2026, 07:30","${d} Feb 2026, 08:30","Squat (Barbell)",0,225,5,normal`);
  }
  rows.push('"Cardio","20 Feb 2026, 07:30","20 Feb 2026, 08:00","Treadmill",0,0,0,normal');

  const summary = await hevy.importHevy(rows.join('\n'), { ownerEmail: 'me@example.com', existingExercises: [] });
  assert.equal(summary.routines, 1);
});

/**
 * The library renames its exercises to put the weight form in brackets —
 * "Crunch (Cable)" where Hevy exports "Cable Crunch". The importer must still
 * recognise those as the same exercise.
 *
 * A regression test, not a hypothetical: the rename shipped while the matcher
 * only stripped bracketed equipment, so "cablecrunch" never matched "crunch".
 * A re-import matched none of the renamed rows and created seven duplicate
 * exercises, splitting real logged sets across both copies of each.
 */
test('a Hevy name still matches once the weight form moves into brackets', async () => {
  const pairs = [
    ['Cable Crunch', 'Crunch (Cable)'],
    ['Cable Pull Through', 'Pull Through (Cable)'],
    ['Low Cable Fly Crossovers', 'Low Fly Crossovers (Cable)'],
    ['Rowing Machine', 'Rowing (Machine)'],
    ['Seated Cable Row - Bar Wide Grip', 'Seated Row - Bar Wide Grip (Cable)'],
    ['Triceps Rope Pushdown', 'Triceps Pushdown (Rope)'],
    ['Barbell Bench Press', 'Bench Press (Barbell)'],
    ['Dumbbell Row', 'Row (Dumbbell)'],
  ];

  const header = 'title,start_time,end_time,exercise_title,set_index,weight_lbs,reps,set_type';

  for (const [hevyName, libraryName] of pairs) {
    const id = `id-${libraryName}`;
    const csv = [
      header,
      `"Session","12 Jan 2026, 07:30","12 Jan 2026, 08:15","${hevyName}",0,100,5,normal`,
    ].join('\n');

    const { summary, sets } = await runImport(csv, [{ id, name: libraryName }]);

    assert.equal(summary.exercises, 0,
      `"${hevyName}" should match "${libraryName}" rather than create a new exercise`);
    assert.ok(sets.some((s) => s.exercise_id === id),
      `the imported set should land on "${libraryName}"`);
  }
});
