// read-food-photo — turns a photo into something you can log.
//
// Two modes, one function because they share all the plumbing:
//
//   label — a Nutrition Facts panel. This is transcription. The numbers are
//           printed on the packet, so the answer is right or it is a misread,
//           and it goes into the normal review form.
//
//   meal  — a plate of food. This is estimation, and it is guessing: portion
//           size cannot be read off a photo, only inferred. Every field it
//           returns is an opinion, the response says so, and the UI has to keep
//           saying so. See the note on `confidence` below.
//
// It never writes to the database; the human reviews and saves, the same
// convention as import-photo in the recipes app, whose model-fallback logic this
// borrows because free-tier flash capacity is shared and 503s under load.
//
// Members only: we check plates.is_member() with the caller's JWT. The Gemini
// key lives in the GEMINI_API_KEY function secret and never reaches the browser.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";

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

const MEAL_PROMPT =
  "You are estimating the nutrition of a meal from a photograph. This is an " +
  "estimate and you should treat it as one.\n\n" +
  "Identify each distinct food you can see and estimate its portion. Judge " +
  "portion size against whatever is in frame for scale — a fork, a standard " +
  "dinner plate is about 27cm, a can is 355ml. Say what you assumed.\n\n" +
  "Be honest about uncertainty rather than splitting the difference. Hidden " +
  "oil, butter, dressings and sauces matter a lot and are usually invisible; " +
  "if a dish looks cooked in fat, say so in the note.\n\n" +
  "Do not imply precision you do not have. Round calories to the nearest 5 and " +
  "macros to the nearest gram.\n\n" +
  "Return ONLY a JSON object with exactly these keys:\n" +
  '{"items": [{"name": string, "portion": string, "calories": number, ' +
  '"protein_g": number, "carbs_g": number, "fat_g": number}], ' +
  '"confidence": "low"|"medium"|"high", "note": string|null, ' +
  '"unreadable": boolean}\n' +
  "portion is your assumed serving in plain words, e.g. \"about 150g, palm-sized\".\n" +
  'confidence is "high" only for simple, clearly visible, unmixed food; ' +
  '"low" whenever portion size is genuinely ambiguous or the dish could hide ' +
  "significant fat. Most mixed dishes are \"low\" or \"medium\".\n" +
  "note is one short sentence naming the biggest thing that could make this " +
  "wrong, or null. Set unreadable to true if there is no food in the picture.";

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

/**
 * Ask Gemini, falling through models when the free tier is busy.
 *
 * Lifted from import-photo, which learned this the hard way: shared flash
 * capacity is deprioritised under load and 503s, so one model is not enough.
 */
async function askGemini(
  apiKey: string,
  prompt: string,
  images: { imageBase64: string; mimeType: string }[],
): Promise<{ text: string } | { error: string; status: number }> {
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.imageBase64 } })),
      ],
    }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 },
  };

  const MODELS = [...new Set([
    MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite",
    "gemini-3.5-flash", "gemini-3.5-flash-lite",
  ])];

  let resp: Response | null = null;
  let lastStatus = 0;
  let lastDetail = "";

  for (const model of MODELS) {
    let hardError = false;
    for (let attempt = 0; attempt < 2 && !resp; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));

      let r: Response;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        );
      } catch (_) {
        lastStatus = 0;
        lastDetail = "network error";
        continue;
      }

      if (r.ok) { resp = r; break; }
      lastStatus = r.status;
      lastDetail = (await r.text()).slice(0, 300);
      if (r.status === 503) continue;                  // overloaded — retry this model
      if (r.status === 404 || r.status === 429) break; // try the next model
      hardError = true;
      break;                                            // bad request etc. — stop
    }
    if (resp || hardError) break;
  }

  if (!resp) {
    console.error("Gemini HTTP", lastStatus, lastDetail);
    return {
      error: lastStatus === 503
        ? "The reader is busy right now — try again in a moment."
        : `Reader error (${lastStatus}): ${lastDetail}`,
      status: lastStatus,
    };
  }

  const data = await resp.json();
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!out) {
    const reason = data?.promptFeedback?.blockReason
      ?? data?.candidates?.[0]?.finishReason
      ?? "empty response";
    return { error: `The reader returned nothing (${reason}).`, status: 502 };
  }
  return { text: out };
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
  try {
    const body = await req.json();
    mode = body?.mode === "meal" ? "meal" : "label";
    if (Array.isArray(body?.images)) {
      images = body.images
        .filter((i: { imageBase64?: string }) => i?.imageBase64)
        .map((i: { imageBase64: string; mimeType?: string }) => ({
          imageBase64: i.imageBase64,
          mimeType: i.mimeType ?? "image/jpeg",
        }));
    }
  } catch (_) { /* falls through to the empty check */ }

  if (!images.length) return json({ error: "No photo provided." }, 400);

  // 200 with an `error` field, not a 5xx: supabase-js hides the response body on
  // a non-2xx, so a status code here would reach the user as "Edge Function
  // returned a non-2xx status code" and lose the message that explains it.
  const answer = await askGemini(apiKey, mode === "meal" ? MEAL_PROMPT : LABEL_PROMPT, images);
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
      error: mode === "meal"
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
      protein_g: num(raw?.protein_g) ?? 0,
      carbs_g: num(raw?.carbs_g) ?? 0,
      fat_g: num(raw?.fat_g) ?? 0,
    }))
    .filter((i: { name: string; calories: number }) => i.name !== "Unnamed" || i.calories > 0);

  if (!items.length) {
    return json({ error: "Couldn't find food in that photo." });
  }

  const confidence = ["low", "medium", "high"].includes(String(parsed.confidence))
    ? String(parsed.confidence)
    : "low";   // absent means it didn't commit, which is not confidence

  return json({ mode, items, confidence, note: text(parsed.note) });
});
