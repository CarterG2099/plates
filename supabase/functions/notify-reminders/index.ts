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
//
// Opt-in twice over, like the jobs it replaces: a live push subscription and the
// reminder switched on.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import. Edge Functions deploy as independent bundles, so a
// relative path out of this directory does not resolve once uploaded. The
// copies are byte-identical and must stay that way.
import { sendPush } from "./webpush.ts";
import { foodMessage, localParts, medsMessage, quietForFood, whatIsDue, ZONE } from "./due.ts";
import type { Reminder, Send } from "./due.ts";
import { nudge } from "./nudge.ts";
import { morningMessage } from "./morning.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

type Row = Reminder & { id: string; owner_email: string; label: string; quiet_if_logged_min: number | null };

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
  // member, so it must not be invocable by anyone who finds the URL.
  if (!config.cron_secret || req.headers.get("x-cron-secret") !== config.cron_secret) {
    return json({ error: "forbidden" }, 403);
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

  const { data: reminders, error: remindersError } = await db
    .from("reminders")
    .select("id, owner_email, kind, label, at_time, days, quiet_if_logged_min, enabled, deleted_at")
    .eq("enabled", true)
    .is("deleted_at", null);
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
    const due = force === r.id ? (send?.sends ? "nag" : "first") : force ? null : whatIsDue(r, send, local, now);
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

    let body: string | null;
    if (r.kind === "food") {
      body = quietForFood(r.quiet_if_logged_min, await lastEatenAt(db, r.owner_email, now), now)
        ? null
        : foodMessage(r.label);
    } else if (r.kind === "meds") {
      body = medsMessage(r.label, due === "nag");
    } else if (r.kind === "evening") {
      body = await eveningMessage(db, r.owner_email, today, now);
    } else {
      body = await morningMessage(db, r.owner_email, today, ZONE);
    }
    decisions[r.id] = body;

    // A new token per send, so only the latest notification's Taken button
    // counts; only its hash is kept.
    const token = r.kind === "meds" ? crypto.randomUUID() + crypto.randomUUID() : null;
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
      url: r.kind === "morning" ? "/#train" : "/#today",
      ...(token ? { actions: [{ action: "taken", title: "Taken" }], taken: { url: takenUrl, token } } : {}),
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
