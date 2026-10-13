// When the evening nudge goes out, apart from the plumbing so tests can import
// the same source Deno runs (see tests/notify-evening.test.mjs).
//
// A copy of notify-morning's schedule with its own hour and no quiet days:
// Sunday skips the motivation quote, but Sunday's dinner still counts.

/** Where "evening" is. Not a member preference yet — there is one household. */
export const ZONE = "America/Denver";

/** The hour that counts as evening, local. The cron fires at half past. */
export const SEND_HOUR = 20;

/** Local wall-clock parts, without pulling in a date library. */
export function localParts(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "long",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    weekday: get("weekday"),
  };
}

/** Why this cron call should not send, or null when it should. */
export function skipReason(
  local: { date: string; hour: number; weekday: string },
  sentOn: string | undefined,
): string | null {
  if (local.hour !== SEND_HOUR) return "not the hour";
  if (sentOn === local.date) return "already sent";
  return null;
}
