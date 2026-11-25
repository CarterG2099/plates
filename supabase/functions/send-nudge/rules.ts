// What send-nudge allows, apart from the plumbing so tests can import the same
// source Deno runs (see tests/send-nudge.test.mjs).

/** A nudge waits this long after the last one to the same person: a nudge, not nagging. */
export const NUDGE_EVERY_MIN = 60;

/** Cheers are lighter, but five in a row is still noise. */
export const CHEER_EVERY_MIN = 5;

export const MAX_LENGTH = 120;

export type Kind = "nudge" | "cheer";

/**
 * Why a nudge cannot go, in words for the person sending it, or null when it can.
 * `lastAt` is when this sender last sent this kind to this person.
 */
export function refusal(
  ask: { kind: unknown; body: unknown; from: string; to: unknown },
  lastAt: string | null,
  now: Date,
): string | null {
  if (ask.kind !== "nudge" && ask.kind !== "cheer") return "Unknown kind.";
  const body = typeof ask.body === "string" ? ask.body.trim() : "";
  if (!body) return "Say something.";
  if (body.length > MAX_LENGTH) return `Keep it under ${MAX_LENGTH} characters.`;
  if (typeof ask.to !== "string" || !ask.to.trim()) return "Who to?";
  if (ask.to.trim().toLowerCase() === ask.from.toLowerCase()) return "That's you.";

  if (lastAt) {
    const every = ask.kind === "nudge" ? NUDGE_EVERY_MIN : CHEER_EVERY_MIN;
    const wait = every - (now.getTime() - Date.parse(lastAt)) / 60_000;
    if (wait > 0) {
      const mins = Math.ceil(wait);
      return ask.kind === "nudge"
        ? `One nudge an hour. Next in ${mins} min.`
        : `Just cheered. Again in ${mins} min.`;
    }
  }
  return null;
}

/** The notification's title: who, and what. The words are the sender's. */
export function titleOf(kind: Kind, name: string): string {
  const who = name.trim() || "Someone";
  return kind === "nudge" ? `${who} nudged you` : `${who} cheered you on`;
}
