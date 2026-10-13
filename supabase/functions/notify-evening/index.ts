// notify-evening — "finish logging today?", at 8:30pm local, only when the day
// actually looks unfinished.
//
// The whole value of this notification is the nights it stays silent. A
// reminder that fires every evening gets swiped away by reflex within a week,
// and then it fires on the one night it mattered and gets swiped away too. So
// the decision lives in nudge.ts and is deliberately conservative: an empty
// day, or a day clearly short of the calorie target. A day already marked —
// complete or not — was answered, and answered days are left alone.
//
// Opt-in twice over, like notify-morning: a live push subscription *and*
// plates.notification_prefs.evening_nudge set. Scheduling is the same DST
// dance: pg_cron fires at both 02:30 and 03:30 UTC, this function decides
// which one is really 8:30pm in Denver, and a date stamp in app_config makes
// the other call a no-op.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import. Edge Functions deploy as independent bundles, so a
// relative path out of this directory does not resolve once uploaded. The
// three copies are byte-identical and must stay that way.
import { sendPush } from "./webpush.ts";
import { localParts, skipReason, ZONE } from "./schedule.ts";
import { nudge } from "./nudge.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  const { date: today, hour } = local;
  const force = new URL(req.url).searchParams.get("force") === "1";

  const skipped = force ? null : skipReason(local, config.evening_sent_on);
  if (skipped) return json({ skipped, today, hour, zone: ZONE });

  const { data: wanting, error: prefsError } = await db
    .from("notification_prefs")
    .select("owner_email")
    .eq("evening_nudge", true);
  if (prefsError) return json({ error: prefsError.message }, 500);
  if (!wanting?.length) return json({ sent: 0, note: "nobody opted in" });

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };

  let sent = 0;
  let pruned = 0;
  const decisions: Record<string, string | null> = {};

  for (const { owner_email } of wanting) {
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("owner_email", owner_email)
      .is("failed_at", null);
    if (!subs?.length) continue;

    // The local day's eaten entries. Fetched by a UTC window wide enough to
    // cover any offset, then filtered to the local date — cheaper to reason
    // about than computing Denver's UTC bounds, and it stays right under force.
    const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
    const { data: entries } = await db
      .from("food_log")
      .select("calories, logged_at, is_planned")
      .eq("owner_email", owner_email)
      .is("deleted_at", null)
      .gte("logged_at", since);

    const eaten = (entries ?? []).filter((e: { logged_at: string; is_planned: boolean }) =>
      !e.is_planned && localParts(new Date(e.logged_at), ZONE).date === today);
    const calories = eaten.reduce(
      (sum: number, e: { calories: number | null }) => sum + (Number(e.calories) || 0), 0);

    const { data: goals } = await db
      .from("goals")
      .select("calorie_target, starts_on, ends_on")
      .eq("owner_email", owner_email)
      .is("deleted_at", null)
      .lte("starts_on", today)
      .order("starts_on", { ascending: false })
      .limit(5);
    const goal = (goals ?? []).find((g: { ends_on: string | null }) => !g.ends_on || g.ends_on >= today);

    const { data: marks } = await db
      .from("day_marks")
      .select("id")
      .eq("owner_email", owner_email)
      .eq("day", today)
      .is("deleted_at", null)
      .limit(1);

    const body = nudge({
      calories,
      entryCount: eaten.length,
      target: Number(goal?.calorie_target) || null,
      reviewed: Boolean(marks?.length),
    });
    decisions[owner_email] = body;
    if (!body) continue;

    const payload = JSON.stringify({
      title: "Plates",
      body,
      tag: `evening-${today}`,
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

  // Stamped when something landed, or when the decision was to stay quiet —
  // "decided, nothing to say" is as final as "sent". Left unstamped only when a
  // nudge was due and every push failed, so that retries on the one day a year
  // both cron hours land on 8:30pm instead of being silently swallowed.
  const wantedToSend = Object.values(decisions).some(Boolean);
  if (!force && (sent > 0 || !wantedToSend)) {
    await db.from("app_config").upsert(
      { key: "evening_sent_on", value: today, is_public: false, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  }

  // The decisions come back so a forced test run can be checked without
  // waiting for the phone. Behind the cron secret, so it discloses nothing.
  return json({ today, hour, recipients: wanting.length, sent, pruned, decisions });
});
