// Whether a reminder is due, and what it says, apart from the plumbing so tests
// can import the same source Deno runs (see tests/notify-reminders.test.mjs).
//
// The cron calls every minute and this decides from the reminder's own time and
// days in Denver time, so daylight saving needs no second cron hour any more.

/** Where the reminders' times are. Not a member preference yet — one household. */
export const ZONE = "America/Denver";

/** How late a reminder may still go out, when a minute's call was missed. */
export const CATCH_UP_MIN = 15;

/** A med not marked taken is asked about again this often… */
export const NAG_EVERY_MIN = 30;

/** …this many more times, and then left alone for the day. */
export const MAX_NAGS = 3;

/** A food reminder stays quiet when something was logged this recently. */
export const DEFAULT_QUIET_MIN = 60;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local wall-clock parts, without pulling in a date library. weekday: 0 = Sunday. */
export function localParts(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;   // some engines say 24 for midnight
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minutes: hour * 60 + Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

export interface Reminder {
  kind: "food" | "meds" | "morning" | "evening";
  at_time: string;          // "HH:MM" or "HH:MM:SS"
  days: number[];
  enabled: boolean;
  deleted_at: string | null;
}

/** Today's row in reminder_sends, or null when there isn't one yet. */
export interface Send {
  sends: number;
  last_sent_at: string | null;
  skipped: boolean;
  taken_at: string | null;
}

const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

/**
 * "first" for today's first send, "nag" for a med asked about again, or null.
 *
 * Taken and skipped are both final for the day. A row with no sends and a
 * taken time is a dose marked in the app before the reminder went off.
 */
export function whatIsDue(
  r: Reminder,
  send: Send | null,
  local: { minutes: number; weekday: number },
  now: Date,
): "first" | "nag" | null {
  if (!r.enabled || r.deleted_at) return null;
  if (send?.taken_at || send?.skipped) return null;

  if (!send || send.sends === 0) {
    if (!r.days.includes(local.weekday)) return null;
    const late = local.minutes - minutesOf(r.at_time);
    return late >= 0 && late < CATCH_UP_MIN ? "first" : null;
  }

  if (r.kind !== "meds" || send.sends > MAX_NAGS || !send.last_sent_at) return null;
  const since = (now.getTime() - Date.parse(send.last_sent_at)) / 60_000;
  return since >= NAG_EVERY_MIN ? "nag" : null;
}

/**
 * Whether a food reminder should keep quiet, given when the last eaten entry
 * was logged. null minutes means the default; 0 means always speak.
 */
export function quietForFood(quietMin: number | null, lastLoggedAt: string | null, now: Date): boolean {
  const window = quietMin ?? DEFAULT_QUIET_MIN;
  if (!window || !lastLoggedAt) return false;
  const ago = (now.getTime() - Date.parse(lastLoggedAt)) / 60_000;
  return ago >= 0 && ago <= window;
}

export function foodMessage(label: string): string {
  return label.trim() ? `${label.trim()}: time to log what you ate.` : "Time to log what you ate.";
}

export function medsMessage(label: string, nag: boolean): string {
  const name = label.trim() || "your meds";
  return nag ? `Still need to take ${name}? Tap Taken once you have.` : `Time to take ${name}.`;
}
