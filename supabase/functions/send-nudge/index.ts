// send-nudge — a nudge or a cheer to the other person's phone.
//
// Called from the app by a signed-in member, with { to, kind, body }. The
// sender must be able to see the recipient's day (a share grant from them),
// which is what "the two of you" means everywhere else in Plates. Nudges are
// spaced an hour apart per pair and cheers five minutes, so it stays a nudge.
// Each one is kept in plates.nudges, which is also what the spacing reads.
//
// verify_jwt is off and the caller is checked here instead, the way
// notify-reminders checks a member's test: the service role is needed to read
// the recipient's push subscriptions, never the caller's own rights.
import { createClient } from "jsr:@supabase/supabase-js@2";
// A copy, not an import: Edge Functions deploy as independent bundles. The
// copies are byte-identical and must stay that way.
import { sendPush } from "./webpush.ts";
import { refusal, titleOf } from "./rules.ts";
import type { Kind } from "./rules.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  // Who is sending, from their own sign-in.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: null };
  const from = who?.user?.email?.toLowerCase();
  if (!from) return json({ error: "Sign in first." }, 401);

  const ask = await req.json().catch(() => ({}));
  const to = typeof ask?.to === "string" ? ask.to.trim().toLowerCase() : "";

  const { data: members } = await db.from("members").select("email, display_name").in("email", [from, to]);
  const sender = (members ?? []).find((m: { email: string }) => m.email.toLowerCase() === from);
  if (!sender) return json({ error: "Not a member." }, 403);
  if (!(members ?? []).some((m: { email: string }) => m.email.toLowerCase() === to)) {
    return json({ error: "Who to?" }, 400);
  }

  // Only someone whose day you can see: they granted it to you.
  const { data: grant } = await db.from("share_grants")
    .select("grantor_email")
    .eq("grantor_email", to)
    .eq("grantee_email", from)
    .maybeSingle();
  if (!grant) return json({ error: "You can only nudge someone who shares with you." }, 403);

  const { data: last } = await db.from("nudges")
    .select("created_at")
    .eq("from_email", from).eq("to_email", to).eq("kind", ask?.kind)
    .order("created_at", { ascending: false })
    .limit(1);
  const now = new Date();
  const why = refusal({ kind: ask?.kind, body: ask?.body, from, to }, last?.[0]?.created_at ?? null, now);
  if (why) return json({ error: why }, 429);

  const kind = ask.kind as Kind;
  const body = String(ask.body).trim();
  const { error: insertError } = await db.from("nudges").insert({ from_email: from, to_email: to, kind, body });
  if (insertError) return json({ error: insertError.message }, 500);

  const { data: configRows } = await db.from("app_config").select("key, value");
  const config = Object.fromEntries((configRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  if (!config.vapid_public_key || !config.vapid_private_key) return json({ error: "no vapid keys" }, 503);
  const vapid = {
    publicKey: config.vapid_public_key,
    privateKey: config.vapid_private_key,
    subject: config.vapid_subject ?? "mailto:carter@cartergividen.com",
  };

  const { data: subs } = await db.from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("owner_email", to)
    .is("failed_at", null);

  const payload = JSON.stringify({
    title: titleOf(kind, sender.display_name ?? ""),
    body,
    tag: `${kind}-${from}`,
    url: "/#today",
  });

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
