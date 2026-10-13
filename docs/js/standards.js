/**
 * standards.js — how a lift compares with other lifters of the same sex, for
 * your body weight.
 *
 * Approximate, and the UI says so. There is no open dataset of lifts by body
 * weight; the best ones (Strength Level's) are crowd-sourced and not licensed
 * for reuse. These are the body-weight multiples commonly published for each
 * level, and a level here means roughly what those tables mean by it:
 *
 *   beginner     stronger than ~5% of lifters
 *   novice       ~20%
 *   intermediate ~50%
 *   advanced     ~80%
 *   elite        ~95%
 *
 * Multiples flatter light lifters a little and undersell heavy ones — real
 * standards curve with body weight — which is one more reason the percentile is
 * shown as "about".
 *
 * Free-weight lifts only. A machine's numbers depend on the machine — its
 * leverage, its cams, its stack — so one person's 200 lb leg press is not
 * another's, and a percentile for it would be invented. Those stay unrated.
 */

export const LEVELS = ['Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite'];
const LEVEL_PCT = [5, 20, 50, 80, 95];

/** Estimated 1RM ÷ body weight at each level, per lift, per sex. */
export const STANDARDS = {
  squat: {
    label: 'Squat',
    male: [0.75, 1.25, 1.5, 2.25, 2.75],
    female: [0.5, 0.75, 1.25, 1.5, 2.0],
  },
  bench: {
    label: 'Bench press',
    male: [0.5, 0.75, 1.0, 1.5, 2.0],
    female: [0.25, 0.5, 0.75, 1.0, 1.5],
  },
  deadlift: {
    label: 'Deadlift',
    male: [1.0, 1.5, 2.0, 2.5, 3.0],
    female: [0.5, 1.0, 1.25, 1.75, 2.5],
  },
  press: {
    label: 'Overhead press',
    male: [0.35, 0.55, 0.8, 1.05, 1.35],
    female: [0.2, 0.35, 0.5, 0.75, 1.0],
  },
  row: {
    label: 'Barbell row',
    male: [0.5, 0.75, 1.0, 1.5, 1.75],
    female: [0.25, 0.4, 0.65, 0.9, 1.2],
  },
};

// Names as logged, matched whole: "Squat (Barbell)" is the squat, "Hack Squat
// (Machine)" and "Front Squat" are not; "Deadlift" is, "Romanian Deadlift" is not.
const NAMES = [
  ['squat', /^(back |barbell )?squat( \(barbell\))?$/],
  ['bench', /^(flat )?bench press( \(barbell\))?$/],
  ['deadlift', /^(conventional )?deadlift( \(barbell\))?$/],
  ['press', /^(standing )?(overhead|military) press( \(barbell\))?$/],
  ['row', /^(bent over row|barbell row|bent over barbell row)( \(barbell\))?$/],
];

/** Which standard a logged exercise is measured against, or null if none. */
export function liftKey(name) {
  const n = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (const [key, pattern] of NAMES) if (pattern.test(n)) return key;
  return null;
}

/**
 * Where a ratio sits: the level reached, an approximate percentile, and the
 * next level with the ratio it needs.
 *
 * The percentile is a straight line between the levels' anchors — a reading of
 * the table, not a measurement — clamped to 1-99 so nobody is "0%" or "100%".
 */
export function rate(key, sex, ratio) {
  const table = STANDARDS[key]?.[sex];
  if (!table || !(ratio > 0)) return null;

  let reached = -1;
  for (let i = 0; i < table.length; i++) if (ratio >= table[i]) reached = i;

  let pct;
  if (reached < 0) {
    pct = LEVEL_PCT[0] * (ratio / table[0]);
  } else if (reached === table.length - 1) {
    const over = (ratio - table[reached]) / (table[reached] * 0.25);
    pct = LEVEL_PCT[reached] + 4 * Math.min(1, over);
  } else {
    const span = (ratio - table[reached]) / (table[reached + 1] - table[reached]);
    pct = LEVEL_PCT[reached] + span * (LEVEL_PCT[reached + 1] - LEVEL_PCT[reached]);
  }

  const nextIndex = reached + 1;
  return {
    level: reached < 0 ? 'Below beginner' : LEVELS[reached],
    percentile: Math.max(1, Math.min(99, Math.round(pct))),
    next: nextIndex < table.length ? { level: LEVELS[nextIndex], ratio: table[nextIndex] } : null,
  };
}

const KG = 0.45359237;

// The published DOTS coefficients, body weight in kg.
const DOTS = {
  male: [-0.000001093, 0.0007391293, -0.1918759221, 24.0900756, -307.75076],
  female: [-0.0000010706, 0.0005158568, -0.1126655495, 13.6175032, -57.96288],
};

/**
 * DOTS: a squat + bench + deadlift total, scaled for body weight so lifters of
 * different sizes compare on one number. What powerlifting meets rank by. For
 * scale: ~300 is a solid gym lifter, ~400 is strong, ~500 is national level.
 * Body weight is clamped to the formula's fitted range, as the federations do.
 */
export function dots(totalLb, bodyWeightLb, sex) {
  const c = DOTS[sex];
  if (!c || !(totalLb > 0) || !(bodyWeightLb > 0)) return null;
  const limits = sex === 'male' ? [40, 210] : [40, 150];
  const bw = Math.min(limits[1], Math.max(limits[0], bodyWeightLb * KG));
  const denominator = c[0] * bw ** 4 + c[1] * bw ** 3 + c[2] * bw ** 2 + c[3] * bw + c[4];
  return Math.round((totalLb * KG * 500) / denominator);
}
