// notify-message — "New message" on the other phone.
//
// Called by the messages_notify trigger on plates.messages, once per inserted
// row, with the row's id. The push says only that there is a message: no
// text, no sender, no photo. The conversation sits behind the photo PIN, and a
// lock-screen preview would walk straight past it.
//
// Runs with the service role key to read the recipient's push subscriptions,
// so it is gated on the same shared secret the cron-called functions use and
// deployed with verify_jwt off.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "./webpush.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  const { data: rows, error: configError } = await db.from("app_config").select("key, value");
  if (configError) return json({ error: configError.message }, 500);
  const config = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));

  if (!config.cron_secret || req.headers.get("x-cron-secret") !== config.cron_secret) {
    return json({ error: "forbidden" }, 403);
  }
  // Minted by notify-idle-workouts; without them there is nothing to sign with.
  if (!config.vapid_public_key || !config.vapid_private_key) return json({ error: "no vapid keys" }, 500);

  let id = "";
  try { id = String((await req.json())?.id ?? ""); } catch (_) { /* empty id below */ }
  if (!id) return json({ error: "no id" }, 400);

  const { data: message, error } = await db.from("messages")
    .select("recipient_email, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  // Unsent before the push went out: nothing to announce.
  if (!message || message.deleted_at) return json({ sent: 0 });

  // The recipient can switch message alerts off on the notifications page. No
  // row, or no answer, means on: that is how it behaved before the switch.
  const { data: prefs } = await db.from("notification_prefs")
    .select("messages")
    .eq("owner_email", message.recipient_email)
    .maybeSingle();
  if (prefs?.messages === false) return json({ sent: 0, note: "messages off" });

  const { data: subs } = await db.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("owner_email", message.recipient_email)
    .is("failed_at", null);

  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };
  // One tag for every message, so five in a row are one notification, not five.
  const payload = JSON.stringify({ title: "Plates", body: "New message", tag: "plates-message", url: "/" });

  let sent = 0;
  for (const sub of subs ?? []) {
    const result = await sendPush(sub, payload, vapid);
    if (result.ok) { sent++; continue; }
    if (result.gone) {
      await db.from("push_subscriptions").update({ failed_at: new Date().toISOString() }).eq("id", sub.id);
    }
  }
  return json({ sent });
});
