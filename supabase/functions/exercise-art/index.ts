// exercise-art — draws one exercise, once.
//
// Generates a flat line illustration of a person performing the movement, with
// the equipment that names it and the worked muscle picked out in a second
// colour, then stores it and hands back a URL. Called once per exercise; after
// that the app just loads the image.
//
// Why generated rather than sourced: the only free photo set covering these
// lifts is Free Exercise DB, and a photograph of a person in a gym is unreadable
// at the 44px the list actually renders. Line art survives being small.
//
// The muscle is passed in rather than derived here. The client already classifies
// it in muscle-map.js for the drawn figure, and two classifiers would drift.
//
// Members only. The Gemini key stays in GEMINI_API_KEY; the upload uses the
// service role, so nothing in the browser can write to the bucket.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "plates-exercise-art";

// Every image model the key can reach, cheapest first.
//
// They meter separately, so a 429 on one is not a 429 on all — and 429 is the
// failure that actually happens here: free-tier image generation has a much
// tighter quota than text. Lite first for that reason, not for quality.
const MODELS = [
  ...(Deno.env.get("GEMINI_IMAGE_MODEL") ? [Deno.env.get("GEMINI_IMAGE_MODEL")!] : []),
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
];

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

/**
 * One prompt, heavily constrained.
 *
 * The constraints are doing the real work: without them each exercise comes back
 * in a different style, and a list of 111 mismatched drawings looks worse than
 * no drawings. Flat, two-colour, side-on, no background, no text — so the set
 * reads as one system and stays legible shrunk to a thumbnail.
 */
function promptFor(name: string, muscle: string | null, equipment: string | null): string {
  const worked = muscle
    ? `Highlight the ${muscle} in solid warm orange (#E0362A) — that is the muscle this lift works, and it must be the only coloured element.`
    : `Use no highlight colour; the whole figure is one colour.`;

  const gear = equipment
    ? `Include the ${equipment} clearly — it is what distinguishes this exercise from its variants.`
    : `Include whatever equipment the movement requires.`;

  return [
    `A flat vector line illustration of a single person performing the exercise "${name}".`,
    gear,
    worked,
    "Style: clean 2px uniform-weight line art, light grey (#E8ECF2) strokes, no shading, no gradients, no texture.",
    "Fully transparent background. No floor, no wall, no scenery, no shadow.",
    "Side-on view, whole body in frame, mid-repetition so the movement is recognisable.",
    "The figure is a simple anatomical mannequin: no face, no hair, no clothing detail.",
    "Absolutely no text, no letters, no numbers, no labels, no watermark, no arrows.",
    "Composed to stay readable when shrunk to a 44 pixel square: bold shapes, generous spacing, nothing thin or fussy.",
    "Square image, the figure centred with a small margin.",
  ].join(" ");
}

/** "Bench Press (Barbell)" → "barbell". The bit in brackets is the equipment. */
function equipmentFrom(name: string): string | null {
  const inBrackets = name.match(/\(([^)]+)\)/)?.[1];
  if (inBrackets) return inBrackets.toLowerCase();

  for (const word of ["barbell", "dumbbell", "cable", "machine", "kettlebell", "smith", "band"]) {
    if (name.toLowerCase().includes(word)) return word;
  }
  return null;
}

/** @returns base64 PNG data, or an error to report. */
async function draw(apiKey: string, prompt: string): Promise<{ data: string; mime: string } | { error: string }> {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"], temperature: 0.2 },
  };

  // Every attempt is recorded, not just the last. A fallback's 404 was masking
  // the first model's real error, which is the one worth reading.
  const failures: string[] = [];
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 600));

      let res: Response;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        );
      } catch (e) {
        failures.push(`${model} network: ${(e as Error).message}`);
        continue;
      }

      if (!res.ok) {
        failures.push(`${model} ${res.status}: ${(await res.text()).slice(0, 160)}`);
        if (res.status === 503) continue;      // busy — retry this model
        break;                                  // 429 or 404 — try the next model
      }

      const body = await res.json();
      const parts = body?.candidates?.[0]?.content?.parts ?? [];
      const image = parts.find((p: Record<string, { data?: string; mime_type?: string }>) =>
        p.inlineData ?? p.inline_data);

      const inline = image?.inlineData ?? image?.inline_data;
      if (inline?.data) {
        return { data: inline.data, mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
      }

      failures.push(`${model} returned no image (${body?.candidates?.[0]?.finishReason ?? "no reason given"})`);
    }
  }

  return { error: `Could not draw it. ${failures.join(" | ")}` };
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
  if (!apiKey) return json({ error: "Drawing isn't configured yet (missing GEMINI_API_KEY)." }, 503);

  // Diagnostic: which image-capable models does this key actually have? Model
  // names move between releases and guessing them costs a deploy each time.
  const body = await req.json().catch(() => ({}));
  if (body?.listModels) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`);
    const all = (await res.json())?.models ?? [];
    return json({
      imageCapable: all
        .filter((m: { supportedGenerationMethods?: string[]; name?: string }) =>
          /image/i.test(m.name ?? "") || (m.supportedGenerationMethods ?? []).includes("predict"))
        .map((m: { name: string }) => m.name),
    });
  }

  let id = "";
  let name = "";
  let muscle: string | null = null;
  id = String(body?.id ?? "").trim();
  name = String(body?.name ?? "").trim();
  muscle = body?.muscle ? String(body.muscle).trim() : null;
  if (!id || !name) return json({ error: "An exercise id and name are required." }, 400);

  const prompt = promptFor(name, muscle, equipmentFrom(name));
  const drawn = await draw(apiKey, prompt);
  if ("error" in drawn) return json({ error: drawn.error });

  // Service role for the upload only: the bucket has no write policy, so this is
  // the single path that can put anything in it.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const bytes = Uint8Array.from(atob(drawn.data), (c) => c.charCodeAt(0));
  const path = `${id}.png`;

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: drawn.mime,
    upsert: true,                              // regenerating replaces, never duplicates
  });
  if (uploadError) return json({ error: `Could not store it: ${uploadError.message}` });

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);

  // The URL is returned, not written to the exercise row. The client saves it
  // through the ordinary local-first path so the write syncs like any other.
  return json({ id, name, url: pub.publicUrl, prompt });
});
