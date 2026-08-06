/**
 * muscle-map.js — a drawn figure with the worked muscle lit up.
 *
 * Replaces photographed demonstrations. It shows *what an exercise works*, not
 * *how to perform it* — the written instructions do that job. In exchange it is
 * consistent across every exercise, needs no network, has no licence attached,
 * and looks like the app rather than stock imagery.
 *
 * Front and back are separate figures. That is the whole reason this exists in
 * two views: on a single front-facing body, biceps and triceps occupy the same
 * rectangle, which makes the diagram actively misleading.
 */

// ---- geometry helpers ------------------------------------------------------

const box = (x, y, w, h, r = 5) => ({ x, y, w, h, r });

const rectSvg = ({ x, y, w, h, r }, fill, cls = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${cls ? ` class="${cls}"` : ''}/>`;

/**
 * Striations across a muscle, suggesting fibre direction.
 * `across` draws them perpendicular to the long axis, which is how muscle
 * bellies actually read at a glance.
 */
function fibreSvg({ x, y, w, h }, count = 4, across = true) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    if (across) {
      const yy = y + h * t;
      lines.push(`<line x1="${x + w * 0.16}" y1="${yy}" x2="${x + w * 0.84}" y2="${yy}"/>`);
    } else {
      const xx = x + w * t;
      lines.push(`<line x1="${xx}" y1="${y + h * 0.16}" x2="${xx}" y2="${y + h * 0.84}"/>`);
    }
  }
  return `<g stroke="rgba(0,0,0,.32)" stroke-width=".9" stroke-linecap="round">${lines.join('')}</g>`;
}

// ---- the body --------------------------------------------------------------

/** Silhouette, identical in both views. Muscles are drawn on top of it. */
const BASE = [
  box(47, 7, 26, 26, 12),        // head
  box(54, 30, 12, 9, 4),         // neck
  box(40, 40, 40, 58, 12),       // torso
  box(24, 46, 15, 40, 7),        // upper arm L
  box(81, 46, 15, 40, 7),        // upper arm R
  box(22, 86, 14, 34, 7),        // forearm L
  box(84, 86, 14, 34, 7),        // forearm R
  box(43, 96, 34, 18, 8),        // hips
  box(44, 112, 15, 44, 7),       // thigh L
  box(61, 112, 15, 44, 7),       // thigh R
  box(45, 156, 13, 36, 6),       // shin L
  box(62, 156, 13, 36, 6),       // shin R
];

/**
 * Muscles, per view. Each is a set of boxes plus the fibre direction.
 * `across: false` means the fibres run vertically — quads, lats, hamstrings.
 */
const MUSCLES = {
  // ---- front ----
  chest:     { view: 'front', boxes: [box(42, 44, 17, 20, 7), box(61, 44, 17, 20, 7)], across: true },
  shoulders: { view: 'front', boxes: [box(26, 43, 15, 16, 7), box(79, 43, 15, 16, 7)], across: true },
  biceps:    { view: 'front', boxes: [box(26, 55, 12, 26, 6), box(82, 55, 12, 26, 6)], across: true },
  forearms:  { view: 'front', boxes: [box(23, 88, 12, 28, 6), box(85, 88, 12, 28, 6)], across: true },
  core:      { view: 'front', boxes: [box(48, 66, 24, 30, 6)], across: true },
  quads:     { view: 'front', boxes: [box(45, 114, 13, 38, 6), box(62, 114, 13, 38, 6)], across: false },

  // ---- back ----
  traps:      { view: 'back', boxes: [box(45, 38, 30, 18, 8)], across: true },
  lats:       { view: 'back', boxes: [box(41, 54, 17, 32, 7), box(62, 54, 17, 32, 7)], across: false },
  triceps:    { view: 'back', boxes: [box(26, 55, 12, 26, 6), box(82, 55, 12, 26, 6)], across: true },
  lowerBack:  { view: 'back', boxes: [box(48, 84, 24, 14, 6)], across: true },
  glutes:     { view: 'back', boxes: [box(44, 97, 16, 17, 7), box(60, 97, 16, 17, 7)], across: true },
  hamstrings: { view: 'back', boxes: [box(45, 114, 13, 38, 6), box(62, 114, 13, 38, 6)], across: false },
  calves:     { view: 'back', boxes: [box(46, 156, 12, 32, 6), box(63, 156, 12, 32, 6)], across: true },
};

/** Colour by movement family, using the plate palette. */
const COLOUR = {
  chest: '#E0362A', shoulders: '#E0362A', traps: '#E0362A',
  biceps: '#2D68C4', triceps: '#2D68C4', forearms: '#2D68C4',
  lats: '#2D68C4', lowerBack: '#2D68C4',
  core: '#F2C230',
  quads: '#2FA84F', hamstrings: '#2FA84F', glutes: '#2FA84F', calves: '#2FA84F',
};

// ---- naming ----------------------------------------------------------------

/** Free Exercise DB vocabulary and Hevy's names both land here. */
const FROM_MUSCLE = [
  [/chest|pectoral/, 'chest'],
  [/trap/, 'traps'],
  [/shoulder|delt/, 'shoulders'],
  [/bicep/, 'biceps'],
  [/tricep/, 'triceps'],
  [/forearm|grip|wrist/, 'forearms'],
  [/lat(?!eral)|middle back|rhomboid/, 'lats'],
  [/lower back|spine|erector/, 'lowerBack'],
  [/glute/, 'glutes'],
  [/hamstring/, 'hamstrings'],
  [/quad|adductor|abductor/, 'quads'],
  [/calf|calves/, 'calves'],
  [/core|abdominal|abs|oblique/, 'core'],
  [/back/, 'lats'],
];

/** Fallback when an exercise carries no muscle: read the movement's name. */
const FROM_NAME = [
  [/tricep|pushdown|skullcrusher|dip|close-?grip/, 'triceps'],
  [/curl(?!.*leg)|chin-?up/, 'biceps'],
  [/wrist|forearm/, 'forearms'],
  [/bench|chest|fly|push-?up/, 'chest'],
  [/shrug/, 'traps'],
  [/lateral raise|rear delt|face pull|overhead press|shoulder press|arnold/, 'shoulders'],
  [/row|pulldown|pull-?up|lat /, 'lats'],
  [/deadlift|back extension|hyperextension|good morning/, 'lowerBack'],
  [/hip thrust|glute/, 'glutes'],
  [/leg curl|rdl|romanian/, 'hamstrings'],
  [/squat|lunge|leg press|leg extension|split|step-?up/, 'quads'],
  [/calf/, 'calves'],
  [/plank|crunch|\bab\b|abs|russian twist|leg raise|rollout|sit-?up/, 'core'],
  [/press/, 'shoulders'],
];

export function muscleFor(exercise, name = '') {
  const muscle = (exercise?.primary_muscle ?? '').toLowerCase();
  for (const [pattern, key] of FROM_MUSCLE) if (pattern.test(muscle)) return key;

  const label = `${exercise?.name ?? ''} ${name}`.toLowerCase();
  for (const [pattern, key] of FROM_NAME) if (pattern.test(label)) return key;
  return null;
}

// ---- rendering -------------------------------------------------------------

const BODY_FILL = '#5C554D';
const MUSCLE_REST = '#6E675E';

function figure(view, litKey) {
  const base = BASE.map((b) => rectSvg(b, BODY_FILL)).join('');

  const muscles = Object.entries(MUSCLES)
    .filter(([, m]) => m.view === view)
    .map(([key, m]) => {
      const lit = key === litKey;
      const fill = lit ? COLOUR[key] : MUSCLE_REST;
      // Only the working muscle animates; the rest are context.
      const cls = lit ? 'mm-lit' : '';
      return m.boxes
        .map((b) => `<g${cls ? ` class="${cls}"` : ''}>${rectSvg(b, fill)}${fibreSvg(b, 4, m.across)}</g>`)
        .join('');
    })
    .join('');

  return base + muscles;
}

/**
 * @param {object|null} exercise
 * @param {string} name   fallback name when the exercise row is missing
 * @param {object} [opts] { both: render front and back side by side }
 */
export function muscleMap(exercise, name = '', { both = false } = {}) {
  const key = muscleFor(exercise, name);
  const view = key ? MUSCLES[key].view : 'front';
  const label = key ? `Works ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'Muscle map';

  if (!both) {
    return `<svg viewBox="0 0 120 200" role="img" aria-label="${label}" focusable="false">${
      figure(view, key)
    }</svg>`;
  }

  // Both views together. The labels are the point: the two silhouettes are
  // otherwise near-identical, which is exactly the confusion this is meant to
  // remove — a lit upper arm means biceps on one and triceps on the other.
  const tag = (x, text) =>
    `<text x="${x}" y="212" text-anchor="middle" fill="#8E8478" font-size="13"` +
    ` font-family="ui-monospace, Menlo, monospace" letter-spacing="1.6">${text}</text>`;

  return `<svg viewBox="0 0 250 220" role="img" aria-label="${label}" focusable="false">
    <g>${figure('front', key)}</g>
    <g transform="translate(130,0)">${figure('back', key)}</g>
    ${tag(60, 'FRONT')}${tag(190, 'BACK')}
  </svg>`;
}
