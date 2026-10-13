/**
 * The evening "finish logging today?" nudge.
 *
 * Imported straight from supabase/functions, so this is the source Deno runs.
 * Two halves: when the cron call counts as 8:30pm in Denver (schedule.ts), and
 * whether tonight's day deserves a nudge at all (nudge.ts). The second is the
 * product: the whole value of this notification is the nights it stays silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const s = await import('../supabase/functions/notify-evening/schedule.ts');
const { nudge, UNFINISHED_BELOW } = await import('../supabase/functions/notify-evening/nudge.ts');

const at = (iso) => s.localParts(new Date(iso), s.ZONE);

// Denver on MDT (UTC-6): 8:30pm local on Oct 4 is 02:30 UTC on Oct 5.
const EVENING = '2026-10-05T02:30:00Z';

// ---- the hour ---------------------------------------------------------------------

test('02:30 UTC in summer is 8:30pm the previous Denver day', () => {
  assert.deepEqual(at(EVENING), { date: '2026-10-04', hour: 20, weekday: 'Sunday' });
});

test('the on-hour call sends; the off-hour call of the DST pair does not', () => {
  assert.equal(s.skipReason(at(EVENING), undefined), null);
  assert.equal(s.skipReason(at('2026-10-05T03:30:00Z'), undefined), 'not the hour');
});

test('winter time flips which hour counts', () => {
  // MST (UTC-7): 8:30pm local is 03:30 UTC.
  const local = at('2026-12-07T03:30:00Z');
  assert.equal(local.hour, 20);
  assert.equal(s.skipReason(local, undefined), null);
  assert.equal(s.skipReason(at('2026-12-07T02:30:00Z'), undefined), 'not the hour');
});

test('a day already stamped does not send twice', () => {
  assert.equal(s.skipReason(at(EVENING), '2026-10-04'), 'already sent');
  assert.equal(s.skipReason(at(EVENING), '2026-10-03'), null);
});

test('Sunday dinner still counts — no quiet days on this one', () => {
  assert.equal(at(EVENING).weekday, 'Sunday');
  assert.equal(s.skipReason(at(EVENING), undefined), null);
});

// ---- the decision -----------------------------------------------------------------

const day = (over = {}) => ({ calories: 0, entryCount: 0, target: 2000, reviewed: false, ...over });

test('an empty day gets the nudge', () => {
  assert.match(nudge(day()), /Nothing logged today/);
});

test('a day clearly short of the target gets the nudge, with the number', () => {
  const msg = nudge(day({ calories: 900, entryCount: 3 }));
  assert.match(msg, /900 kcal/);
  assert.match(msg, /finish the day\?/);
});

test('a finished day stays silent', () => {
  assert.equal(nudge(day({ calories: 1950, entryCount: 9 })), null);
});

test('the threshold is a fraction of the target, not a fixed number', () => {
  const target = 3000;   // a bulk: 1500 logged is unfinished there
  assert.ok(nudge(day({ calories: 1500, entryCount: 4, target })));
  assert.equal(nudge(day({ calories: target * UNFINISHED_BELOW, entryCount: 4, target })), null);
});

test('a reviewed day is never nudged, even an empty one', () => {
  // Marking the day — complete or not — is an answer. Asking again is nagging.
  assert.equal(nudge(day({ reviewed: true })), null);
  assert.equal(nudge(day({ calories: 500, entryCount: 2, reviewed: true })), null);
});

test('with no target set, only an empty day can honestly be called unfinished', () => {
  assert.ok(nudge(day({ target: null })));
  assert.equal(nudge(day({ calories: 300, entryCount: 1, target: null })), null);
});

// ---- the function wires it together ----------------------------------------------

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

test('the function gates on skipReason, and ?force=1 still bypasses it', async () => {
  const src = await source('../supabase/functions/notify-evening/index.ts');
  assert.match(src, /const skipped = force \? null : skipReason\(local, config\.evening_sent_on\)/);
  assert.doesNotMatch(src, /function localParts/, 'localParts lives in schedule.ts, not a copy here');
});

test('planned entries do not count as eaten, and only opted-in accounts are checked', async () => {
  const src = await source('../supabase/functions/notify-evening/index.ts');
  assert.match(src, /!e\.is_planned/);
  assert.match(src, /\.eq\("evening_nudge", true\)/);
});

test('the webpush copy is byte-identical to the one the other functions run', async () => {
  // Edge Functions bundle independently, so each directory carries a copy; a
  // drifted copy is hand-rolled crypto nobody is testing.
  const original = await source('../supabase/functions/notify-idle-workouts/webpush.ts');
  assert.equal(await source('../supabase/functions/notify-evening/webpush.ts'), original);
  assert.equal(await source('../supabase/functions/notify-morning/webpush.ts'), original);
});

test('the settings sheet has the toggle and the store saves the pref', async () => {
  const html = await source('../docs/index.html');
  assert.match(html, /Evening check-in/);
  assert.match(html, /\$store\.ui\.toggleEvening\(\)/);

  const app = await source('../docs/js/app.js');
  assert.match(app, /savePrefs\(Alpine\.store\('auth'\)\.email, \{ evening_nudge: next \}\)/);

  const push = await source('../docs/js/push.js');
  assert.match(push, /evening_nudge: false/);
  assert.doesNotMatch(push.replaceAll("select('idle_workouts, morning_quotes, evening_nudge')", ''),
    /select\('idle_workouts, morning_quotes'\)/,
    'every prefs select must carry evening_nudge or the toggle reads stale state');
});
