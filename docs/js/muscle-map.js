/**
 * muscle-map.js — an anatomical figure with the worked muscle lit up.
 *
 * Not a rendered 3D model. Those are commissioned artwork, and hand-authored SVG
 * cannot reach that quality — so this aims at a clear anatomical diagram instead
 * of a bad imitation of one. It says *which muscle works*; the written
 * instructions beside it say *how to perform the movement*.
 *
 * Front and back are separate figures, because on a single front-facing body the
 * biceps and triceps occupy the same space, which makes the diagram misleading
 * rather than merely vague.
 *
 * Everything is drawn on a 120 × 200 canvas. Only the left side of the body is
 * authored; the right is the same paths mirrored, which halves the geometry and
 * guarantees symmetry.
 */

/** Draw `inner` on both sides of the body's midline (x = 60). */
const both = (inner) =>
  `${inner}<g transform="translate(120,0) scale(-1,1)">${inner}</g>`;

const path = (d, fill, cls = '') =>
  `<path d="${d}" fill="${fill}"${cls ? ` class="${cls}"` : ''}/>`;

/** Striations over a muscle belly, suggesting fibre direction. */
const fibres = (d) =>
  `<path d="${d}" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="1" stroke-linecap="round"/>`;

// ---- the body --------------------------------------------------------------

/** Silhouette. Identical in both views; muscles are drawn over it. */
const BASE = `
  <ellipse cx="60" cy="17" rx="11.5" ry="13" fill="BODY"/>
  <path d="M55,29 h10 v7 h-10 z" fill="BODY"/>
  ${both(`
    <path d="M60,36 C50,36 44,39 42,44 C38,54 37,66 39,78 L42,97 h18 V36 Z" fill="BODY"/>
    <path d="M41,44 C33,45 28,52 28,61 L30,86 C31,90 35,91 37,88 L40,62 Z" fill="BODY"/>
    <path d="M31,88 C29,96 28,108 29,118 C30,122 34,122 36,119 L39,90 Z" fill="BODY"/>
    <path d="M42,97 C40,104 40,110 42,116 L46,152 C47,157 53,157 55,152 L58,116 V97 Z" fill="BODY"/>
    <path d="M47,154 C45,162 45,176 47,188 C48,192 54,192 55,188 C57,176 57,162 56,154 Z" fill="BODY"/>
  `)}
`;

/**
 * Muscles, per view. `d` is the shape, `f` the fibre striations over it.
 * `sided` shapes are mirrored; centred ones (abs, traps, lower back) are not.
 */
const MUSCLES = {
  // ---- front ----
  shoulders: {
    view: 'front', sided: true,
    d: 'M42,42 C33,43 28,50 28,59 C28,63 31,66 35,65 C38,62 40,55 41,47 Z',
    f: 'M31,50 C34,49 37,51 39,54 M30,56 C33,55 36,57 38,60',
  },
  chest: {
    view: 'front', sided: true,
    d: 'M44,44 C50,43 55,44 58,46 L58,62 C52,65 46,63 43,58 C42,53 42,47 44,44 Z',
    f: 'M45,49 C49,48 54,49 57,51 M44,54 C48,53 53,54 57,56 M45,59 C49,58 53,59 57,60',
  },
  biceps: {
    view: 'front', sided: true,
    d: 'M33,50 C29,55 28,66 30,76 C31,80 36,80 37,76 C39,66 38,55 36,50 Z',
    f: 'M31,58 h5 M30,64 h6 M31,70 h5',
  },
  forearms: {
    view: 'front', sided: true,
    d: 'M31,88 C28,96 28,108 30,117 C31,120 35,120 36,117 C38,108 38,96 36,88 Z',
    f: 'M30,96 h5 M30,103 h6 M31,110 h5',
  },
  core: {
    view: 'front', sided: false,
    d: 'M51,64 C56,63 64,63 69,64 L68,94 C64,96 56,96 52,94 Z',
    f: 'M60,64 V95 M52,72 h16 M52,80 h16 M52,88 h16',
  },
  quads: {
    view: 'front', sided: true,
    d: 'M43,99 C40,108 41,124 45,142 C47,148 54,148 56,142 C58,124 57,108 55,99 Z',
    f: 'M49,101 C47,115 47,130 49,143 M53,102 C53,116 53,130 52,142',
  },

  // ---- back ----
  traps: {
    view: 'back', sided: false,
    d: 'M60,36 C52,37 45,41 42,46 C48,52 54,56 60,57 C66,56 72,52 78,46 C75,41 68,37 60,36 Z',
    f: 'M60,37 V56 M50,42 C54,47 57,51 59,55 M70,42 C66,47 63,51 61,55',
  },
  lats: {
    view: 'back', sided: true,
    d: 'M41,50 C38,60 38,74 41,86 L57,92 L57,56 C52,52 46,50 41,50 Z',
    f: 'M43,55 C48,62 53,70 56,80 M41,64 C46,70 51,77 55,85 M41,74 C45,79 49,83 53,88',
  },
  triceps: {
    view: 'back', sided: true,
    d: 'M32,49 C28,55 27,67 30,78 C32,82 36,81 37,77 C39,66 37,55 35,49 Z',
    f: 'M30,57 h6 M29,64 h7 M30,72 h6',
  },
  lowerBack: {
    view: 'back', sided: false,
    d: 'M52,80 C56,79 64,79 68,80 L67,96 C64,98 56,98 53,96 Z',
    f: 'M57,81 V96 M63,81 V96',
  },
  glutes: {
    view: 'back', sided: true,
    d: 'M43,96 C40,101 40,109 43,114 C48,117 55,117 58,113 L58,96 Z',
    f: 'M45,100 C50,101 55,103 57,106 M44,107 C49,108 54,110 57,112',
  },
  hamstrings: {
    view: 'back', sided: true,
    d: 'M43,116 C41,124 42,136 45,148 C47,153 54,153 56,148 C58,136 57,124 55,116 Z',
    f: 'M49,118 C48,130 48,140 49,149 M53,118 C53,130 53,140 52,148',
  },
  calves: {
    view: 'back', sided: true,
    d: 'M46,155 C43,162 43,172 46,180 C48,184 54,184 55,180 C57,172 57,162 55,155 Z',
    f: 'M48,161 C47,168 47,174 48,180 M53,161 C53,168 53,174 52,179',
  },
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

const BODY_FILL = '#57504A';
const MUSCLE_REST = '#6B645B';

function figure(view, litKey) {
  const muscles = Object.entries(MUSCLES)
    .filter(([, m]) => m.view === view)
    .map(([key, m]) => {
      const lit = key === litKey;
      const fill = lit ? COLOUR[key] : MUSCLE_REST;
      // Only the working muscle animates; everything else is context.
      const group = `<g${lit ? ' class="mm-lit"' : ''}>${path(m.d, fill)}${fibres(m.f)}</g>`;
      return m.sided ? both(group) : group;
    })
    .join('');

  return BASE.replaceAll('BODY', BODY_FILL) + muscles;
}

/**
 * @param {object|null} exercise
 * @param {string} name   fallback name when the exercise row is missing
 * @param {object} [opts] { both: render front and back side by side }
 */
export function muscleMap(exercise, name = '', { both: pair = false } = {}) {
  const key = muscleFor(exercise, name);
  const view = key ? MUSCLES[key].view : 'front';
  const label = key ? `Works ${key.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'Muscle map';

  if (!pair) {
    return `<svg viewBox="0 0 120 200" role="img" aria-label="${label}" focusable="false">${
      figure(view, key)
    }</svg>`;
  }

  // The labels are load-bearing: the silhouettes are near-identical, so a lit
  // upper arm means biceps on one figure and triceps on the other.
  const tag = (x, text) =>
    `<text x="${x}" y="212" text-anchor="middle" fill="#8E8478" font-size="12"` +
    ` font-family="ui-monospace, Menlo, monospace" letter-spacing="1.8">${text}</text>`;

  return `<svg viewBox="0 0 250 220" role="img" aria-label="${label}" focusable="false">
    <g>${figure('front', key)}</g>
    <g transform="translate(130,0)">${figure('back', key)}</g>
    ${tag(60, 'FRONT')}${tag(190, 'BACK')}
  </svg>`;
}
