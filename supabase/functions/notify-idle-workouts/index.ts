// notify-idle-workouts — "you left a workout running".
//
// A session with nothing logged for twenty minutes is almost always one you
// walked away from. The app cannot notice this itself: a phone suspends a
// backgrounded PWA within moments, so nothing in the page is alive to fire a
// timer. Only something server-side can, which is what this is — pg_cron pokes
// it every couple of minutes and it pushes to whoever has opted in.
//
// The threshold below is what defines "forgotten"; the cron cadence only decides
// how long after that you hear about it. They are separate knobs and it is worth
// not conflating them: at a two-minute cadence a forgotten session is noticed
// 20-22 minutes after you stop, where matching the cadence to the threshold made
// it 20-40. The schedule lives in cron.job, not here.
//
// Runs with the service role key, because it deliberately reads across owners:
// it is checking everybody's sessions, not the caller's. It is not reachable
// with a user JWT — see the shared-secret check below — so no RLS is bypassed
// on anyone's behalf.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush, bytesToB64url } from "./webpush.ts";

/** How long a session must be untouched before it counts as forgotten. */
const IDLE_MINUTES = 20;

/** Don't nag more than this often about the same session. */
const RENOTIFY_HOURS = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Everything this needs, from plates.app_config rather than a dashboard.
 *
 * Nothing here is set by hand. The VAPID keypair is generated on the first run
 * that finds none and stored straight away — a key that was written down in a
 * temp file once already got lost, taking the only copy of the private half with
 * it. The browser reads the public row to subscribe; the private row never
 * leaves the server, because only the service role can see a non-public row.
 */
async function loadConfig(db: SupabaseLike) {
  const { data, error } = await db.from("app_config").select("key, value");
  if (error) throw new Error(`app_config unreadable: ${error.message}`);

  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

/**
 * Mint the keypair if there isn't one, and hand back the config either way.
 *
 * Deliberately after the caller has been authenticated: this writes, and an
 * unauthenticated request should not be able to make the server do anything but
 * read. Generating only when absent means a second call is a no-op, so the pair
 * is stable once it exists — which subscriptions depend on.
 */
async function ensureKeys(db: SupabaseLike, config: Record<string, string>) {
  if (config.vapid_public_key && config.vapid_private_key) return config;

  const keys = await generateVapidKeys();
  const { error } = await db.from("app_config").upsert([
    { key: "vapid_public_key", value: keys.publicKey, is_public: true, updated_at: new Date().toISOString() },
    { key: "vapid_private_key", value: keys.privateKey, is_public: false, updated_at: new Date().toISOString() },
  ], { onConflict: "key" });
  if (error) throw new Error(`could not store vapid keys: ${error.message}`);

  return { ...config, vapid_public_key: keys.publicKey, vapid_private_key: keys.privateKey };
}

/** A P-256 pair in the shape webpush.ts wants: raw public point, scalar private. */
async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  return { publicKey: bytesToB64url(raw), privateKey: jwk.d as string };
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

Deno.serve(async (req) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  let config: Record<string, string>;
  try {
    config = await loadConfig(db);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }

  // Only the scheduler may call this. It runs as service role and reports on
  // every member, so it must not be invocable by anyone who finds the URL.
  const expected = config.cron_secret;
  if (!expected || req.headers.get("x-cron-secret") !== expected) {
    return json({ error: "forbidden" }, 403);
  }

  try {
    config = await ensureKeys(db, config);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };

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
