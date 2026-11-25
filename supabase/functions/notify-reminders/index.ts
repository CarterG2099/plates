// notify-reminders — every member's own reminders: food, meds, and the morning
// and evening ones that used to be notify-morning and notify-evening.
//
// pg_cron calls this every minute (plates-reminders). It reads every enabled
// reminder, asks due.ts whether each one is due in Denver right now, and sends
// those that are. reminder_sends holds one row per reminder per local day: it is
// what stops a second send, what spaces out the nags for a med not yet taken,
// and — with taken_at — the meds log.
//
// Each kind decides its own words and whether to speak at all:
//   food     quiet when something was eaten and logged in the last N minutes
//   meds     always; asked again every 30 minutes until Taken, three times at most
//   morning  the motivation line (morning.ts)
//   evening  only when the day looks unfinished (nudge.ts)
//   weigh_in quiet once a weight is logged today
//   training quiet once a session has started today
//   custom   the member's own words
//
// A reminder at several times is several rows sharing a series_id; each row is
// sent, nagged and checked off on its own, so a med twice a day is two doses.
//
// A signed-in member may also call this with { test: <reminder id> } for one
// of their own: it is sent at once and nothing is recorded for the day.
//
// Food and meds can be set to keep reminding (persistent): then it comes back
// every 15 minutes, uncapped, until checked off — Taken for a med, Done for
// food — in the app or from the notification's button.
//
// Opt-in twice over, like the jobs it replaces: a live push subscription and the
// reminder switched on.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import. Edge Functions deploy as independent bundles, so a
// relative path out of this directory does not resolve once uploaded. The
// copies are byte-identical and must stay that way.
import { sendPush } from "./webpush.ts";
import {
  customMessage, foodMessage, localParts, medsMessage, quietForFood, trainingMessage, weighInMessage, whatIsDue, ZONE,
} from "./due.ts";
import type { Reminder, Send } from "./due.ts";
import { nudge } from "./nudge.ts";
import { morningMessage } from "./morning.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

type Row = Reminder & { id: string; owner_email: string; label: string; quiet_if_logged_min: number | null };

/** What a reminder's check-off is called, on its notification button. */
const checkOff = (r: Row) => (r.kind === "meds" ? "Taken" : "Done");

/** The evening nudge's day, read the way notify-evening read it. */
async function eveningMessage(db: SupabaseLike, owner: string, today: string, now: Date) {
  // A UTC window wide enough to cover any offset, then filtered to the local date.
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const { data: entries } = await db
    .from("food_log")
    .select("calories, logged_at, is_planned")
    .eq("owner_email", owner)
    .is("deleted_at", null)
    .gte("logged_at", since);

  const eaten = (entries ?? []).filter((e: { logged_at: string; is_planned: boolean }) =>
    !e.is_planned && localParts(new Date(e.logged_at), ZONE).date === today);
  const calories = eaten.reduce(
    (sum: number, e: { calories: number | null }) => sum + (Number(e.calories) || 0), 0);

  const { data: goals } = await db
    .from("goals")
    .select("calorie_target, starts_on, ends_on")
    .eq("owner_email", owner)
    .is("deleted_at", null)
    .lte("starts_on", today)
    .order("starts_on", { ascending: false })
    .limit(5);
  const goal = (goals ?? []).find((g: { ends_on: string | null }) => !g.ends_on || g.ends_on >= today);

  const { data: marks } = await db
    .from("day_marks")
    .select("id")
    .eq("owner_email", owner)
    .eq("day", today)
    .is("deleted_at", null)
    .limit(1);

  return nudge({
    calories,
    entryCount: eaten.length,
    target: Number(goal?.calorie_target) || null,
    reviewed: Boolean(marks?.length),
  });
}

/** When this member last logged something eaten, up to now. */
async function lastEatenAt(db: SupabaseLike, owner: string, now: Date): Promise<string | null> {
  const { data } = await db
    .from("food_log")
    .select("logged_at")
    .eq("owner_email", owner)
    .eq("is_planned", false)
    .is("deleted_at", null)
    .lte("logged_at", now.toISOString())
    .order("logged_at", { ascending: false })
    .limit(1);
  return data?.[0]?.logged_at ?? null;
}

/**
 * Whether this member already did the thing today, in Denver dates: a weight
 * logged (weigh_in) or a session started (training). A UTC window wide enough
 * for any offset, then filtered to the local date, as eveningMessage does.
 */
async function doneToday(db: SupabaseLike, table: "weight_log" | "sessions", owner: string, today: string, now: Date) {
  const column = table === "weight_log" ? "measured_at" : "started_at";
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const { data } = await db
    .from(table)
    .select(column)
    .eq("owner_email", owner)
    .is("deleted_at", null)
    .gte(column, since);
  return (data ?? []).some((row: Record<string, string>) => localParts(new Date(row[column]), ZONE).date === today);
}

/**
 * Who is asking for a test send, from their own sign-in: a member's email, or
 * null. Lets the app's "Send a test" button work without the cron secret, and
 * only ever for the caller's own reminders (checked where it is used).
 */
async function testerOf(db: SupabaseLike, req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: member } = await db.from("members").select("email").eq("email", email).maybeSingle();
  return member ? email : null;
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  const { data: configRows, error: configError } = await db.from("app_config").select("key, value");
  if (configError) return json({ error: configError.message }, 500);
  const config = Object.fromEntries((configRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

  // Same shared secret as the other jobs. It runs as service role across every
  // member, so it must not be invocable by anyone who finds the URL. The one
  // exception is a member testing one of their own reminders: signed in, and
  // limited below to a reminder they own, sent once and left out of the day's
  // record, so a test never counts as today's reminder or stops a real one.
  const cron = Boolean(config.cron_secret) && req.headers.get("x-cron-secret") === config.cron_secret;
  const tester = cron ? null : await testerOf(db, req);
  if (!cron && !tester) return json({ error: "forbidden" }, 403);
  let test: string | null = null;
  if (tester) {
    const asked = await req.json().catch(() => ({}));
    test = typeof asked?.test === "string" ? asked.test : null;
    if (!test) return json({ error: "which reminder?" }, 400);
  }
  if (!config.vapid_public_key || !config.vapid_private_key) {
    // notify-idle-workouts mints these; nothing here should be creating keys.
    return json({ error: "no vapid keys yet" }, 503);
  }

  const now = new Date();
  const local = localParts(now, ZONE);
  const today = local.date;
  // ?force=<reminder id> sends that one now, due or not, for testing.
  const force = new URL(req.url).searchParams.get("force");

  let query = db
    .from("reminders")
    .select("id, owner_email, kind, label, at_time, days, quiet_if_logged_min, enabled, deleted_at, persistent")
    .is("deleted_at", null);
  // A test may be of a reminder that is switched off: that is how you try one
  // before turning it on. Only ever the caller's own.
  query = test ? query.eq("id", test).eq("owner_email", tester) : query.eq("enabled", true);
  const { data: reminders, error: remindersError } = await query;
  if (remindersError) return json({ error: remindersError.message }, 500);
  if (!reminders?.length) return json({ today, sent: 0, note: "no reminders on" });

  const { data: sendRows } = await db
    .from("reminder_sends")
    .select("reminder_id, sends, last_sent_at, skipped, taken_at")
    .eq("local_date", today)
    .in("reminder_id", reminders.map((r: Row) => r.id));
  const sends = new Map<string, Send>((sendRows ?? []).map((s: Send & { reminder_id: string }) => [s.reminder_id, s]));

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };
  const takenUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/reminder-taken`;

  let sent = 0;
  let pruned = 0;
  const decisions: Record<string, string | null> = {};
  const subsByOwner = new Map<string, Array<{ id: string; endpoint: string; p256dh: string; auth: string }>>();

  for (const r of reminders as Row[]) {
    const send = sends.get(r.id) ?? null;
    const due = test ? "first"
      : force === r.id ? (send?.sends ? "nag" : "first")
      : force ? null
      : whatIsDue(r, send, local, now);
    if (!due) continue;

    if (!subsByOwner.has(r.owner_email)) {
      const { data: subs } = await db
        .from("push_subscriptions")
        .select("id, endpoint, p256dh, auth")
        .eq("owner_email", r.owner_email)
        .is("failed_at", null);
      subsByOwner.set(r.owner_email, subs ?? []);
    }
    const subs = subsByOwner.get(r.owner_email)!;
    if (!subs.length) continue;

    // Each kind's words, and whether it speaks at all. A test always speaks:
    // being quiet because you already logged would make "Send a test" look broken.
    let body: string | null;
    if (r.kind === "food" && due === "nag") {
      // Quiet was decided at the first send; from here only Done stops it.
      body = foodMessage(r.label, true);
    } else if (r.kind === "food") {
      body = !test && quietForFood(r.quiet_if_logged_min, await lastEatenAt(db, r.owner_email, now), now)
        ? null
        : foodMessage(r.label);
    } else if (r.kind === "meds") {
      body = medsMessage(r.label, due === "nag");
    } else if (r.kind === "weigh_in") {
      body = !test && due === "first" && await doneToday(db, "weight_log", r.owner_email, today, now)
        ? null
        : weighInMessage(due === "nag");
    } else if (r.kind === "training") {
      body = !test && due === "first" && await doneToday(db, "sessions", r.owner_email, today, now)
        ? null
        : trainingMessage(r.label, due === "nag");
    } else if (r.kind === "custom") {
      body = customMessage(r.label);
    } else if (r.kind === "evening") {
      body = await eveningMessage(db, r.owner_email, today, now)
        ?? (test ? "Evening check-in: tonight it would stay quiet, the day looks finished." : null);
    } else {
      body = await morningMessage(db, r.owner_email, today, ZONE);
    }
    decisions[r.id] = body;

    if (test) {
      const payload = JSON.stringify({
        title: r.kind === "meds" ? "Meds" : "Plates",
        body,
        tag: `reminder-test-${r.id}`,
        url: r.kind === "morning" || r.kind === "training" ? "/#train" : "/#today",
      });
      for (const sub of subs) {
        if ((await sendPush(sub, payload, vapid)).ok) sent++;
      }
      continue;
    }

    // A new token per send, so only the latest notification's button counts;
    // only its hash is kept. Anything that can be checked off carries one.
    const token = r.kind === "meds" || r.persistent ? crypto.randomUUID() + crypto.randomUUID() : null;
    const stamp = now.toISOString();
    const row = {
      reminder_id: r.id,
      owner_email: r.owner_email,
      local_date: today,
      sends: body ? (send?.sends ?? 0) + 1 : 0,
      first_sent_at: body ? (send?.sends ? undefined : stamp) : null,
      last_sent_at: body ? stamp : null,
      skipped: !body,
      token_hash: token ? await sha256(token) : null,
    };

    // Claim the send before making it, so two overlapping calls can't both
    // send: the first insert wins, and an existing row is only moved on from
    // the count this call read. (A row can exist before the first send: a dose
    // marked taken and then un-marked in the app.)
    let claimed;
    if (force === r.id) {
      ({ data: claimed } = await db.from("reminder_sends")
        .upsert(row, { onConflict: "reminder_id,local_date" }).select("reminder_id"));
    } else if (!send) {
      ({ data: claimed } = await db.from("reminder_sends")
        .upsert(row, { onConflict: "reminder_id,local_date", ignoreDuplicates: true }).select("reminder_id"));
    } else {
      const { sends, first_sent_at, last_sent_at, skipped, token_hash } = row;
      ({ data: claimed } = await db.from("reminder_sends")
        .update({ sends, last_sent_at, skipped, token_hash, ...(first_sent_at ? { first_sent_at } : {}) })
        .eq("reminder_id", r.id).eq("local_date", today).eq("sends", send.sends)
        .select("reminder_id"));
    }
    if (!claimed?.length || !body) continue;

    const payload = JSON.stringify({
      title: r.kind === "meds" ? "Meds" : "Plates",
      body,
      // One notification per reminder per day: a nag replaces the last one.
      tag: `reminder-${r.id}-${today}`,
      url: r.kind === "morning" || r.kind === "training" ? "/#train" : "/#today",
      ...(token ? { actions: [{ action: "taken", title: checkOff(r) }], taken: { url: takenUrl, token } } : {}),
    });

    for (const sub of subs) {
      const result = await sendPush(sub, payload, vapid);
      if (result.ok) { sent++; continue; }
      if (result.gone) {
        await db.from("push_subscriptions")
          .update({ failed_at: new Date().toISOString() })
          .eq("id", sub.id);
        pruned++;
      }
    }
  }

  // The decisions come back so a forced test run can be checked without
  // waiting for the phone. Behind the cron secret, so it discloses nothing.
  return json({ today, minutes: local.minutes, sent, pruned, decisions });
});
