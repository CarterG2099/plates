/**
 * reminders.js — each person's own reminders: when to log food, take meds,
 * weigh in or train, their own words at their own times, and the morning and
 * evening ones.
 *
 * Not local-first, for push.js's reason: a reminder the server cannot see is
 * one it cannot send. The notify-reminders function reads the same table every
 * minute. Nobody sees anyone else's: the policies allow only your own rows.
 *
 * One reminder can go off at several times, each on its own days. Each time is
 * its own row and the rows share a series_id: the sender needs no idea of a
 * series, and a med twice a day is two doses, each with its own Taken. Here the
 * rows are gathered back into one reminder for the list and the editor.
 */

import { db, supabase } from './supabase.js';
import { toDateOnly } from './food.js';

/** JS numbering, which the table and the function share: 0 = Sunday. */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** What a new food reminder stays quiet for, matching the function's default. */
export const DEFAULT_QUIET_MIN = 60;

const COLUMNS = 'id, kind, label, at_time, days, quiet_if_logged_min, enabled, persistent, series_id, sort_order';

/** How often a reminder set to keep reminding comes back, matching the function. */
export const PERSIST_EVERY_MIN = 15;

/** The kinds a member can add, for the New reminder list. The fixed two are not here. */
export const NEW_KINDS = [
  { kind: 'food',     title: 'Log food',          sub: 'At the times you eat; skips if you just logged', at: '12:30' },
  { kind: 'meds',     title: 'Med or supplement', sub: 'With a Taken button, at as many times as you need', at: '08:00' },
  { kind: 'weigh_in', title: 'Weigh-in',          sub: 'Skips the day once you have logged your weight', at: '07:00' },
  { kind: 'training', title: 'Training day',      sub: 'On the days you lift; skips once you start', at: '17:30' },
  { kind: 'custom',   title: 'Anything else',     sub: 'Your own words, at your own times', at: '09:00' },
];

/** The fixed two: one each, made by the server, moved or switched off but never deleted. */
export const isFixed = (r) => r.kind === 'morning' || r.kind === 'evening';

/** Anything but the fixed two can be checked off, so anything else can keep reminding until it is. */
export const canPersist = (r) => !isFixed(r);

/** What checking one off is called: Taken for a med, Done for the rest. */
export const checkOffWord = (r) => (r.kind === 'meds' ? 'Taken' : 'Done');

/** Whether a reminder's row shows the check-off chip: a med always, others when they keep reminding. */
export const checksOff = (r) => r.kind === 'meds' || (canPersist(r) && Boolean(r.persistent));

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

/** One row's name: its kind, or the name it was given. */
export function title(r) {
  if (r.kind === 'morning') return 'Morning motivation';
  if (r.kind === 'evening') return 'Evening check-in';
  if (r.kind === 'meds') return r.label?.trim() || 'Meds';
  if (r.kind === 'weigh_in') return 'Weigh-in';
  if (r.kind === 'training') return r.label?.trim() || 'Training day';
  if (r.kind === 'custom') return r.label?.trim() || 'Reminder';
  return r.label?.trim() || 'Log food';
}

/** The line under a single row's title: when, and the one thing that makes it go quiet. */
export function detail(r) {
  const parts = [timeLabel(r.at_time), daysLabel(r.days)];
  if (r.kind === 'food') {
    const quiet = r.quiet_if_logged_min ?? DEFAULT_QUIET_MIN;
    parts.push(quiet ? `quiet if you logged in the last ${quiet} min` : 'always');
  }
  if (r.kind === 'evening') parts.push('only when the day looks unfinished');
  if (r.persistent && canPersist(r)) parts.push(`every ${PERSIST_EVERY_MIN} min until ${checkOffWord(r)}`);
  return parts.join(' · ');
}

/** Earliest first, the way the day runs. */
export function sorted(list) {
  return [...list].sort((a, b) => String(a.at_time).localeCompare(String(b.at_time)));
}

// ---- series: one reminder, several times --------------------------------------

/**
 * The rows gathered into reminders, in the member's order — then, for any not
 * yet placed, by their first time of day.
 */
export function seriesOf(list) {
  const groups = new Map();
  for (const r of sorted(list ?? [])) {
    const key = r.series_id ?? r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const series = [...groups.entries()].map(([key, rows]) => {
    const first = rows[0];
    const sameDays = rows.every((r) => daysLabel(r.days) === daysLabel(first.days));
    const named = first.kind === 'food' && rows.length > 1;
    const sub = [];
    if (named) sub.push(rows.map((r) => r.label?.trim()).filter(Boolean).join(', ') || `${rows.length} times`);
    sub.push(sameDays ? daysLabel(first.days) : 'Different days per time');
    if (first.kind === 'evening') sub.push('only if the day looks unfinished');
    if (first.kind === 'weigh_in') sub.push('skips once you weigh in');
    if (first.kind === 'training') sub.push('skips once you start');
    if (first.persistent && canPersist(first)) sub.push(`every ${PERSIST_EVERY_MIN} min until ${checkOffWord(first)}`);
    return {
      key,
      kind: first.kind,
      rows,
      title: named ? 'Log food' : title(first),
      times: rows.map((r) => timeLabel(r.at_time)),
      sub: sub.join(' · '),
      enabled: rows.some((r) => r.enabled),
      order: rows.find((r) => r.sort_order != null)?.sort_order ?? null,
      first: String(first.at_time),
    };
  });
  return series.sort((a, b) => {
    if (a.order != null && b.order != null && a.order !== b.order) return a.order - b.order;
    if ((a.order == null) !== (b.order == null)) return a.order == null ? 1 : -1;
    return a.first.localeCompare(b.first);
  });
}

function blankTime(kind) {
  const at = NEW_KINDS.find((k) => k.kind === kind)?.at ?? '12:30';
  return { id: crypto.randomUUID(), at_time: at, days: [...EVERY_DAY], label: '', isNew: true };
}

/** A new reminder, unsaved, with its ids already made — ids are the client's. */
export function blank(kind) {
  const key = crypto.randomUUID();
  const time = blankTime(kind);
  time.id = key;   // the first row's id is the series id, as an older single row's is
  return {
    key,
    kind,
    label: '',
    quiet_if_logged_min: kind === 'food' ? DEFAULT_QUIET_MIN : null,
    enabled: true,
    persistent: false,
    sort_order: null,
    isNew: true,
    times: [time],
    removed: [],
  };
}

/** A time added to an open draft: the last time's days, an hour later. */
export function addTime(draft) {
  const last = draft.times.at(-1);
  const next = blankTime(draft.kind);
  if (last) {
    const [h, m] = String(last.at_time).split(':').map(Number);
    next.at_time = `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    next.days = [...last.days];
  }
  return { ...draft, times: [...draft.times, next] };
}

/** A time taken out of an open draft; a saved one is remembered so Save deletes its row. */
export function removeTime(draft, index) {
  const gone = draft.times[index];
  if (!gone || draft.times.length === 1) return draft;
  return {
    ...draft,
    times: draft.times.filter((_, i) => i !== index),
    removed: gone.isNew ? draft.removed : [...draft.removed, gone.id],
  };
}

/** An editable copy of a saved reminder, so Cancel leaves the list as it was. */
export function draftOf(series) {
  const first = series.rows[0];
  return {
    key: series.key,
    kind: first.kind,
    label: first.kind === 'food' ? '' : first.label ?? '',
    quiet_if_logged_min: first.quiet_if_logged_min,
    enabled: series.enabled,
    persistent: Boolean(first.persistent),
    sort_order: series.order,
    isNew: false,
    times: series.rows.map((r) => ({
      id: r.id,
      at_time: String(r.at_time).slice(0, 5),
      days: [...r.days],
      label: first.kind === 'food' ? r.label ?? '' : '',
      isNew: false,
    })),
    removed: [],
  };
}

/** What's wrong with a draft, in words for the sheet, or '' when it can be saved. */
export function problem(draft) {
  if (!draft.times?.length) return 'Add a time.';
  for (const t of draft.times) {
    if (!/^\d{1,2}:\d{2}/.test(String(t.at_time ?? ''))) return 'Pick a time.';
    if (!t.days?.length) return 'Pick at least one day for each time.';
    if (String(t.label ?? '').length > 60) return 'Keep each name under 60 characters.';
  }
  if (draft.kind === 'meds' && !draft.label?.trim()) return 'Name the med.';
  if (draft.kind === 'custom' && !draft.label?.trim()) return 'Say what it should remind you.';
  if (String(draft.label ?? '').length > 60) return 'Keep the name under 60 characters.';
  const quiet = draft.quiet_if_logged_min;
  if (draft.kind === 'food' && (quiet == null || quiet === '' || !(Number(quiet) >= 0 && Number(quiet) <= 720))) {
    return 'Quiet minutes must be 0 to 720.';
  }
  return '';
}

/** The rows a draft saves as: one per time, all sharing the series id. */
export function rowsOf(draft) {
  return draft.times.map((t) => ({
    id: t.id,
    isNew: Boolean(draft.isNew || t.isNew),
    kind: draft.kind,
    label: draft.kind === 'food' ? String(t.label ?? '').trim() : String(draft.label ?? '').trim(),
    at_time: t.at_time,
    days: [...new Set(t.days)].sort((a, b) => a - b),
    quiet_if_logged_min: draft.kind === 'food' ? Number(draft.quiet_if_logged_min) : null,
    enabled: Boolean(draft.enabled),
    persistent: canPersist(draft) && Boolean(draft.persistent),
    series_id: draft.key,
    sort_order: draft.sort_order ?? null,
  }));
}

/**
 * When the next reminder goes off, for the line at the top of the page:
 * { title, when } or null. Looks a week ahead, so a weekly one is found.
 */
export function nextUp(list, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (let ahead = 0; ahead < 8; ahead++) {
    const weekday = (now.getDay() + ahead) % 7;
    const due = sorted((list ?? []).filter((r) => r.enabled && !r.deleted_at && r.days?.includes(weekday)))
      .find((r) => {
        const [h, m] = String(r.at_time).split(':').map(Number);
        return ahead > 0 || h * 60 + m > nowMin;
      });
    if (!due) continue;
    const day = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : DAY_NAMES[weekday];
    return { title: title(due), when: `${timeLabel(due.at_time)} ${day}` };
  }
  return null;
}

/** Today's date as the sends table keys it. */
export const today = () => toDateOnly(new Date());

/**
 * This person's reminders, making the morning and evening ones on first open.
 * The two come from a server function because the insert policy keeps them to
 * one of each.
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

/** Insert one row, or update the editable columns of an existing one. Kind is never sent on an edit. */
export async function save(row) {
  const fields = {
    label: row.label?.trim() ?? '',
    at_time: row.at_time,
    days: [...new Set(row.days)].sort((a, b) => a - b),
    quiet_if_logged_min: row.kind === 'food' ? Number(row.quiet_if_logged_min) : null,
    enabled: Boolean(row.enabled),
    persistent: canPersist(row) && Boolean(row.persistent),
    series_id: row.series_id ?? null,
    sort_order: row.sort_order ?? null,
    updated_at: new Date().toISOString(),
  };

  const query = row.isNew
    ? db('reminders').insert({ id: row.id, kind: row.kind, ...fields })
    : db('reminders').update(fields).eq('id', row.id);
  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw error;
  return data;
}

/** Save a whole draft: each time's row, and the soft delete of any time taken out. */
export async function saveSeries(draft) {
  const saved = [];
  for (const row of rowsOf(draft)) saved.push(await save(row));
  for (const id of draft.removed ?? []) await remove(id);
  return saved;
}

/** Just the order column, for a drag in the list. */
export async function setOrder(id, sortOrder) {
  const { error } = await db('reminders')
    .update({ sort_order: sortOrder, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function remove(id) {
  const { error } = await db('reminders')
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Checks today's off (a dose taken, food logged), or un-marks a mis-tap. Returns the time, or null. */
export async function setTaken(id, taken) {
  const { data, error } = await supabase.schema('plates')
    .rpc('set_reminder_taken', { p_reminder: id, p_day: today(), p_taken: taken });
  if (error) throw error;
  return data;
}

/**
 * Send one of your own reminders now, to try it. The function checks it is
 * yours and records nothing for the day, so a test never stands in for the real one.
 */
export async function sendTest(id) {
  const { data, error } = await supabase.functions.invoke('notify-reminders', { body: { test: id } });
  if (error) throw error;
  return data;
}
