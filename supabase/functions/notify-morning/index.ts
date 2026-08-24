// notify-morning — one line of encouragement at 6:30am local.
//
// Opt-in twice over: it needs a live push subscription *and*
// plates.notification_prefs.morning_quotes set. A daily notification nobody
// asked for is the kind of thing people uninstall an app over, so the pref
// defaults to false and the settings sheet is the only thing that sets it.
//
// Scheduling is the awkward part. pg_cron has no per-job timezone, so a fixed
// UTC hour drifts by one across daylight saving — 6:30 in Denver is 12:30 UTC in
// summer and 13:30 in winter. The cron therefore fires at *both*, and this
// function decides which one is really 6am local. A date stamp in app_config
// makes the second call a no-op, so exactly one lands per local day.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import. Edge Functions deploy as independent bundles, so a
// relative path out of this directory does not resolve once uploaded. The two
// copies are byte-identical and must stay that way; the RFC 8291 encryption in
// there is not something to let drift.
import { sendPush } from "./webpush.ts";

/** Where "morning" is. Not a member preference yet — there is one household. */
const ZONE = "America/Denver";

/** The hour that counts as morning, local. */
const SEND_HOUR = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** Local wall-clock parts, without pulling in a date library. */
function localParts(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/**
 * Day and week streaks from finished sessions, in local dates.
 *
 * A deliberately smaller version of stats.trainingConsistency in the client: it
 * needs the same two numbers and cannot import a browser module. Both are
 * forgiving of the day you are still in, which at 6:30am is the entire point —
 * yesterday's training still counts this morning.
 */
function streaks(startedAt: string[], todayLocal: string, zone: string) {
  const dayOf = (iso: string) => localParts(new Date(iso), zone).date;
  const days = new Set(startedAt.map(dayOf));

  const shift = (date: string, by: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + by);
    return d.toISOString().slice(0, 10);
  };

  let cursor = days.has(todayLocal) ? todayLocal : shift(todayLocal, -1);
  let dayStreak = 0;
  while (days.has(cursor)) { dayStreak++; cursor = shift(cursor, -1); }

  // Monday-anchored, matching the client and weeklyTraining.
  const mondayOf = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const weeks = new Set([...days].map(mondayOf));

  let week = weeks.has(mondayOf(todayLocal)) ? mondayOf(todayLocal) : shift(mondayOf(todayLocal), -7);
  let weekStreak = 0;
  while (weeks.has(week)) { weekStreak++; week = shift(week, -7); }

  const lastDay = [...days].sort().pop() ?? null;
  const daysSince = lastDay
    ? Math.round((Date.parse(`${todayLocal}T12:00:00Z`) - Date.parse(`${lastDay}T12:00:00Z`)) / 86_400_000)
    : null;

  return { dayStreak, weekStreak, daysSince, everTrained: days.size > 0 };
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The message.
 *
 * Every candidate is written by hand; the only thing generated is which one gets
 * picked. Lines that know something specific are offered alongside the generic
 * ones rather than instead of them, so a long streak does not produce the same
 * sentence every morning for a month.
 */
function compose(
  s: { dayStreak: number; weekStreak: number; daysSince: number | null; everTrained: boolean },
  last: { name: string | null; weight: number | null; reps: number | null; when: string | null },
  random: () => number,
) {
  const lines: string[] = [
    "Morning. The bar is where you left it.",
    "Show up today. That is most of it.",
    "Nobody has ever regretted the session they did.",
    "Small session beats no session.",
  ];

  if (!s.everTrained) {
    return "Morning. Nothing logged yet — today is a good day to start.";
  }
  if (s.weekStreak >= 2) {
    lines.push(`${plural(s.weekStreak, "week")} running. Today makes ${s.weekStreak + 1}.`);
    lines.push(`You have not missed a week in ${plural(s.weekStreak, "week")}. Keep it.`);
  }
  if (s.dayStreak >= 2) {
    lines.push(`${plural(s.dayStreak, "day")} in a row. Again?`);
  }
  if (s.daysSince !== null && s.daysSince >= 3) {
    lines.push(`${plural(s.daysSince, "day")} off. The bar is still there.`);
    lines.push("Longest part of any break is starting it again. Today?");
  }
  if (last.weight && last.reps && last.name) {
    lines.push(`You put up ${last.weight} × ${last.reps} on ${last.name}${last.when ? ` ${last.when}` : ""}.`);
  }

  return lines[Math.floor(random() * lines.length)];
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

  // Same shared secret as the idle job. It runs as service role across every
  // member, so it must not be invocable by anyone who finds the URL.
  if (!config.cron_secret || req.headers.get("x-cron-secret") !== config.cron_secret) {
    return json({ error: "forbidden" }, 403);
  }
  if (!config.vapid_public_key || !config.vapid_private_key) {
    // notify-idle-workouts mints these; nothing here should be creating keys.
    return json({ error: "no vapid keys yet" }, 503);
  }

  const now = new Date();
  const { date: today, hour } = localParts(now, ZONE);
  const force = new URL(req.url).searchParams.get("force") === "1";

  if (!force && hour !== SEND_HOUR) return json({ skipped: "not the hour", hour, zone: ZONE });
  if (!force && config.morning_sent_on === today) return json({ skipped: "already sent", today });

  const { data: wanting, error: prefsError } = await db
    .from("notification_prefs")
    .select("owner_email")
    .eq("morning_quotes", true);
  if (prefsError) return json({ error: prefsError.message }, 500);
  if (!wanting?.length) return json({ sent: 0, note: "nobody opted in" });

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };

  let sent = 0;
  let pruned = 0;

  for (const { owner_email } of wanting) {
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("owner_email", owner_email)
      .is("failed_at", null);
    if (!subs?.length) continue;

    const { data: sessions } = await db
      .from("sessions")
      .select("id, name, started_at")
      .eq("owner_email", owner_email)
      .not("ended_at", "is", null)
      .is("deleted_at", null)
      .order("started_at", { ascending: false })
      .limit(400);

    const s = streaks((sessions ?? []).map((x: { started_at: string }) => x.started_at), today, ZONE);

    // The heaviest completed working set of the most recent session, for the
    // lines that name something you actually did.
    let last: { name: string | null; weight: number | null; reps: number | null; when: string | null } =
      { name: null, weight: null, reps: null, when: null };

    if (sessions?.length) {
      const { data: best } = await db
        .from("session_sets")
        .select("exercise_name, weight_lb, reps")
        .eq("session_id", sessions[0].id)
        .not("completed_at", "is", null)
        .eq("is_warmup", false)
        .not("weight_lb", "is", null)
        .order("weight_lb", { ascending: false })
        .limit(1);

      if (best?.[0]) {
        last = {
          name: best[0].exercise_name,
          weight: best[0].weight_lb,
          reps: best[0].reps,
          when: new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long" })
            .format(new Date(sessions[0].started_at)),
        };
      }
    }

    const payload = JSON.stringify({
      title: "Plates",
      body: compose(s, last, Math.random),
      tag: `morning-${today}`,
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

  // Stamped only when something landed, so a total failure retries on the
  // second cron hour rather than being silently swallowed for the day.
  if (sent > 0 && !force) {
    await db.from("app_config").upsert(
      { key: "morning_sent_on", value: today, is_public: false, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  }

  return json({ today, hour, recipients: wanting.length, sent, pruned });
});
