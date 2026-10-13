// Whether tonight's day deserves a nudge, as a pure function so the test can
// try every case without a database (see tests/notify-evening.test.mjs).

/**
 * The fraction of the calorie target below which a day at 8:30pm looks
 * unfinished rather than just light. Dinner is 30–40% of most days, so a day
 * sitting under 60% this late is almost certainly missing a meal, while a
 * deliberate low day on a cut still clears it.
 */
export const UNFINISHED_BELOW = 0.6;

export interface DayState {
  /** Eaten calories logged for the local day — planned entries don't count. */
  calories: number;
  /** How many eaten entries the day has. */
  entryCount: number;
  /** The current goal's calorie target, or null when there isn't one. */
  target: number | null;
  /** Whether the day already has a mark, complete or not — answered is answered. */
  reviewed: boolean;
}

/**
 * The nudge for this day, or null to stay quiet.
 *
 * Quiet is the default and the point: a reminder that fires on finished days
 * gets swiped away on the unfinished ones too. It speaks only when the day is
 * empty, or clearly short of a target. With no target set, an empty day is the
 * only thing it can honestly call unfinished.
 */
export function nudge(day: DayState): string | null {
  if (day.reviewed) return null;

  if (day.entryCount === 0) {
    return "Nothing logged today. Two minutes now beats guessing tomorrow.";
  }

  if (day.target && day.calories < day.target * UNFINISHED_BELOW) {
    return `Only ${Math.round(day.calories)} kcal logged today — finish the day?`;
  }

  return null;
}
