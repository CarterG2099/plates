// notify-idle-workouts — "you left a workout running".
//
// A session with nothing logged for twenty minutes is almost always one you
// walked away from. The app cannot notice this itself: a phone suspends a
// backgrounded PWA within moments, so nothing in the page is alive to fire a
// timer. Only something server-side can, which is what this is — pg_cron calls
// it every five minutes and it pushes to whoever has opted in.
//
// Runs with the service role key, because it deliberately reads across owners:
// it is checking everybody's sessions, not the caller's. It is not reachable
// with a user JWT — see the shared-secret check below — so no RLS is bypassed
// on anyone's behalf.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "./webpush.ts";

/** How long a session must be untouched before it counts as forgotten. */
const IDLE_MINUTES = 20;

/** Don't nag more than this often about the same session. */
const RENOTIFY_HOURS = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  // Only the scheduler may call this. It runs as service role and reports on
  // every member, so it must not be invocable by anyone who finds the URL.
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || req.headers.get("x-cron-secret") !== expected) {
    return json({ error: "forbidden" }, 403);
  }

  const vapid = {
    publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
    privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
    subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:plates@cartergividen.com",
  };
  if (!vapid.publicKey || !vapid.privateKey) return json({ error: "vapid keys not configured" }, 500);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  const now = Date.now();
  const idleBefore = new Date(now - IDLE_MINUTES * 60_000).toISOString();
  const renotifyBefore = new Date(now - RENOTIFY_HOURS * 3_600_000).toISOString();

  const { data: open, error } = await db
    .from("sessions")
    .select("id, owner_email, name, started_at, idle_notified_at")
    .is("ended_at", null)
    .is("deleted_at", null)
    .lt("started_at", idleBefore);

  if (error) return json({ error: error.message }, 500);

  const stale: { session: Record<string, unknown>; idleMinutes: number }[] = [];

  for (const session of open ?? []) {
    // Last activity is the newest set touched, or the start if nothing was ever
    // logged. updated_at moves on every edit and every checkmark, which is
    // exactly the definition of "doing something" we want.
    const { data: last } = await db
      .from("session_sets")
      .select("updated_at")
      .eq("session_id", session.id)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1);

    const lastAt = last?.[0]?.updated_at ?? session.started_at;
    if (lastAt >= idleBefore) continue;                     // still being worked
    if (session.idle_notified_at && session.idle_notified_at > renotifyBefore) continue;

    stale.push({ session, idleMinutes: Math.round((now - Date.parse(lastAt)) / 60_000) });
  }

  let sent = 0;
  let pruned = 0;

  for (const { session, idleMinutes } of stale) {
    const { data: subs } = await db
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("owner_email", session.owner_email)
      .is("failed_at", null);

    if (!subs?.length) continue;

    const payload = JSON.stringify({
      title: "Still training?",
      body: `${session.name || "Workout"} · nothing logged for ${idleMinutes} min`,
      tag: `idle-${session.id}`,
    });

    let delivered = false;
    for (const sub of subs) {
      const result = await sendPush(sub, payload, vapid);
      if (result.ok) { delivered = true; sent++; continue; }

      // The browser dropped this subscription; stop pushing to a dead endpoint.
      if (result.gone) {
        await db.from("push_subscriptions")
          .update({ failed_at: new Date().toISOString() })
          .eq("id", sub.id);
        pruned++;
      }
    }

    // Only marked once something actually landed, so a total delivery failure
    // gets retried on the next run rather than being silently swallowed.
    if (delivered) {
      await db.from("sessions")
        .update({ idle_notified_at: new Date().toISOString() })
        .eq("id", session.id);
    }
  }

  return json({ checked: open?.length ?? 0, stale: stale.length, sent, pruned });
});
