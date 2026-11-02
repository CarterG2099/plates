// reminder-taken — the Taken button on a meds notification.
//
// The service worker answers that button without opening the app, and a worker
// has no sign-in to send. So the push itself carries the authority: a random
// token, whose hash notify-reminders stored on that day's reminder_sends row.
// Holding the token means having received that notification. It marks one
// dose taken and nothing else, so it is deployed with verify_jwt off.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let token = "";
  try { token = String((await req.json())?.token ?? ""); } catch (_) { /* empty token below */ }
  if (token.length < 32) return json({ error: "no token" }, 400);

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "plates" } },
  );

  // Already-taken rows are left with their first time: a second tap is not a
  // second dose.
  const { data, error } = await db.from("reminder_sends")
    .update({ taken_at: new Date().toISOString() })
    .eq("token_hash", await sha256(token))
    .is("taken_at", null)
    .select("reminder_id");
  if (error) return json({ error: error.message }, 500);
  return json({ taken: Boolean(data?.length) });
});
