// The Gemini call, apart from the request handling so tests can drive it with
// a fake fetch (see tests/read-food-photo.test.mjs).

/** One model's turn, before it counts as stuck and the next model gets a go. */
export const ATTEMPT_MS = 40_000;

/**
 * All attempts together. The platform kills the function at 150 seconds and
 * answers with a bare 504, which reached the app as "Edge Function returned a
 * non-2xx status code". Stopping short of that leaves time to say what happened.
 */
export const BUDGET_MS = 110_000;

export const FALLBACK_MODELS = [
  "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-3.5-flash", "gemini-3.5-flash-lite",
];

type Image = { imageBase64: string; mimeType: string };
type Answer = { text: string } | { error: string; status: number };

/**
 * Ask Gemini, falling through models when the free tier is busy.
 *
 * Lifted from import-photo, which learned this the hard way: shared flash
 * capacity is deprioritised under load and 503s, so one model is not enough.
 * Nor is waiting on one indefinitely: a pasted label once hung until the
 * platform's limit with nothing logged, so each attempt has a deadline and a
 * stuck model is treated like a busy one.
 */
export async function askGemini(
  apiKey: string,
  prompt: string,
  images: Image[],
  {
    schema = null,
    model = "gemini-flash-latest",
    fetch: send = fetch,
    attemptMs = ATTEMPT_MS,
    budgetMs = BUDGET_MS,
    now = Date.now,
  }: {
    schema?: object | null;
    model?: string;
    fetch?: typeof fetch;
    attemptMs?: number;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<Answer> {
  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        ...images.map((i) => ({ inline_data: { mime_type: i.mimeType, data: i.imageBase64 } })),
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      ...(schema ? { responseSchema: schema } : {}),
    },
  };

  const models = [...new Set([model, ...FALLBACK_MODELS])];
  const deadline = now() + budgetMs;

  let resp: Response | null = null;
  let lastStatus = 0;
  let lastDetail = "";
  let timedOut = false;

  for (const m of models) {
    let hardError = false;
    for (let attempt = 0; attempt < 2 && !resp; attempt++) {
      const left = deadline - now();
      if (left <= 0) break;
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));

      let r: Response;
      try {
        r = await send(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(Math.min(attemptMs, left)),
          },
        );
      } catch (e) {
        if ((e as Error)?.name === "TimeoutError") {
          // Stuck, not broken: the next model, not this one again.
          timedOut = true;
          lastStatus = 504;
          lastDetail = "timed out";
          break;
        }
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
    if (resp || hardError || deadline - now() <= 0) break;
  }

  if (!resp) {
    console.error("Gemini HTTP", lastStatus, lastDetail);
    return {
      error: timedOut || lastStatus === 503
        ? "The reader is slow right now — try again in a moment."
        : `Reader error (${lastStatus}): ${lastDetail}`,
      status: lastStatus,
    };
  }

  // The deadline covers the body too, so a reply that stalls halfway is the
  // same slow reader, not a crash.
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    console.error("Gemini body", String(e));
    return { error: "The reader is slow right now — try again in a moment.", status: 504 };
  }
  const out = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!out) {
    const reason = data?.promptFeedback?.blockReason
      ?? data?.candidates?.[0]?.finishReason
      ?? "empty response";
    return { error: `The reader returned nothing (${reason}).`, status: 502 };
  }
  return { text: out };
}
