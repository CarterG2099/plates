/**
 * The Reminders section in Settings: what each row says, what a draft needs
 * before it can be saved, and what the store sends to the server.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadApp } from './helpers/app.mjs';

const { Alpine } = await loadApp();
const r = await import('../docs/js/reminders.js');
const { supabase } = await import('../docs/js/supabase.js');

// ---- words ------------------------------------------------------------------------

test('times read the way a clock does', () => {
  assert.equal(r.timeLabel('20:30:00'), '8:30pm');
  assert.equal(r.timeLabel('06:05'), '6:05am');
  assert.equal(r.timeLabel('00:00'), '12:00am');
  assert.equal(r.timeLabel('12:00'), '12:00pm');
  assert.equal(r.timeLabel(''), '');
});

test('days collapse to a name where there is one', () => {
  assert.equal(r.daysLabel([0, 1, 2, 3, 4, 5, 6]), 'Every day');
  assert.equal(r.daysLabel([5, 1, 2, 3, 4]), 'Weekdays');
  assert.equal(r.daysLabel([6, 0]), 'Weekends');
  assert.equal(r.daysLabel([1, 2, 3, 4, 5, 6]), 'Mon, Tue, Wed, Thu, Fri, Sat');
  assert.equal(r.daysLabel([]), 'No days');
});

test('each kind has a title, and food and meds use their own name', () => {
  assert.equal(r.title({ kind: 'morning' }), 'Morning motivation');
  assert.equal(r.title({ kind: 'evening' }), 'Evening check-in');
  assert.equal(r.title({ kind: 'food', label: 'Lunch' }), 'Lunch');
  assert.equal(r.title({ kind: 'food', label: '' }), 'Log food');
  assert.equal(r.title({ kind: 'meds', label: 'Vitamin D' }), 'Vitamin D');
});

test('the detail line says when, and what keeps it quiet', () => {
  assert.equal(r.detail({ kind: 'food', at_time: '12:30:00', days: r.EVERY_DAY, quiet_if_logged_min: 60 }),
    '12:30pm · Every day · quiet if you logged in the last 60 min');
  assert.equal(r.detail({ kind: 'food', at_time: '12:30:00', days: [1], quiet_if_logged_min: 0 }),
    '12:30pm · Mon · always');
  assert.equal(r.detail({ kind: 'evening', at_time: '20:30:00', days: r.EVERY_DAY }),
    '8:30pm · Every day · only when the day looks unfinished');
  assert.equal(r.detail({ kind: 'meds', at_time: '08:00:00', days: [1, 2, 3, 4, 5] }), '8:00am · Weekdays');
});

test('the list runs in the order of the day', () => {
  const list = [{ at_time: '20:30:00' }, { at_time: '06:30:00' }, { at_time: '12:30:00' }];
  assert.deepEqual(r.sorted(list).map((x) => x.at_time), ['06:30:00', '12:30:00', '20:30:00']);
});

// ---- drafts -------------------------------------------------------------------------

test('a new food reminder starts every day, quiet for an hour after logging', () => {
  const draft = r.blank('food');
  assert.equal(draft.isNew, true);
  assert.deepEqual(draft.days, r.EVERY_DAY);
  assert.equal(draft.quiet_if_logged_min, 60);
  assert.match(draft.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.blank('meds').quiet_if_logged_min, null);
});

test('what a draft needs before it can be saved', () => {
  assert.equal(r.problem(r.blank('food')), '');
  assert.equal(r.problem({ ...r.blank('food'), days: [] }), 'Pick at least one day.');
  assert.equal(r.problem({ ...r.blank('food'), at_time: '' }), 'Pick a time.');
  assert.equal(r.problem(r.blank('meds')), 'Name the med.');
  assert.equal(r.problem({ ...r.blank('meds'), label: 'Vitamin D' }), '');
  assert.equal(r.problem({ ...r.blank('food'), quiet_if_logged_min: '' }), 'Quiet minutes must be 0 to 720.');
  assert.equal(r.problem({ ...r.blank('food'), quiet_if_logged_min: 800 }), 'Quiet minutes must be 0 to 720.');
  assert.equal(r.problem({ ...r.blank('food'), quiet_if_logged_min: 0 }), '');
});

// ---- the store against a stand-in server ----------------------------------------------

/** Records every call; `fail` makes the next write come back as an error. */
function fakeServer() {
  const calls = [];
  const server = { calls, fail: false, rows: [], rpcResult: null };
  const builder = (table) => {
    const call = { table, op: 'select', filters: [] };
    calls.push(call);
    const q = {
      select() { return q; },
      insert(row) { call.op = 'insert'; call.row = row; return q; },
      update(row) { call.op = 'update'; call.row = row; return q; },
      eq(col, val) { call.filters.push([col, val]); return q; },
      is(col, val) { call.filters.push([col, val]); return q; },
      single() { return q; },
      then(resolve) {
        if (server.fail && call.op !== 'select') return resolve({ data: null, error: { message: 'offline' } });
        if (call.op === 'select') return resolve({ data: server.rows, error: null });
        return resolve({ data: { ...call.row, id: call.row.id ?? call.filters.find(([c]) => c === 'id')?.[1] }, error: null });
      },
    };
    return q;
  };
  server.schema = () => ({
    from: builder,
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return { data: server.rpcResult, error: null }; },
  });
  return server;
}

function withServer(fn) {
  return async () => {
    const server = fakeServer();
    const original = supabase.schema;
    supabase.schema = server.schema;
    try { await fn(server, Alpine.store('ui')); } finally { supabase.schema = original; }
  };
}

const LUNCH = { id: 'l', kind: 'food', label: 'Lunch', at_time: '12:30:00', days: [0, 1, 2, 3, 4, 5, 6],
  quiet_if_logged_min: 60, enabled: true };
const VITD = { id: 'v', kind: 'meds', label: 'Vitamin D', at_time: '08:00:00', days: [0, 1, 2, 3, 4, 5, 6],
  quiet_if_logged_min: null, enabled: true };

test('opening the list makes the morning and evening ones first, then reads them in day order', withServer(async (server, ui) => {
  server.rows = [LUNCH, VITD];
  await ui.loadReminders();
  assert.equal(server.calls[0].rpc, 'ensure_default_reminders');
  assert.deepEqual(ui.reminderList.map((x) => x.id), ['v', 'l']);
}));

test('a new reminder is inserted with its kind; an edit never sends the kind', withServer(async (server, ui) => {
  ui.reminderList = [];
  ui.newReminder('meds');
  ui.reminderDraft.label = 'Vitamin D';
  await ui.saveReminder();
  const insert = server.calls.find((c) => c.op === 'insert');
  assert.equal(insert.table, 'reminders');
  assert.equal(insert.row.kind, 'meds');
  assert.equal(ui.reminderDraft, null, 'the sheet closes');
  assert.equal(ui.reminderList.length, 1);

  ui.editReminder(LUNCH);
  ui.reminderDraft.at_time = '13:00';
  await ui.saveReminder();
  const update = server.calls.find((c) => c.op === 'update');
  assert.equal(update.row.kind, undefined);
  assert.equal(update.row.at_time, '13:00');
  assert.deepEqual(update.filters, [['id', 'l']]);
}));

test('a draft with a problem is not sent at all', withServer(async (server, ui) => {
  ui.newReminder('meds');   // no name yet
  await ui.saveReminder();
  assert.equal(server.calls.length, 0);
  assert.equal(ui.reminderProblem, 'Name the med.');
}));

test('days toggle on and off in the open draft', withServer(async (_, ui) => {
  ui.newReminder('food');
  ui.toggleReminderDay(0);
  assert.deepEqual(ui.reminderDraft.days, [1, 2, 3, 4, 5, 6]);
  ui.toggleReminderDay(0);
  assert.deepEqual(ui.reminderDraft.days, [1, 2, 3, 4, 5, 6, 0]);
}));

test('the row switch flips at once and goes back if the save fails', withServer(async (server, ui) => {
  ui.reminderList = [LUNCH];
  await ui.toggleReminder(LUNCH);
  assert.equal(ui.reminderList[0].enabled, false);

  server.fail = true;
  await ui.toggleReminder(ui.reminderList[0]);
  assert.equal(ui.reminderList[0].enabled, false, 'put back to off');
}));

test('delete is soft', withServer(async (server, ui) => {
  ui.reminderList = [LUNCH];
  ui.editReminder(LUNCH);
  await ui.deleteReminder();
  const call = server.calls.find((c) => c.op === 'update');
  assert.ok(call.row.deleted_at);
  assert.deepEqual(ui.reminderList, []);
}));

test('Taken in the list marks today\'s dose, and shows when', withServer(async (server, ui) => {
  ui.reminderToday = {};
  server.rpcResult = '2026-10-31T14:02:00.000Z';
  await ui.toggleTaken(VITD);
  const call = server.calls.find((c) => c.rpc === 'set_reminder_taken');
  assert.equal(call.args.p_reminder, 'v');
  assert.equal(call.args.p_taken, true);
  assert.match(ui.takenLabel(VITD), /^Taken \d{1,2}:\d{2}(am|pm)$/);

  server.rpcResult = null;
  await ui.toggleTaken(VITD);
  assert.equal(server.calls.at(-1).args.p_taken, false, 'a second tap un-marks a mis-tap');
  assert.equal(ui.takenLabel(VITD), '');
}));

// ---- markup ---------------------------------------------------------------------------

const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');

test('Settings lists the reminders with a switch each, and buttons to add food and med ones', () => {
  const settings = html.slice(html.indexOf('<div class="card-label" style="margin-top: var(--space-4)">Reminders</div>'),
    html.indexOf('<div class="card-label" style="margin-top: var(--space-4)">Watch</div>'));
  assert.match(settings, /x-for="r in \$store\.ui\.reminderList"/);
  assert.match(settings, /@change="await \$store\.ui\.toggleReminder\(r\)/);
  assert.match(settings, /@click="\$store\.ui\.newReminder\('food'\)"/);
  assert.match(settings, /@click="\$store\.ui\.newReminder\('meds'\)"/);
  assert.match(settings, /x-show="r\.kind === 'meds' && r\.enabled"/);
});

test('the old fixed morning and evening switches are gone, folded into the list', () => {
  assert.doesNotMatch(html, /toggleMorning|toggleEvening/);
});

test('the reminder sheet edits time, days and quiet minutes, and stacks above Settings', () => {
  const settingsAt = html.indexOf('<template x-if="$store.ui.settingsOpen">');
  const sheetAt = html.indexOf('<template x-if="$store.ui.settingsOpen && $store.ui.reminderDraft">');
  assert.ok(sheetAt > settingsAt, 'later in the page, so drawn on top');
  const sheet = html.slice(sheetAt, html.indexOf('</template>\n', html.indexOf('Delete reminder', sheetAt)));
  assert.match(sheet, /<input type="time" x-model="\$store\.ui\.reminderDraft\.at_time">/);
  assert.match(sheet, /x-model\.number="\$store\.ui\.reminderDraft\.quiet_if_logged_min"/);
  assert.match(sheet, /@click="\$store\.ui\.toggleReminderDay\(day\)"/);
  assert.match(sheet, /:disabled="\$store\.ui\.reminderBusy \|\| Boolean\(\$store\.ui\.reminderProblem\)"/);
});

test('the new module is precached', async () => {
  const sw = await readFile(fileURLToPath(new URL('../docs/sw.js', import.meta.url)), 'utf8');
  assert.match(sw, /'\/js\/reminders\.js',/);
});
