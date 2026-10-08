/**
 * When the morning message goes out.
 *
 * Imported straight from supabase/functions, so this is the source Deno runs.
 * The cron fires at both 12:30 and 13:30 UTC to ride out daylight saving; the
 * function decides which of the two is really 6am in Denver, and stays quiet on
 * Sundays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const s = await import('../supabase/functions/notify-morning/schedule.ts');

const at = (iso) => s.localParts(new Date(iso), s.ZONE);

// 2026-10-04 is a Sunday, 2026-10-05 a Monday; Denver is on MDT (UTC-6).
const SUNDAY_6AM = '2026-10-04T12:30:00Z';
const MONDAY_6AM = '2026-10-05T12:30:00Z';

test('localParts gives the Denver date, hour and weekday', () => {
  assert.deepEqual(at(MONDAY_6AM), { date: '2026-10-05', hour: 6, weekday: 'Monday' });
  // 01:00 UTC Monday is still Sunday evening in Denver.
  assert.deepEqual(at('2026-10-05T01:00:00Z'), { date: '2026-10-04', hour: 19, weekday: 'Sunday' });
});

test('Monday at 6am local sends', () => {
  assert.equal(s.skipReason(at(MONDAY_6AM), undefined), null);
});

test('Sunday at 6am local does not send', () => {
  assert.equal(s.skipReason(at(SUNDAY_6AM), undefined), 'quiet day');
});

test('every other day of the week still sends', () => {
  for (let d = 5; d <= 10; d++) {
    const local = at(`2026-10-${String(d).padStart(2, '0')}T12:30:00Z`);
    assert.notEqual(local.weekday, 'Sunday');
    assert.equal(s.skipReason(local, undefined), null, local.weekday);
  }
});

test('Sunday in winter time is quiet too', () => {
  // MST (UTC-7): 6:30 local is 13:30 UTC, the other cron hour.
  const local = at('2026-12-06T13:30:00Z');
  assert.equal(local.weekday, 'Sunday');
  assert.equal(local.hour, 6);
  assert.equal(s.skipReason(local, undefined), 'quiet day');
});

test('the off-hour call of the DST pair is still "not the hour", Sunday or not', () => {
  assert.equal(s.skipReason(at('2026-10-04T13:30:00Z'), undefined), 'not the hour');
  assert.equal(s.skipReason(at('2026-10-05T13:30:00Z'), undefined), 'not the hour');
});

test('a day already stamped as sent does not send twice', () => {
  assert.equal(s.skipReason(at(MONDAY_6AM), '2026-10-05'), 'already sent');
  assert.equal(s.skipReason(at(MONDAY_6AM), '2026-10-04'), null);
});

test('the function gates on skipReason, and ?force=1 still bypasses it', async () => {
  const src = await readFile(
    fileURLToPath(new URL('../supabase/functions/notify-morning/index.ts', import.meta.url)), 'utf8');
  assert.match(src, /const skipped = force \? null : skipReason\(local, config\.morning_sent_on\)/);
  assert.doesNotMatch(src, /function localParts/, 'localParts lives in schedule.ts, not a copy here');
});
