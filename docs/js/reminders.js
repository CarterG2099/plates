/**
 * reminders.js — each person's own reminders: when to log food, when to take
 * meds, and the morning and evening ones.
 *
 * Not local-first, for push.js's reason: a reminder the server cannot see is
 * one it cannot send. The notify-reminders function reads the same table every
 * minute. Nobody sees anyone else's: the policies allow only your own rows.
 */

import { db, supabase } from './supabase.js';
import { toDateOnly } from './food.js';

/** JS numbering, which the table and the function share: 0 = Sunday. */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** What a new food reminder stays quiet for, matching the function's default. */
export const DEFAULT_QUIET_MIN = 60;

const COLUMNS = 'id, kind, label, at_time, days, quiet_if_logged_min, enabled';

/** "20:30:00" → "8:30pm". */
export function timeLabel(time) {
  const [h, m] = String(time ?? '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function daysLabel(days) {
  const set = [...new Set(days ?? [])].sort((a, b) => a - b);
  const key = set.join();
  if (key === EVERY_DAY.join()) return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  if (!set.length) return 'No days';
  return set.map((d) => DAY_NAMES[d]).join(', ');
}

export function title(r) {
  if (r.kind === 'morning') return 'Morning motivation';
  if (r.kind === 'evening') return 'Evening check-in';
  if (r.kind === 'meds') return r.label?.trim() || 'Meds';
  return r.label?.trim() || 'Log food';
}

/** The line under the title: when, and the one thing that makes it go quiet. */
export function detail(r) {
  const parts = [timeLabel(r.at_time), daysLabel(r.days)];
  if (r.kind === 'food') {
    const quiet = r.quiet_if_logged_min ?? DEFAULT_QUIET_MIN;
    parts.push(quiet ? `quiet if you logged in the last ${quiet} min` : 'always');
  }
  if (r.kind === 'evening') parts.push('only when the day looks unfinished');
  return parts.join(' · ');
}

/** Earliest first, the way the day runs. */
export function sorted(list) {
  return [...list].sort((a, b) => String(a.at_time).localeCompare(String(b.at_time)));
}

/** A new reminder, unsaved, with its id already made — ids are the client's. */
export function blank(kind) {
  return {
    id: crypto.randomUUID(),
    kind,
    label: '',
    at_time: kind === 'meds' ? '08:00' : '12:30',
    days: [...EVERY_DAY],
    quiet_if_logged_min: kind === 'food' ? DEFAULT_QUIET_MIN : null,
    enabled: true,
    isNew: true,
  };
}

/** What's wrong with a draft, in words for the sheet, or '' when it can be saved. */
export function problem(draft) {
  if (!/^\d{1,2}:\d{2}/.test(String(draft.at_time ?? ''))) return 'Pick a time.';
  if (!draft.days?.length) return 'Pick at least one day.';
  if (draft.kind === 'meds' && !draft.label?.trim()) return 'Name the med.';
  if (String(draft.label ?? '').length > 60) return 'Keep the name under 60 characters.';
  const quiet = draft.quiet_if_logged_min;
  if (draft.kind === 'food' && (quiet == null || quiet === '' || !(Number(quiet) >= 0 && Number(quiet) <= 720))) {
    return 'Quiet minutes must be 0 to 720.';
  }
  return '';
}

/** Today's date as the sends table keys it. */
export const today = () => toDateOnly(new Date());

/**
 * This person's reminders, making the morning and evening ones on first open.
 * The two come from a server function because the insert policy only allows
 * food and meds: there is one of each fixed kind, never a second.
 */
export async function load() {
  const { error: ensureError } = await supabase.schema('plates').rpc('ensure_default_reminders');
  if (ensureError) throw ensureError;

  const { data, error } = await db('reminders')
    .select(COLUMNS)
    .is('deleted_at', null);
  if (error) throw error;
  return sorted(data ?? []);
}

/** What was sent today, and which meds are taken, by reminder id. */
export async function loadToday() {
  const { data, error } = await db('reminder_sends')
    .select('reminder_id, sends, taken_at')
    .eq('local_date', today());
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((s) => [s.reminder_id, s]));
}

/** Insert a new one, or update the editable columns of an existing one. */
export async function save(draft) {
  const fields = {
    label: draft.label?.trim() ?? '',
    at_time: draft.at_time,
    days: [...new Set(draft.days)].sort((a, b) => a - b),
    quiet_if_logged_min: draft.kind === 'food' ? Number(draft.quiet_if_logged_min) : null,
    enabled: Boolean(draft.enabled),
    updated_at: new Date().toISOString(),
  };

  const query = draft.isNew
    ? db('reminders').insert({ id: draft.id, kind: draft.kind, ...fields })
    : db('reminders').update(fields).eq('id', draft.id);
  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw error;
  return data;
}

export async function remove(id) {
  const { error } = await db('reminders')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Marks today's dose taken, or un-marks a mis-tap. Returns the time, or null. */
export async function setTaken(id, taken) {
  const { data, error } = await supabase.schema('plates')
    .rpc('set_reminder_taken', { p_reminder: id, p_day: today(), p_taken: taken });
  if (error) throw error;
  return data;
}
