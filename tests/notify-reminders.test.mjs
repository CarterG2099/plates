/**
 * The reminders function: when each reminder is due, and what it says.
 *
 * Imported straight from supabase/functions, so this is the source Deno runs.
 * The cron calls every minute; due.ts decides from the reminder's own time and
 * days in Denver, which is what lets one job replace the DST pairs the morning
 * and evening jobs needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const d = await import('../supabase/functions/notify-reminders/due.ts');
const { nudge, UNFINISHED_BELOW } = await import('../supabase/functions/notify-reminders/nudge.ts');
const { compose, streaks } = await import('../supabase/functions/notify-reminders/morning.ts');

const at = (iso) => d.localParts(new Date(iso), d.ZONE);

const reminder = (over = {}) => ({
  kind: 'food', at_time: '12:30:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true, deleted_at: null, ...over,
});

// Denver on MDT (UTC-6) until Nov 1 2026, MST (UTC-7) after.
// Thursday Oct 29 2026, 12:30 local = 18:30 UTC.
const LUNCH = '2026-10-29T18:30:00Z';

// ---- local time ---------------------------------------------------------------

test('localParts gives the Denver date, minutes into the day and weekday', () => {
  assert.deepEqual(at(LUNCH), { date: '2026-10-29', hour: 12, minutes: 750, weekday: 4 });
});

test('weekdays count from Sunday as 0, the way the app saves them', () => {
  assert.equal(at('2026-11-01T18:00:00Z').weekday, 0, 'Sunday');
  assert.equal(at('2026-11-02T18:00:00Z').weekday, 1, 'Monday');
  assert.equal(at('2026-10-31T18:00:00Z').weekday, 6, 'Saturday');
});

test('a late-evening UTC time is still the previous Denver day', () => {
  // 02:30 UTC Oct 30 = 8:30pm Oct 29 local.
  assert.deepEqual(at('2026-10-30T02:30:00Z'), { date: '2026-10-29', hour: 20, minutes: 1230, weekday: 4 });
});

test('the same reminder fires at its local time either side of the DST change', () => {
  const morning = reminder({ kind: 'morning', at_time: '06:30:00' });
  const summer = new Date('2026-10-29T12:30:00Z');   // MDT: 6:30am
  const winter = new Date('2026-11-05T13:30:00Z');   // MST: 6:30am
  assert.equal(d.whatIsDue(morning, null, d.localParts(summer, d.ZONE), summer), 'first');
  assert.equal(d.whatIsDue(morning, null, d.localParts(winter, d.ZONE), winter), 'first');
  // And the hour that used to be the other half of the pair does nothing.
  const offHour = new Date('2026-11-05T12:30:00Z');
  assert.equal(d.whatIsDue(morning, null, d.localParts(offHour, d.ZONE), offHour), null);
});

// ---- the first send -----------------------------------------------------------

const due = (r, send, iso) => d.whatIsDue(r, send, at(iso), new Date(iso));
const minutesAfter = (iso, n) => new Date(Date.parse(iso) + n * 60_000).toISOString();

test('a reminder is due at its minute, and for a while after if a call was missed', () => {
  assert.equal(due(reminder(), null, LUNCH), 'first');
  assert.equal(due(reminder(), null, minutesAfter(LUNCH, d.CATCH_UP_MIN - 1)), 'first');
});

test('not before its time, and not hours late', () => {
  assert.equal(due(reminder(), null, minutesAfter(LUNCH, -1)), null);
  assert.equal(due(reminder(), null, minutesAfter(LUNCH, d.CATCH_UP_MIN)), null);
});

test('only on its days', () => {
  assert.equal(due(reminder({ days: [1, 2, 3, 5] }), null, LUNCH), null, 'Thursday is 4');
  assert.equal(due(reminder({ days: [4] }), null, LUNCH), 'first');
});

test('switched off or deleted is never due', () => {
  assert.equal(due(reminder({ enabled: false }), null, LUNCH), null);
  assert.equal(due(reminder({ deleted_at: '2026-10-28T00:00:00Z' }), null, LUNCH), null);
});

test('once sent, or decided quiet, a reminder is done for the day', () => {
  const sent = { sends: 1, last_sent_at: LUNCH, skipped: false, taken_at: null };
  assert.equal(due(reminder(), sent, minutesAfter(LUNCH, 1)), null);
  assert.equal(due(reminder(), sent, minutesAfter(LUNCH, 90)), null, 'food never nags');
  const quiet = { sends: 0, last_sent_at: null, skipped: true, taken_at: null };
  assert.equal(due(reminder(), quiet, minutesAfter(LUNCH, 1)), null);
});

// ---- meds ------------------------------------------------------------------------

const meds = reminder({ kind: 'meds', at_time: '08:00:00' });
const EIGHT = '2026-10-29T14:00:00Z';
const sentAt = (sends, iso) => ({ sends, last_sent_at: iso, skipped: false, taken_at: null });

test('a med not taken is asked about again after 30 minutes, not sooner', () => {
  assert.equal(due(meds, sentAt(1, EIGHT), minutesAfter(EIGHT, d.NAG_EVERY_MIN - 1)), null);
  assert.equal(due(meds, sentAt(1, EIGHT), minutesAfter(EIGHT, d.NAG_EVERY_MIN)), 'nag');
});

test('it gives up after three more asks', () => {
  const last = minutesAfter(EIGHT, 90);
  assert.equal(due(meds, sentAt(d.MAX_NAGS, last), minutesAfter(last, 30)), 'nag');
  assert.equal(due(meds, sentAt(d.MAX_NAGS + 1, last), minutesAfter(last, 30)), null);
});

test('taken stops it, including a dose marked before the reminder went off', () => {
  const taken = { sends: 1, last_sent_at: EIGHT, skipped: false, taken_at: minutesAfter(EIGHT, 5) };
  assert.equal(due(meds, taken, minutesAfter(EIGHT, 60)), null);
  const early = { sends: 0, last_sent_at: null, skipped: false, taken_at: '2026-10-29T13:40:00Z' };
  assert.equal(due(meds, early, EIGHT), null);
});

test('a dose marked and then un-marked before its time still gets its reminder', () => {
  const unmarked = { sends: 0, last_sent_at: null, skipped: false, taken_at: null };
  assert.equal(due(meds, unmarked, EIGHT), 'first');
});

// ---- food: quiet when just logged -----------------------------------------------

const NOW = new Date(LUNCH);
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();

test('a food reminder keeps quiet when something was logged in the last hour', () => {
  assert.equal(d.quietForFood(null, ago(59), NOW), true);
  assert.equal(d.quietForFood(null, ago(61), NOW), false);
  assert.equal(d.DEFAULT_QUIET_MIN, 60);
});

test('the window is the reminder\'s own, and 0 means always remind', () => {
  assert.equal(d.quietForFood(90, ago(80), NOW), true);
  assert.equal(d.quietForFood(15, ago(20), NOW), false);
  assert.equal(d.quietForFood(0, ago(1), NOW), false);
});

test('nothing logged, or only something planned for later, does not keep it quiet', () => {
  assert.equal(d.quietForFood(60, null, NOW), false);
  assert.equal(d.quietForFood(60, new Date(NOW.getTime() + 10 * 60_000).toISOString(), NOW), false);
});

test('the words', () => {
  assert.equal(d.foodMessage('Lunch'), 'Lunch: time to log what you ate.');
  assert.equal(d.foodMessage('  '), 'Time to log what you ate.');
  assert.equal(d.medsMessage('Vitamin D', false), 'Time to take Vitamin D.');
  assert.equal(d.medsMessage('Vitamin D', true), 'Still need to take Vitamin D? Tap Taken once you have.');
  assert.equal(d.medsMessage('', false), 'Time to take your meds.');
});

// ---- evening: moved from notify-evening, unchanged --------------------------------

test('an empty day gets the evening nudge', () => {
  assert.match(nudge({ calories: 0, entryCount: 0, target: 2000, reviewed: false }), /Nothing logged/);
});

test('a day clearly short of the target gets it, with the number', () => {
  assert.equal(nudge({ calories: 900, entryCount: 2, target: 2000, reviewed: false }),
    'Only 900 kcal logged today — finish the day?');
});

test('a finished day, or a reviewed one, stays silent', () => {
  assert.equal(nudge({ calories: 2000 * UNFINISHED_BELOW, entryCount: 3, target: 2000, reviewed: false }), null);
  assert.equal(nudge({ calories: 0, entryCount: 0, target: 2000, reviewed: true }), null);
});

test('with no target, only an empty day is unfinished', () => {
  assert.equal(nudge({ calories: 300, entryCount: 1, target: null, reviewed: false }), null);
});

// ---- morning: moved from notify-morning ------------------------------------------

test('the morning line for someone who has never trained', () => {
  const s = streaks([], '2026-10-29', d.ZONE);
  assert.match(compose(s, { name: null, weight: null, reps: null, when: null }, () => 0), /today is a good day to start/);
});

// Any member gets these, not only Carter and Aana, so no line may name either.
test('no morning line names a member', () => {
  const s = { dayStreak: 3, weekStreak: 3, daysSince: 4, everTrained: true };
  const last = { name: 'Squat', weight: 225, reps: 5, when: 'Monday' };
  for (const roll of [0.1, 0.5, 0.9]) {
    for (let i = 0; i < 100; i++) {
      const values = [roll, i / 100];
      const line = compose(s, last, () => values.shift());
      assert.doesNotMatch(line, /Aana|Carter/, line);
    }
  }
});

test('morning streaks still count yesterday on the morning after', () => {
  const s = streaks(['2026-10-28T23:00:00Z', '2026-10-27T23:00:00Z'], '2026-10-29', d.ZONE);
  assert.equal(s.dayStreak, 2);
});

// ---- the function wires it together ----------------------------------------------

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('every reminder goes through whatIsDue, and ?force=<id> sends that one only', async () => {
  const src = await source('../supabase/functions/notify-reminders/index.ts');
  assert.match(src, /force === r\.id \? \(send\?\.sends \? "nag" : "first"\) : force \? null : whatIsDue\(r, send, local, now\)/);
  assert.doesNotMatch(src, /function localParts/, 'localParts lives in due.ts, not a copy here');
});

test('a send is claimed before it is made, so overlapping calls cannot both send', async () => {
  const src = await source('../supabase/functions/notify-reminders/index.ts');
  assert.match(src, /ignoreDuplicates: true/);
  assert.match(src, /\.eq\("sends", send\.sends\)/);
  assert.match(src, /if \(!claimed\?\.length \|\| !body\) continue;/);
});

test('only eaten food keeps a food reminder quiet, and only that member\'s', async () => {
  const src = await source('../supabase/functions/notify-reminders/index.ts');
  const fn = src.slice(src.indexOf('async function lastEatenAt'), src.indexOf('async function sha256'));
  assert.match(fn, /\.eq\("is_planned", false\)/);
  assert.match(fn, /\.eq\("owner_email", owner\)/);
  assert.match(fn, /\.is\("deleted_at", null\)/);
});

test('a meds push carries a Taken button and the token for it, and keeps only the hash', async () => {
  const src = await source('../supabase/functions/notify-reminders/index.ts');
  assert.match(src, /actions: \[\{ action: "taken", title: "Taken" \}\], taken: \{ url: takenUrl, token \}/);
  assert.match(src, /token_hash: token \? await sha256\(token\) : null/);
});

test('reminder-taken marks only the dose whose token it was given, once', async () => {
  const src = await source('../supabase/functions/reminder-taken/index.ts');
  assert.match(src, /\.eq\("token_hash", await sha256\(token\)\)/);
  assert.match(src, /\.is\("taken_at", null\)/);
  assert.match(src, /if \(token\.length < 32\)/);
});

test('the webpush copy is byte-identical to the one the other functions run', async () => {
  // Edge Functions bundle independently, so each directory carries a copy; a
  // drifted copy is hand-rolled crypto nobody is testing.
  const original = await source('../supabase/functions/notify-idle-workouts/webpush.ts');
  assert.equal(await source('../supabase/functions/notify-reminders/webpush.ts'), original);
});

test('the service worker answers Taken without opening the app, and opens it if that fails', async () => {
  const sw = await source('../docs/sw.js');
  assert.match(sw, /event\.action === 'taken' && taken\?\.url && taken\?\.token/);
  assert.match(sw, /body: JSON\.stringify\(\{ token: taken\.token \}\)/);
  assert.match(sw, /\.catch\(\(\) => self\.clients\.openWindow\('\/#today'\)\)/);
  assert.match(sw, /data: \{ url: data\.url \|\| '\/#train', taken: data\.taken \?\? null \}/);
});
