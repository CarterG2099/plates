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

test('a new food reminder has one time, every day, quiet for an hour after logging', () => {
  const draft = r.blank('food');
  assert.equal(draft.isNew, true);
  assert.equal(draft.times.length, 1);
  assert.deepEqual(draft.times[0].days, r.EVERY_DAY);
  assert.equal(draft.times[0].id, draft.key, 'the first time is the series, as a single older row is');
  assert.equal(draft.quiet_if_logged_min, 60);
  assert.match(draft.key, /^[0-9a-f-]{36}$/);
  assert.equal(r.blank('meds').quiet_if_logged_min, null);
  assert.equal(r.blank('weigh_in').times[0].at_time, '07:00');
});

test('what a draft needs before it can be saved', () => {
  const food = () => r.blank('food');
  const withTime = (d, over) => ({ ...d, times: [{ ...d.times[0], ...over }] });
  assert.equal(r.problem(food()), '');
  assert.equal(r.problem(withTime(food(), { days: [] })), 'Pick at least one day for each time.');
  assert.equal(r.problem(withTime(food(), { at_time: '' })), 'Pick a time.');
  assert.equal(r.problem(withTime(food(), { label: 'x'.repeat(61) })), 'Keep each name under 60 characters.');
  assert.equal(r.problem({ ...food(), times: [] }), 'Add a time.');
  assert.equal(r.problem(r.blank('meds')), 'Name the med.');
  assert.equal(r.problem({ ...r.blank('meds'), label: 'Vitamin D' }), '');
  assert.equal(r.problem(r.blank('custom')), 'Say what it should remind you.');
  assert.equal(r.problem(r.blank('weigh_in')), '', 'a weigh-in needs no words');
  assert.equal(r.problem({ ...food(), quiet_if_logged_min: '' }), 'Quiet minutes must be 0 to 720.');
  assert.equal(r.problem({ ...food(), quiet_if_logged_min: 800 }), 'Quiet minutes must be 0 to 720.');
  assert.equal(r.problem({ ...food(), quiet_if_logged_min: 0 }), '');
});

test('a reminder at three times is three rows sharing one series, food times keeping their names', () => {
  let d = r.blank('food');
  d.times[0].label = 'Breakfast';
  d.times[0].at_time = '08:00';
  d = r.addTime(d);
  assert.equal(d.times[1].at_time, '09:00', 'an added time starts an hour after the last');
  d.times[1].label = 'Lunch';
  d = r.addTime(d);
  d.times[2].label = 'Dinner';
  const rows = r.rowsOf(d);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.series_id === d.key && x.kind === 'food' && x.isNew));
  assert.deepEqual(rows.map((x) => x.label), ['Breakfast', 'Lunch', 'Dinner']);

  const meds = { ...r.addTime({ ...r.blank('meds'), label: ' Creatine ' }) };
  assert.deepEqual(r.rowsOf(meds).map((x) => x.label), ['Creatine', 'Creatine'], 'a med\'s name is on every dose');
});

test('taking a saved time out remembers it for deleting; the last time cannot go', () => {
  const saved = { ...r.blank('meds'), isNew: false };
  saved.times = [{ id: 'a', at_time: '08:00', days: [1], isNew: false }, { id: 'b', at_time: '20:00', days: [1], isNew: false }];
  const one = r.removeTime(saved, 1);
  assert.deepEqual(one.times.map((t) => t.id), ['a']);
  assert.deepEqual(one.removed, ['b']);
  assert.equal(r.removeTime(one, 0), one, 'the only time stays');
  const fresh = r.addTime(saved);
  assert.deepEqual(r.removeTime(fresh, 2).removed, [], 'a time never saved has nothing to delete');
});

test('rows gather into reminders, in the member\'s order, then by time of day', () => {
  const rows = [
    { id: 'e', kind: 'evening', at_time: '20:30:00', days: r.EVERY_DAY, enabled: true },
    { id: 'c1', kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: r.EVERY_DAY, enabled: true, series_id: 'c', sort_order: 1 },
    { id: 'c', kind: 'meds', label: 'Creatine', at_time: '20:00:00', days: [1, 2, 3, 4, 5], enabled: false, series_id: 'c', sort_order: 1 },
    { id: 'm', kind: 'morning', at_time: '06:30:00', days: [1, 2, 3, 4, 5, 6], enabled: true, sort_order: 0 },
    { id: 'f1', kind: 'food', label: 'Breakfast', at_time: '08:00:00', days: r.EVERY_DAY, enabled: true, series_id: 'f' },
    { id: 'f2', kind: 'food', label: 'Lunch', at_time: '12:30:00', days: r.EVERY_DAY, enabled: true, series_id: 'f' },
  ];
  const s = r.seriesOf(rows);
  assert.deepEqual(s.map((x) => x.key), ['m', 'c', 'f', 'e'], 'placed ones first, then the rest by their first time');
  const creatine = s[1];
  assert.deepEqual(creatine.times, ['6:45am', '8:00pm']);
  assert.equal(creatine.title, 'Creatine');
  assert.equal(creatine.sub, 'Different days per time');
  assert.equal(creatine.enabled, true, 'on while any of its times is on');
  assert.equal(s[2].title, 'Log food');
  assert.equal(s[2].sub, 'Breakfast, Lunch · Every day · quiet if you logged in the last 60 min',
    'food still says what keeps it quiet, as the old detail line did');
  assert.match(r.seriesOf([{ ...rows[4], quiet_if_logged_min: 0 }])[0].sub, /· always$/);
  assert.equal(s[3].sub, 'Every day · only if the day looks unfinished');
});

test('a saved reminder opens as a draft of all its times, and saves back to the same rows', () => {
  const rows = [
    { id: 'c', kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: [0, 1], enabled: true, series_id: 'c', quiet_if_logged_min: null },
    { id: 'c2', kind: 'meds', label: 'Creatine', at_time: '20:00:00', days: [1], enabled: true, series_id: 'c', quiet_if_logged_min: null },
  ];
  const draft = r.draftOf(r.seriesOf(rows)[0]);
  assert.equal(draft.label, 'Creatine');
  assert.deepEqual(draft.times.map((t) => t.at_time), ['06:45', '20:00']);
  assert.deepEqual(r.rowsOf(draft).map((x) => [x.id, x.isNew, x.series_id]), [['c', false, 'c'], ['c2', false, 'c']]);
});

test('next up is the first time still to come, today or later in the week', () => {
  const wed = new Date(2026, 10, 25, 9, 0);   // a Wednesday, 9am
  const list = [
    { kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: r.EVERY_DAY, enabled: true },
    { kind: 'evening', at_time: '20:30:00', days: r.EVERY_DAY, enabled: true },
    { kind: 'weigh_in', at_time: '07:00:00', days: [1], enabled: true },
  ];
  assert.deepEqual(r.nextUp(list, wed), { title: 'Evening check-in', when: '8:30pm today' });
  assert.deepEqual(r.nextUp(list, new Date(2026, 10, 25, 21, 0)), { title: 'Creatine', when: '6:45am tomorrow' });
  assert.deepEqual(r.nextUp([list[2]], wed), { title: 'Weigh-in', when: '7:00am Mon' });
  assert.equal(r.nextUp([{ ...list[0], enabled: false }], wed), null);
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

test('a new reminder is inserted with its kind, one row per time; an edit never sends the kind', withServer(async (server, ui) => {
  ui.reminderList = [];
  ui.newReminder('meds');
  ui.reminderDraft.label = 'Vitamin D';
  ui.addReminderTime();
  await ui.saveReminder();
  const inserts = server.calls.filter((c) => c.op === 'insert');
  assert.equal(inserts.length, 2);
  assert.ok(inserts.every((c) => c.table === 'reminders' && c.row.kind === 'meds'));
  assert.equal(inserts[0].row.series_id, inserts[1].row.series_id);
  assert.equal(ui.reminderDraft, null, 'the sheet closes');
  assert.equal(ui.reminderSeries.length, 1);
  assert.equal(ui.reminderList.length, 2);

  ui.editReminder(r.seriesOf([LUNCH])[0]);
  ui.reminderDraft.times[0].at_time = '13:00';
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

test('days toggle on and off for one time of the open draft', withServer(async (_, ui) => {
  ui.newReminder('food');
  ui.addReminderTime();
  ui.toggleReminderDay(1, 0);
  assert.deepEqual(ui.reminderDraft.times[1].days, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ui.reminderDraft.times[0].days, r.EVERY_DAY, 'the other time is untouched');
  ui.toggleReminderDay(1, 0);
  assert.deepEqual(ui.reminderDraft.times[1].days, [1, 2, 3, 4, 5, 6, 0]);
}));

test('the fixed two cannot take a second time; everything else can', withServer(async (_, ui) => {
  ui.editReminder(r.seriesOf([{ id: 'm', kind: 'morning', at_time: '06:30:00', days: [1], enabled: true }])[0]);
  assert.equal(ui.reminderCanAddTime, false);
  ui.newReminder('custom');
  assert.equal(ui.reminderCanAddTime, true);
}));

test('a reminder\'s switch flips all its times at once and goes back if the save fails', withServer(async (server, ui) => {
  const second = { ...LUNCH, id: 'l2', at_time: '18:00:00', series_id: 'l' };
  ui.reminderList = [{ ...LUNCH, series_id: 'l' }, second];
  await ui.toggleReminder(ui.reminderSeries[0]);
  assert.deepEqual(ui.reminderList.map((x) => x.enabled), [false, false]);
  assert.equal(server.calls.filter((c) => c.op === 'update').length, 2);

  server.fail = true;
  await ui.toggleReminder(ui.reminderSeries[0]);
  assert.deepEqual(ui.reminderList.map((x) => x.enabled), [false, false], 'put back to off');
}));

test('delete is soft, and takes every time of the reminder', withServer(async (server, ui) => {
  ui.reminderList = [{ ...LUNCH, series_id: 'l' }, { ...LUNCH, id: 'l2', series_id: 'l' }, VITD];
  ui.editReminder(ui.reminderSeries.find((s) => s.key === 'l'));
  await ui.deleteReminder();
  const calls = server.calls.filter((c) => c.op === 'update');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.row.deleted_at));
  assert.deepEqual(ui.reminderList.map((x) => x.id), ['v']);
}));

test('dragging a reminder writes the new order on every row that moved, and puts it back on failure', withServer(async (server, ui) => {
  ui.reminderList = [VITD, LUNCH, { ...LUNCH, id: 'x', kind: 'custom', label: 'Stretch', at_time: '21:00:00' }];
  assert.deepEqual(ui.reminderSeries.map((s) => s.key), ['v', 'l', 'x']);
  await ui.moveReminder('x', 0);
  assert.deepEqual(ui.reminderSeries.map((s) => s.key), ['x', 'v', 'l']);
  assert.equal(server.calls.filter((c) => c.op === 'update').length, 3, 'all three were unplaced');
  await ui.moveReminder('x', 0);
  assert.equal(server.calls.filter((c) => c.op === 'update').length, 3, 'nothing moved, nothing sent');

  server.fail = true;
  await ui.moveReminder('l', 0);
  assert.deepEqual(ui.reminderSeries.map((s) => s.key), ['x', 'v', 'l'], 'put back');
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

// ---- keep reminding until checked off ---------------------------------------------

test('anything but the fixed two can keep reminding, and the detail line says so', () => {
  for (const kind of ['food', 'meds', 'weigh_in', 'training', 'custom']) assert.equal(r.canPersist({ kind }), true, kind);
  assert.equal(r.canPersist({ kind: 'morning' }), false);
  assert.equal(r.canPersist({ kind: 'evening' }), false);
  assert.equal(r.detail({ kind: 'meds', at_time: '08:00:00', days: r.EVERY_DAY, persistent: true }),
    '8:00am · Every day · every 15 min until Taken');
  assert.equal(r.detail({ kind: 'food', at_time: '12:30:00', days: [1], quiet_if_logged_min: 0, persistent: true }),
    '12:30pm · Mon · always · every 15 min until Done');
  assert.equal(r.blank('food').persistent, false);
});

test('the new kinds have their own names', () => {
  assert.equal(r.title({ kind: 'weigh_in' }), 'Weigh-in');
  assert.equal(r.title({ kind: 'training', label: '' }), 'Training day');
  assert.equal(r.title({ kind: 'training', label: 'Leg day' }), 'Leg day');
  assert.equal(r.title({ kind: 'custom', label: 'Stretch' }), 'Stretch');
  assert.deepEqual(r.NEW_KINDS.map((k) => k.kind), ['food', 'meds', 'weigh_in', 'training', 'custom']);
});

test('a med always has its Taken chip; food gets Done only when it keeps reminding', () => {
  assert.equal(r.checksOff({ kind: 'meds' }), true);
  assert.equal(r.checksOff({ kind: 'food', persistent: false }), false);
  assert.equal(r.checksOff({ kind: 'food', persistent: true }), true);
  assert.equal(r.checksOff({ kind: 'morning', persistent: true }), false);
  assert.equal(r.checkOffWord({ kind: 'food' }), 'Done');
});

test('keep reminding is saved for anything checkable, and never for the fixed two', withServer(async (server, ui) => {
  ui.reminderList = [];
  ui.editReminder(r.seriesOf([{ ...LUNCH, persistent: false }])[0]);
  ui.reminderDraft.persistent = true;
  await ui.saveReminder();
  assert.equal(server.calls.find((c) => c.op === 'update').row.persistent, true);

  await r.save({ id: 'm', kind: 'morning', at_time: '06:30', days: [1], enabled: true, persistent: true });
  assert.equal(server.calls.at(-1).row.persistent, false);
}));

test('Done on a food reminder checks it off and reads as Done', withServer(async (server, ui) => {
  const lunch = { ...LUNCH, persistent: true };
  ui.reminderToday = {};
  server.rpcResult = '2026-11-12T19:40:00.000Z';
  await ui.toggleTaken(lunch);
  assert.equal(server.calls.find((c) => c.rpc === 'set_reminder_taken').args.p_reminder, 'l');
  assert.match(ui.takenLabel(lunch), /^Done \d{1,2}:\d{2}(am|pm)$/);
}));

// ---- markup ---------------------------------------------------------------------------

const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');

test('Notifications lists each reminder with its times, a switch, and New reminder', () => {
  const settings = html.slice(html.indexOf('<template x-if="$store.ui.settingsOpen">'), html.indexOf('<!-- What a new reminder is for.'));
  assert.match(settings, /x-for="s in \$store\.ui\.reminderSeries"/);
  assert.match(settings, /x-for="r in s\.rows"/);
  assert.match(settings, /@click\.stop="\$store\.ui\.toggleTaken\(r\)"/, 'each time of a reminder can be checked off');
  assert.match(settings, /:disabled="\$store\.ui\.reminderOrdering \|\| s\.rows\.length < 2 \|\| !\$store\.ui\.checksOff\(r\) \|\| !r\.enabled"/);
  assert.match(settings, /@change="await \$store\.ui\.toggleReminder\(s\)/);
  assert.match(settings, /@click="\$store\.ui\.kindPicking = true"/);
  assert.match(settings, /\$store\.ui\.moveReminder\(key, to\)/);
  assert.match(settings, /\$store\.ui\.togglePref\('messages'\)/);
  assert.match(settings, /\$store\.ui\.togglePref\('idle_workouts'\)/);
  assert.match(settings, /x-text="\$store\.ui\.takenLabel\(s\.rows\[0\]\) \? 'Undo' : \$store\.ui\.checkOffWord\(s\.rows\[0\]\)"/);
  const picker = html.slice(html.indexOf('<!-- What a new reminder is for.'), html.indexOf('<!-- Profile: who is signed in'));
  assert.match(picker, /x-for="k in \$store\.ui\.newKinds"/);
  assert.match(picker, /@click="\$store\.ui\.newReminder\(k\.kind\)"/);
});

test('the old fixed morning and evening switches are gone, folded into the list', () => {
  assert.doesNotMatch(html, /toggleMorning|toggleEvening/);
});

test('the reminder sheet edits each time and its days, quiet minutes, and stacks above Notifications', () => {
  const settingsAt = html.indexOf('<template x-if="$store.ui.settingsOpen">');
  const sheetAt = html.indexOf('<template x-if="$store.ui.settingsOpen && $store.ui.reminderDraft">');
  assert.ok(sheetAt > settingsAt, 'later in the page, so drawn on top');
  const sheet = html.slice(sheetAt, html.indexOf('</template>\n', html.indexOf('Delete reminder', sheetAt)));
  assert.match(sheet, /x-for="\(t, i\) in \$store\.ui\.reminderDraft\.times"/);
  assert.match(sheet, /<input type="time" x-model="t\.at_time"/);
  assert.match(sheet, /@click="\$store\.ui\.toggleReminderDay\(i, day\)"/);
  assert.match(sheet, /@click="\$store\.ui\.addReminderTime\(\)"/);
  assert.match(sheet, /@click="\$store\.ui\.removeReminderTime\(i\)"/);
  assert.match(sheet, /x-model\.number="\$store\.ui\.reminderDraft\.quiet_if_logged_min"/);
  assert.match(sheet, /:disabled="\$store\.ui\.reminderBusy \|\| Boolean\(\$store\.ui\.reminderProblem\)"/);
  assert.match(sheet, /<label class="setting" x-show="\$store\.ui\.canPersist\(\$store\.ui\.reminderDraft\)">/);
  assert.match(sheet, /<input type="checkbox" role="switch" x-model="\$store\.ui\.reminderDraft\.persistent">/);
  assert.match(sheet, /\$store\.ui\.testReminder\(/);
});

test('the new module is precached', async () => {
  const sw = await readFile(fileURLToPath(new URL('../docs/sw.js', import.meta.url)), 'utf8');
  assert.match(sw, /'\/js\/reminders\.js',/);
});

test('the list is only ever your own, though the other person\'s are readable', withServer(async (server, ui) => {
  Alpine.store('auth').session = { user: { email: 'me@example.com' } };
  server.rows = [
    { ...VITD, owner_email: 'me@example.com' },
    { ...VITD, id: 'theirs', label: 'Birth Control', owner_email: 'them@example.com' },
    { ...LUNCH, owner_email: 'ME@example.com' },
  ];
  await ui.loadReminders();
  assert.deepEqual(ui.reminderList.map((x) => x.id), ['v', 'l'], 'case of the email does not matter');
  assert.equal(ui.reminderAll.length, 3, 'the other person\'s are kept for their day');
  assert.deepEqual(r.ownedBy(server.rows, 'them@example.com').map((x) => x.id), ['theirs']);
  Alpine.store('auth').session = null;
}));
