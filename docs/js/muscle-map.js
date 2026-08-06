/**
 * muscle-map.js — a drawn figure with the worked muscle lit up.
 *
 * Replaces photographed demonstrations. The trade-off is deliberate: this tells
 * you *what an exercise works*, not *how to perform it*. In exchange it is
 * consistent across every exercise, needs no network, has no licence attached,
 * and matches the app rather than looking like a stock photo dropped into it.
 *
 * Inline SVG built from simple geometry — no anatomy illustration, because a bad
 * anatomical drawing reads worse than an honest diagram.
 */

/** Regions of the figure that can be lit. */
const REGIONS = {
  shoulders: ['deltL', 'deltR'],
  chest:     ['chest'],
  armsUpper: ['armUpperL', 'armUpperR'],
  armsLower: ['armLowerL', 'armLowerR'],
  torso:     ['chest', 'core'],
  core:      ['core'],
  glutes:    ['hips'],
  legsUpper: ['thighL', 'thighR'],
  calves:    ['calfL', 'calfR'],
};

/**
 * Muscle name to region. Covers Free Exercise DB's vocabulary and the names
 * Hevy uses, since exercises arrive from both.
 */
const MUSCLE_REGIONS = [
  [/chest|pectoral/,                      'chest'],
  [/shoulder|delt|trap/,                  'shoulders'],
  [/bicep|tricep|arm(?!s? ?lower)/,       'armsUpper'],
  [/forearm|grip|wrist/,                  'armsLower'],
  [/lat|back|rhomboid|spine/,             'torso'],
  [/core|abdominal|abs|oblique/,          'core'],
  [/glute/,                               'glutes'],
  [/quad|hamstring|adductor|abductor|leg/, 'legsUpper'],
  [/calf|calves/,                         'calves'],
];

/** Fallback when an exercise has no muscle recorded: read it from the name. */
const NAME_REGIONS = [
  [/curl(?!.*leg)|tricep|pushdown|skullcrusher|dip|extension.*arm/, 'armsUpper'],
  [/bench|chest|fly|push-?up|press.*(chest|incline|decline)/,       'chest'],
  [/shoulder|overhead press|lateral raise|rear delt|shrug|face pull/, 'shoulders'],
  [/row|pulldown|pull-?up|chin-?up|lat |deadlift|back extension/,    'torso'],
  [/squat|lunge|leg press|leg extension|leg curl|hip thrust|split/,  'legsUpper'],
  [/calf/,                                                          'calves'],
  [/plank|crunch|ab |abs|russian twist|leg raise|rollout/,           'core'],
  [/press/,                                                         'shoulders'],
];

/** Colour by movement family, using the plate palette. */
const REGION_COLOUR = {
  chest:     '#E0362A',
  shoulders: '#E0362A',
  armsUpper: '#2D68C4',
  armsLower: '#2D68C4',
  torso:     '#2D68C4',
  core:      '#F2C230',
  glutes:    '#2FA84F',
  legsUpper: '#2FA84F',
  calves:    '#2FA84F',
};

export function regionFor(exercise, name = '') {
  const muscle = (exercise?.primary_muscle ?? '').toLowerCase();
  for (const [pattern, region] of MUSCLE_REGIONS) {
    if (pattern.test(muscle)) return region;
  }

  const label = `${exercise?.name ?? ''} ${name}`.toLowerCase();
  for (const [pattern, region] of NAME_REGIONS) {
    if (pattern.test(label)) return region;
  }
  return null;
}

/** The figure, as a list of named shapes on a 120 × 200 canvas. */
const SHAPES = [
  ['head',      '<circle cx="60" cy="20" r="13"/>'],
  ['neck',      '<rect x="54" y="31" width="12" height="8" rx="3"/>'],
  ['deltL',     '<ellipse cx="37" cy="50" rx="11" ry="9"/>'],
  ['deltR',     '<ellipse cx="83" cy="50" rx="11" ry="9"/>'],
  ['chest',     '<rect x="42" y="42" width="36" height="25" rx="9"/>'],
  ['core',      '<rect x="46" y="68" width="28" height="30" rx="7"/>'],
  ['armUpperL', '<rect x="24" y="56" width="15" height="34" rx="7"/>'],
  ['armUpperR', '<rect x="81" y="56" width="15" height="34" rx="7"/>'],
  ['armLowerL', '<rect x="21" y="90" width="14" height="32" rx="7"/>'],
  ['armLowerR', '<rect x="85" y="90" width="14" height="32" rx="7"/>'],
  ['hips',      '<rect x="44" y="97" width="32" height="16" rx="7"/>'],
  ['thighL',    '<rect x="44" y="111" width="15" height="42" rx="7"/>'],
  ['thighR',    '<rect x="61" y="111" width="15" height="42" rx="7"/>'],
  ['calfL',     '<rect x="45" y="153" width="13" height="36" rx="6"/>'],
  ['calfR',     '<rect x="62" y="153" width="13" height="36" rx="6"/>'],
];

/**
 * @param {object|null} exercise
 * @param {string} name  fallback name when the exercise row is missing
 * @returns {string} inline SVG
 */
export function muscleMap(exercise, name = '') {
  const region = regionFor(exercise, name);
  const lit = new Set(region ? REGIONS[region] : []);
  const colour = REGION_COLOUR[region] ?? 'var(--color-text-dim)';

  const body = SHAPES.map(([id, shape]) => {
    const on = lit.has(id);
    // The unlit body has to read as a body, not as a smudge — it's the thing
    // that gives the highlight somewhere to be.
    const fill = on ? colour : '#5C554D';
    return shape.replace('/>', ` fill="${fill}"/>`);
  }).join('');

  return `<svg viewBox="0 0 120 200" role="img" aria-label="${
    region ? `Works ${region.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'Muscle map'
  }" focusable="false">${body}</svg>`;
}
