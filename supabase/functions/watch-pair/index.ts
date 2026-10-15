// watch-pair — signs a watch in, vouched for by a signed-in phone.
//
// Plates signs in with Google, which can't happen on a watch screen. So:
//
//   create — the phone, signed in, asks for a code. One live code per account;
//            making a new one retires the old.
//   redeem — the watch, not signed in, sends the code back. If it matches, the
//            watch gets a session of its own for that account: its own refresh
//            token, the same RLS as any other device. No shared secret, and
//            nothing the watch writes goes around the row policies.
//
// Deployed with verify_jwt off, because redeem by definition has no JWT yet;
// create checks the caller's JWT itself.
//
// The session is minted with a magic-link token generated and verified here, on
// the server — no email is sent. It needs email sign-in enabled on the project,
// which recipes shares.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { hashCode, MAX_FAILURES, newCode, normaliseCode, TTL_MS } from "./pairing.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 200 with an `error` field, not a 4xx: supabase-js hides the body of a non-2xx,
// and the message is the part that says what to do.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const pairings = () => admin.schema("plates").from("watch_pairings");

async function create(req: Request): Promise<Response> {
  const user = createClient(URL_, ANON, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });

  const { data: { user: me } } = await user.auth.getUser();
  if (!me?.email) return json({ error: "Sign in on the phone first." });

  const { data: isMember } = await user.schema("plates").rpc("is_member");
  if (!isMember) return json({ error: "Not a Plates member." });

  const now = new Date();
  // Retire whatever code this account had live: only the one on screen works.
  await pairings().update({ used_at: now.toISOString() })
    .eq("owner_email", me.email).is("used_at", null);

  const code = newCode();
  const expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
  const { error } = await pairings().insert({
    owner_email: me.email,
    code_hash: await hashCode(code),
    expires_at: expiresAt,
  });
  if (error) return json({ error: error.message });

  return json({ code, expires_at: expiresAt });
}

async function redeem(raw: unknown): Promise<Response> {
  const code = normaliseCode(raw);
  if (!code) return json({ error: "The code is 8 digits." });

  const now = new Date().toISOString();
  const { data: live } = await pairings()
    .select("id, owner_email, code_hash, failed_attempts")
    .is("used_at", null).gt("expires_at", now).lt("failed_attempts", MAX_FAILURES);

  const hash = await hashCode(code);
  const match = (live ?? []).find((p) => p.code_hash === hash);

  if (!match) {
    // Every wrong guess counts against every live code, so guessing burns the
    // codes out long before it could find one.
    for (const p of live ?? []) {
      await pairings().update({ failed_attempts: p.failed_attempts + 1 }).eq("id", p.id);
    }
    return json({ error: "That code didn't match. Make a new one on the phone." });
  }

  // Claimed with a guard on used_at, so two watches racing one code can't both win.
  const { data: claimed } = await pairings().update({ used_at: now })
    .eq("id", match.id).is("used_at", null).select("id");
  if (!claimed?.length) return json({ error: "That code was already used." });

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: match.owner_email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    return json({ error: `Couldn't sign the watch in: ${linkError?.message ?? "no token"}` });
  }

  const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  const session = verified?.session;
  if (verifyError || !session) {
    return json({ error: `Couldn't sign the watch in: ${verifyError?.message ?? "no session"}` });
  }

  return json({
    email: match.owner_email,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: { action?: string; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  if (body?.action === "create") return create(req);
  if (body?.action === "redeem") return redeem(body.code);
  return json({ error: "Unknown action." }, 400);
});
