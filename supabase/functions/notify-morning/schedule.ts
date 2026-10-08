// When the morning message goes out, apart from the plumbing so tests can import
// the same source Deno runs (see tests/notify-morning.test.mjs).

/** Where "morning" is. Not a member preference yet — there is one household. */
export const ZONE = "America/Denver";

/** The hour that counts as morning, local. */
export const SEND_HOUR = 6;

/** Local weekdays with no morning message, for everyone. Sunday is a day off. */
export const QUIET_DAYS = ["Sunday"];

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

/**
 * Why this cron call should not send, or null when it should.
 *
 * The quiet-day check comes after the hour check so the off-hour call of the
 * DST pair still reports "not the hour", the same as every other day.
 */
export function skipReason(
  local: { date: string; hour: number; weekday: string },
  sentOn: string | undefined,
): string | null {
  if (local.hour !== SEND_HOUR) return "not the hour";
  if (QUIET_DAYS.includes(local.weekday)) return "quiet day";
  if (sentOn === local.date) return "already sent";
  return null;
}
