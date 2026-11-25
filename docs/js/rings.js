/**
 * rings.js — the calorie and macro rings, as SVG markup.
 *
 * Four concentric rings, outside in: calories, protein, carbs, fat. A ring past
 * its target keeps going round a second lap in the same colour; where that lap
 * ends it casts a shadow on the first, and a thin tick at the top marks where
 * 100% was, so "just over" and "nearly double" read differently at a glance.
 * Chosen on 2026-11-24 after a round of mockups (the "Y4" board): a lighter or
 * thinner second lap read as a different ring.
 *
 * Markup is built here rather than in index.html: Alpine's x-for does not work
 * inside <svg>, and a pure function is something the tests can hold steady.
 * Everything interpolated is a number this module computed, never user text.
 */

export const KEYS = ['cal', 'p', 'c', 'f'];

/** Ring sizes: the big one on the day card, the small ones in the week strip. */
export const SIZES = {
  big:  { size: 176, width: 15, gap: 3 },
  mini: { size: 44,  width: 4,  gap: 0.5 },
};

const fixed = (n) => Number(n.toFixed(2));

/**
 * One ring's geometry. `value / target` is how far round it goes; a missing or
 * zero target draws an empty track rather than pretending to a percentage.
 * The second lap stops at a full circle: past 200% the ring is simply full twice.
 */
export function arc({ value, target, r, width, centre }) {
  const C = 2 * Math.PI * r;
  const frac = target > 0 ? Math.max(0, Number(value) || 0) / target : 0;
  const first = Math.min(1, frac) * C;
  const second = Math.min(1, Math.max(0, frac - 1)) * C;
  const angle = second / r;
  const ahead = angle + (width * 0.45) / r;
  return {
    frac,
    over: second > 0,
    circumference: fixed(C),
    first: fixed(first),
    second: fixed(second),
    cap: { x: fixed(centre + r * Math.cos(angle)), y: fixed(centre + r * Math.sin(angle)) },
    shadow: { x: fixed(centre + r * Math.cos(ahead)), y: fixed(centre + r * Math.sin(ahead)) },
    tick: { x1: fixed(centre + r - width / 2 - 1), x2: fixed(centre + r + width / 2 + 1) },
  };
}

/**
 * The four rings' values from a day's totals and targets (food.dayAgainstGoal's
 * shape), and optionally what is planned but not yet eaten.
 */
export function fromTotals(totals, targets, planned = null) {
  const ring = (key) => ({ value: totals?.[key], target: targets?.[key], plan: planned?.[key] ?? 0 });
  return { cal: ring('calories'), p: ring('protein_g'), c: ring('carbs_g'), f: ring('fat_g') };
}

/**
 * Where the plan sits on a ring: faded segments from the end of what was eaten
 * to where it would be if the plan were eaten too, on whichever laps that
 * crosses. Each is [start, length] along the circle, as the dash pattern wants.
 */
export function planSegments({ value, plan, target, r }) {
  if (!(target > 0) || !(Number(plan) > 0)) return [];
  const C = 2 * Math.PI * r;
  const eaten = Math.max(0, Number(value) || 0) / target;
  const total = Math.min(2, eaten + Number(plan) / target);
  const out = [];
  for (const lap of [0, 1]) {
    const from = Math.min(1, Math.max(0, eaten - lap));
    const to = Math.min(1, Math.max(0, total - lap));
    if (to > from) out.push([fixed(from * C), fixed((to - from) * C)]);
  }
  return out;
}

/**
 * The small mark under a day in the strip, by food.dayStatus: a filled check
 * for complete, a struck circle for incomplete, a dot for logged-but-unmarked,
 * an accent dot for today, and nothing for an empty or future day.
 */
const MARKS = {
  complete: '<svg class="mark mark-complete" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7"/><path d="M4 7.2l2 2 4-4.4"/></svg>',
  incomplete: '<svg class="mark mark-incomplete" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6"/><path d="M5 5l4 4M9 5l-4 4"/></svg>',
  unreviewed: '<svg class="mark mark-unreviewed" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="2.5"/></svg>',
  today: '<svg class="mark mark-today" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="3"/></svg>',
};

export function markIcon(status) { return MARKS[status] ?? ''; }

/** The radius of ring `i` (0 = outermost) for a size. */
export function radius(i, { size, width, gap }) {
  return size / 2 - width / 2 - 1 - i * (width + gap);
}

/**
 * The four rings as an <svg> string.
 * `values` maps each key to { value, target }; a missing key draws a track only.
 */
export function svg(values, { kind = 'big', label = '' } = {}) {
  const dims = SIZES[kind];
  const { size, width } = dims;
  const c = size / 2;
  const parts = [];

  KEYS.forEach((key, i) => {
    const r = fixed(radius(i, dims));
    const v = values?.[key] ?? {};
    const a = arc({ value: v.value, target: v.target, r, width, centre: c });
    const ring = `ring-${key}`;
    parts.push(`<circle class="ring-track ${ring}" cx="${c}" cy="${c}" r="${r}" stroke-width="${width}"/>`);
    if (a.first > 0) {
      parts.push(`<circle class="ring-arc ${ring}" cx="${c}" cy="${c}" r="${r}" stroke-width="${width}" stroke-dasharray="${a.first} ${a.circumference}"/>`);
    }
    for (const [start, length] of planSegments({ value: v.value, plan: v.plan, target: v.target, r })) {
      parts.push(`<circle class="ring-plan ${ring}" cx="${c}" cy="${c}" r="${r}" stroke-width="${width}" stroke-dasharray="0 ${start} ${length} ${a.circumference}"/>`);
    }
    if (a.over) {
      const tick = Math.max(1, width / 6);
      parts.push(
        `<circle class="ring-arc ${ring}" cx="${c}" cy="${c}" r="${r}" stroke-width="${width}" stroke-dasharray="${a.second} ${a.circumference}"/>`,
        `<circle class="ring-shadow" cx="${a.shadow.x}" cy="${a.shadow.y}" r="${fixed(width * 0.56)}"/>`,
        `<circle class="ring-cap ${ring}" cx="${a.cap.x}" cy="${a.cap.y}" r="${fixed(width / 2)}"/>`,
        `<line class="ring-tick" x1="${a.tick.x1}" y1="${c}" x2="${a.tick.x2}" y2="${c}" stroke-width="${fixed(tick)}"/>`,
      );
    }
  });

  const role = label ? `role="img" aria-label="${label.replace(/[<>&"]/g, '')}"` : 'aria-hidden="true"';
  return `<svg class="rings rings-${kind}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" ${role}>`
    + `<g transform="rotate(-90 ${c} ${c})" fill="none" stroke-linecap="round">${parts.join('')}</g></svg>`;
}
