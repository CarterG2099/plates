// read-food-photo — turns a photo (or a description) into something you can log.
//
// Three modes, one function because they share all the plumbing:
//
//   label    — a Nutrition Facts panel. This is transcription. The numbers are
//              printed on the packet, so the answer is right or it is a misread,
//              and it goes into the normal review form.
//
//   meal     — a plate of food. This is estimation, and it is guessing: portion
//              size cannot be read off a photo, only inferred. Every field it
//              returns is an opinion, the response says so, and the UI has to
//              keep saying so. See the note on `confidence` in meal-prompt.ts.
//              An optional `note` from the eater ("made with Greek yogurt",
//              "from Cafe Rio") carries what the photo can't show.
//
//   describe — no photo at all, just words, for the meal that is already eaten
//              and gone. Same estimation, same response shape as meal, one
//              notch less confident: there was never a frame to judge a
//              portion against.
//
// It never writes to the database; the human reviews and saves, the same
// convention as import-photo in the recipes app, whose model-fallback logic this
// borrows because free-tier flash capacity is shared and 503s under load.
//
// Members only: we check plates.is_member() with the caller's JWT. The Gemini
// key lives in the GEMINI_API_KEY function secret and never reaches the browser.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { MEAL_SCHEMA, cleanDescription, cleanNote, describePrompt, mealPrompt } from "./meal-prompt.ts";
import { askGemini } from "./gemini.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const LABEL_PROMPT =
  "You are reading the Nutrition Facts panel on a food package. Transcribe it " +
  "exactly as printed. Do not calculate, convert, or normalise anything — if " +
  "the panel says 230 calories per serving, report 230.\n\n" +
  "The values you report must be PER SERVING, as the panel states them. If the " +
  "panel gives both per-serving and per-container columns, use per serving.\n\n" +
  "Read the brand and product name from the front of the pack if it is visible; " +
  "otherwise leave them null rather than guessing.\n\n" +
  "Return ONLY a JSON object with exactly these keys:\n" +
  '{"name": string|null, "brand": string|null, "serving_text": string|null, ' +
  '"calories": number|null, "protein_g": number|null, "carbs_g": number|null, ' +
  '"fat_g": number|null, "fiber_g": number|null, "sodium_mg": number|null, ' +
  '"unreadable": boolean}\n' +
  "serving_text is the serving size exactly as printed, e.g. \"2/3 cup (55g)\".\n" +
  "Use null for any value not printed on the panel. Set unreadable to true if " +
  "this is not a nutrition label or it cannot be read.";

function stripFences(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/** A finite number, or null. Gemini returns strings and nulls interchangeably. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s && s.toLowerCase() !== "null" ? s : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: isMember } = await supabase.schema("plates").rpc("is_member");
  if (!isMember) return json({ error: "Not a Plates member." }, 403);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return json({ error: "Photo reading isn't configured yet (missing GEMINI_API_KEY)." }, 503);
  }

  let mode = "label";
  let images: { imageBase64: string; mimeType: string }[] = [];
  let note: string | null = null;
  let description: string | null = null;
  try {
    const body = await req.json();
    mode = body?.mode === "meal" || body?.mode === "describe" ? body.mode : "label";
    note = cleanNote(body?.note);
    description = cleanDescription(body?.description);
    if (Array.isArray(body?.images)) {
      images = body.images
        .filter((i: { imageBase64?: string }) => i?.imageBase64)
        .map((i: { imageBase64: string; mimeType?: string }) => ({
          imageBase64: i.imageBase64,
          mimeType: i.mimeType ?? "image/jpeg",
        }));
    }
  } catch (_) { /* falls through to the empty check */ }

  if (mode === "describe" && !description) return json({ error: "Nothing to estimate — describe what you ate." }, 400);
  if (mode !== "describe" && !images.length) return json({ error: "No photo provided." }, 400);

  const prompt = mode === "describe"
    ? describePrompt(description!)
    : mode === "meal"
    ? mealPrompt(note)
    : LABEL_PROMPT;

  // 200 with an `error` field, not a 5xx: supabase-js hides the response body on
  // a non-2xx, so a status code here would reach the user as "Edge Function
  // returned a non-2xx status code" and lose the message that explains it.
  const answer = await askGemini(apiKey, prompt, images, {
    schema: mode === "label" ? null : MEAL_SCHEMA,
    model: Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest",
  });
  if ("error" in answer) return json({ error: answer.error });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFences(answer.text));
  } catch (e) {
    console.error("Gemini parse error", String(e));
    return json({ error: "Couldn't read that photo." });
  }

  if (parsed?.unreadable === true) {
    return json({
      error: mode === "describe"
        ? "Couldn't find food in that description."
        : mode === "meal"
        ? "Couldn't find food in that photo."
        : "Couldn't read a nutrition label in that photo.",
    });
  }

  if (mode === "label") {
    // Shaped exactly like a lookup result so it lands in the same review form,
    // and stored as one serving like every other scanned food.
    const draft = {
      name: text(parsed.name) ?? "",
      brand: text(parsed.brand),
      barcode: null,
      serving_qty: 1,
      serving_unit: "serving",
      default_qty: null,
      basis: text(parsed.serving_text) ?? "one serving",
      calories: num(parsed.calories),
      protein_g: num(parsed.protein_g),
      carbs_g: num(parsed.carbs_g),
      fat_g: num(parsed.fat_g),
      fiber_g: num(parsed.fiber_g),
      sodium_mg: num(parsed.sodium_mg),
      source: "label_photo",
    };

    const REQUIRED = ["calories", "protein_g", "carbs_g", "fat_g"] as const;
    return json({
      mode,
      draft,
      missing: REQUIRED.filter((k) => draft[k] == null),
    });
  }

  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const items = rawItems
    .map((raw: Record<string, unknown>) => ({
      name: text(raw?.name) ?? "Unnamed",
      portion: text(raw?.portion),
      calories: num(raw?.calories) ?? 0,
      // Missing stays missing. Defaulted to 0, an answer without macros logged
      // a plate as having no protein at all, and nothing on screen said so.
      protein_g: num(raw?.protein_g),
      carbs_g: num(raw?.carbs_g),
      fat_g: num(raw?.fat_g),
    }))
    .filter((i: { name: string; calories: number }) => i.name !== "Unnamed" || i.calories > 0);

  if (!items.length) {
    return json({
      error: mode === "describe"
        ? "Couldn't find food in that description."
        : "Couldn't find food in that photo.",
    });
  }

  const confidence = ["low", "medium", "high"].includes(String(parsed.confidence))
    ? String(parsed.confidence)
    : "low";   // absent means it didn't commit, which is not confidence

  return json({ mode, items, confidence, note: text(parsed.note) });
});
