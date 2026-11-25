/**
 * Each other's day: switching to the other person shows their Today, Train and
 * Stats, read-only; nudges and cheers go to their phone through send-nudge.
 *
 * The two of you see everything of each other's. What must never happen is a
 * write landing as them, or their rows mixing into your own lists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp } from './helpers/app.mjs';

const { Alpine, components } = await loadApp();
const local = await import('../docs/js/local.js');
const food = await import('../docs/js/food.js');
const rules = await import('../supabase/functions/send-nudge/rules.ts');
const { supabase } = await import('../docs/js/supabase.js');

const ME = 'me@example.com';
const HER = 'her@example.com';
const ui = () => Alpine.store('ui');

function signIn({ partner = true } = {}) {
  const auth = Alpine.store('auth');
  auth.session = { user: { email: ME } };
  auth.members = [
    { email: ME, display_name: 'Carter', sharing: true },
    ...(partner ? [{ email: HER, display_name: 'Aana', sharing: true }] : []),
  ];
  ui().viewAs = '';
}

const noon = (d = new Date()) => new Date(`${food.toDateOnly(d)}T12:00:00`).toISOString();

let seeded = false;
async function seed() {
  if (seeded) return;
  seeded = true;
  await local.save('goals', { starts_on: '2020-01-01', calorie_target: 2100, protein_target_g: 180, carbs_target_g: 210, fat_target_g: 60 }, ME);
  await local.save('goals', { starts_on: '2020-01-01', calorie_target: 1800 }, HER);
  await local.save('food_log', { logged_at: noon(), description: 'Mine', quantity: 1, unit: 'serving', calories: 1449, protein_g: 129, carbs_g: 138, fat_g: 45 }, ME);
  await local.save('food_log', { logged_at: noon(), description: 'Hers', quantity: 1, unit: 'serving', calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 }, HER);
  await local.save('sessions', { name: 'Chest/Shoulders 1.0', started_at: noon(), ended_at: new Date(Date.parse(noon()) + 108 * 60_000).toISOString() }, HER);
  await Alpine.store('data').refreshCore();
  await Alpine.store('data').refreshTraining();
}

// ---- who is on screen ------------------------------------------------------------

test('with someone to switch to, the avatar opens the switcher; without, the profile as before', () => {
  signIn({ partner: false });
  ui().openWho();
  assert.equal(ui().whoOpen, false);
  assert.equal(ui().profileOpen, true);
  ui().profileOpen = false;

  signIn();
  ui().loadReminders = async () => {};   // the switcher refreshes meds; no server here
  ui().openWho();
  assert.equal(ui().whoOpen, true);
  ui().whoOpen = false;
});

test('switching to the other person changes whose day every screen reads, and back', () => {
  signIn();
  assert.equal(ui().viewEmail, ME);
  assert.equal(ui().viewInitial, 'C');
  ui().viewPerson(HER);
  assert.equal(ui().viewEmail, HER);
  assert.equal(ui().viewName, 'Aana');
  assert.equal(ui().viewInitial, 'A');
  ui().viewPerson(ME.toUpperCase());
  assert.equal(ui().viewAs, '', 'picking yourself is not viewing');
  ui().viewPerson(HER);
  ui().backToMe();
  assert.equal(ui().viewAs, '');
});

test('Today shows her food, goal and workout while viewing her, and yours otherwise', async () => {
  signIn();
  await seed();
  ui().viewDate = food.toDateOnly(new Date());
  const today = Alpine.reactive(components.todayPage());
  assert.equal(today.ringRows[0].value, '1,449');
  assert.equal(today.trained, null);

  ui().viewPerson(HER);
  assert.equal(today.ringRows[0].value, '600');
  assert.equal(today.ringRows[0].of, '/ 1,800 · 33%');
  assert.equal(today.ringRows[1].of, 'no target', 'her macro targets are not set');
  assert.deepEqual(today.trained, { name: 'Chest/Shoulders 1.0', line: '108 min' });
  ui().backToMe();
});

test('her meds show on her day, by name, and never in your own list', async () => {
  signIn();
  const weekday = new Date().getDay();
  ui().reminderList = [{ id: 'c', owner_email: ME, kind: 'meds', label: 'Creatine', at_time: '06:45:00', days: [weekday], enabled: true }];
  ui().reminderAll = [...ui().reminderList,
    { id: 'b', owner_email: HER, kind: 'meds', label: 'Birth Control', at_time: '08:30:00', days: [weekday], enabled: true }];
  ui().reminderToday = { b: { taken_at: new Date().toISOString() } };
  ui().viewDate = food.toDateOnly(new Date());
  const today = Alpine.reactive(components.todayPage());
  assert.deepEqual(today.meds.map((m) => m.label), ['Creatine']);
  ui().viewPerson(HER);
  assert.deepEqual(today.meds.map((m) => m.label), ['Birth Control']);
  assert.equal(today.medsSummary, '1 of 1 taken');
  ui().backToMe();
});

test('the switcher sums up each person\'s day', async () => {
  signIn();
  await seed();
  const weekday = new Date().getDay();
  ui().reminderAll = [{ id: 'b', owner_email: HER, kind: 'meds', label: 'Birth Control', at_time: '08:30:00', days: [weekday], enabled: true }];
  ui().reminderToday = {};
  assert.deepEqual(ui().daySummary(HER), ['600 of 1,800 kcal', '0 of 1 meds taken', 'Trained: Chest/Shoulders 1.0']);
  assert.deepEqual(ui().daySummary(ME), ['1,449 of 2,100 kcal']);
});

test('viewing is read-only: an entry of hers does not open for editing', async () => {
  signIn();
  await seed();
  const today = Alpine.reactive(components.todayPage());
  ui().viewPerson(HER);
  today.openEdit({ id: 'x', description: 'Hers', quantity: 1, unit: 'serving' });
  assert.equal(today.edit ?? null, null);
  ui().backToMe();
});

test('her Stats read her training, not yours', async () => {
  signIn();
  await seed();
  const stats = Alpine.reactive(components.statsPage());
  const mine = stats.data.index;
  ui().viewPerson(HER);
  assert.notEqual(stats.data.index, mine, 'a different index');
  assert.equal(stats.data.index, stats.data.index, 'built once and kept');
  assert.equal(stats.email, HER);
  ui().backToMe();
  assert.equal(stats.data.index, mine);
});

// ---- nudges and cheers ---------------------------------------------------------------

test('a nudge goes to the person on screen, and the sheet closes', async () => {
  signIn();
  const calls = [];
  const original = supabase.functions.invoke;
  supabase.functions.invoke = async (name, opts) => { calls.push({ name, ...opts }); return { data: { sent: 1 }, error: null }; };
  try {
    ui().viewPerson(HER);
    ui().openNudge();
    await ui().sendNudge('nudge', 'Log what you ate today?');
    assert.deepEqual(calls, [{ name: 'send-nudge', body: { to: HER, kind: 'nudge', body: 'Log what you ate today?' } }]);
    assert.equal(ui().nudgeOpen, false);

    ui().backToMe();
    await ui().sendNudge('nudge', 'nobody');
    assert.equal(calls.length, 1, 'nothing is sent while looking at your own day');
  } finally {
    supabase.functions.invoke = original;
    ui().backToMe();
  }
});

test('a refused nudge says why, in the function\'s own words, and keeps the sheet open', async () => {
  signIn();
  const original = supabase.functions.invoke;
  const flashed = [];
  const flash = ui().flash;
  ui().flash = (m) => flashed.push(m);
  supabase.functions.invoke = async () => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'One nudge an hour. Next in 42 min.' }) } },
  });
  try {
    ui().viewPerson(HER);
    ui().openNudge('Gym today?');
    await ui().sendNudge('nudge', 'Gym today?');
    assert.deepEqual(flashed, ['One nudge an hour. Next in 42 min.']);
    assert.equal(ui().nudgeOpen, true);
  } finally {
    supabase.functions.invoke = original;
    ui().flash = flash;
    ui().nudgeOpen = false;
    ui().backToMe();
  }
});

test('send-nudge rules: words, a real recipient, not yourself, and spacing', () => {
  const now = new Date('2026-11-24T20:00:00Z');
  const ask = (over) => ({ kind: 'nudge', body: 'Gym today?', from: ME, to: HER, ...over });
  assert.equal(rules.refusal(ask(), null, now), null);
  assert.equal(rules.refusal(ask({ kind: 'poke' }), null, now), 'Unknown kind.');
  assert.equal(rules.refusal(ask({ body: '   ' }), null, now), 'Say something.');
  assert.equal(rules.refusal(ask({ body: 'x'.repeat(121) }), null, now), 'Keep it under 120 characters.');
  assert.equal(rules.refusal(ask({ to: ME.toUpperCase() }), null, now), "That's you.");
  assert.equal(rules.refusal(ask(), '2026-11-24T19:18:00Z', now), 'One nudge an hour. Next in 18 min.');
  assert.equal(rules.refusal(ask(), '2026-11-24T18:59:00Z', now), null, 'an hour on, fine');
  assert.equal(rules.refusal(ask({ kind: 'cheer' }), '2026-11-24T19:57:00Z', now), 'Just cheered. Again in 2 min.');
  assert.equal(rules.titleOf('nudge', 'Carter'), 'Carter nudged you');
  assert.equal(rules.titleOf('cheer', ''), 'Someone cheered you on');
});

test('send-nudge only reaches someone who shares with the sender, and records each one', async () => {
  const src = await readFile(new URL('../supabase/functions/send-nudge/index.ts', import.meta.url), 'utf8');
  assert.match(src, /\.from\("share_grants"\)[\s\S]*?\.eq\("grantor_email", to\)[\s\S]*?\.eq\("grantee_email", from\)/);
  assert.match(src, /if \(!grant\) return json/);
  assert.match(src, /\.from\("nudges"\)\.insert\(/);
  assert.match(src, /const from = who\?\.user\?\.email\?\.toLowerCase\(\);/, 'the sender is the signed-in person, never the request body');
  const a = await readFile(new URL('../supabase/functions/send-nudge/webpush.ts', import.meta.url), 'utf8');
  const b = await readFile(new URL('../supabase/functions/notify-idle-workouts/webpush.ts', import.meta.url), 'utf8');
  assert.equal(a, b, 'the webpush copies stay byte-identical');
});

// ---- markup ------------------------------------------------------------------------

test('every control that writes is hidden while viewing, and the bar says whose day it is', async () => {
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../docs/css/pages.css', import.meta.url), 'utf8');
  assert.match(css, /\.app\.is-viewing \.mine-only \{ display: none !important; \}/);
  assert.match(html, /'is-viewing': \$store\.ui\.viewAs/);
  for (const control of [
    'class="mine-only tap day-mark"',
    'class="mine-only tap" @click="removeEntry(entry.id)"',
    'class="mine-only tap tap-primary" @click="confirmPlanned(entry)"',
    'class="mine-only btn btn-primary btn-block" @click="startEmpty()"',
    'class="mine-only btn" @click="openWeighing()"',
    'class="mine-only btn" @click="editGoal()"',
  ]) assert.ok(html.includes(control), control);
  assert.match(html, /x-show="\$store\.ui\.view === 'today' && !\$store\.ui\.logOpen && !\$store\.ui\.viewAs"/, 'no adding food to her day');
  assert.match(html, /x-text="`Viewing \$\{\$store\.ui\.viewName\}`"/);
  assert.match(html, /@click="\$store\.ui\.backToMe\(\)"/);
});
