import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const css = async (name) =>
  readFile(fileURLToPath(new URL(`../docs/css/${name}`, import.meta.url)), 'utf8');

const [tokens, base, pages, components] = await Promise.all(
  ['tokens.css', 'base.css', 'pages.css', 'components.css'].map(css));

/**
 * The --text-* scale in px, assuming the 16px root the app never overrides.
 *
 * Needed because the sizes are declared in rem and the thing that matters here
 * is an absolute pixel threshold, not a relative one.
 */
function typeScale(source) {
  const scale = {};
  for (const m of source.matchAll(/--text-([a-z0-9]+):\s*([\d.]+)rem/g)) {
    scale[m[1]] = Number(m[2]) * 16;
  }
  return scale;
}

/**
 * Rules that give a typed-in field a font smaller than 16px.
 *
 * iOS Safari zooms the whole page in when a focused field's text is under 16px
 * and never zooms back out, so the app ends up slightly enlarged and pannable
 * with an edge clipped. It is silent on every other platform, which is what
 * makes it worth a test: nothing in a desktop browser will ever show it.
 *
 * Checkboxes and file inputs are exempt — they display no text to zoom toward.
 */
function smallFieldRules(source, scale, label) {
  const found = [];
  // Comments go first. Without this the text before a rule is swept into its
  // selector, and .prev-cell — a div, sitting under a comment containing the
  // word "input" — was reported as a 12px text field.
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');

  // Selector plus body, for rules whose selector mentions an input-ish control.
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (!/\b(input|select|textarea)\b/.test(selector)) continue;
    if (/type="(checkbox|radio|file)"/.test(selector)) continue;

    const size = body.match(/font-size:\s*([^;]+)/);
    if (!size) continue;

    const value = size[1].trim();
    let px = null;
    const token = value.match(/var\(--text-([a-z0-9]+)\)/);
    if (token) px = scale[token[1]] ?? null;
    else if (/^([\d.]+)px$/.test(value)) px = Number(value.match(/^([\d.]+)px$/)[1]);
    else if (/^([\d.]+)rem$/.test(value)) px = Number(value.match(/^([\d.]+)rem$/)[1]) * 16;

    if (px !== null && px < 16) {
      found.push({ where: label, selector, value, px });
    }
  }
  return found;
}

test('the type scale is read in px correctly', () => {
  const scale = typeScale(tokens);
  assert.equal(scale.base, 15.2);
  assert.equal(scale.sm, 13.6);
  assert.ok(scale.lg >= 16, 'lg is the first step at or above the threshold');
});

test('the scan catches a field set below the iOS zoom threshold', () => {
  const scale = typeScale(tokens);
  const bad = '.search input {\n  padding: 4px;\n  font-size: var(--text-sm);\n}';
  const hits = smallFieldRules(bad, scale, 'sample');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].px, 13.6);
});

test('the scan ignores checkboxes and large fields', () => {
  const scale = typeScale(tokens);
  const fine = '.setting input[type="checkbox"] { font-size: var(--text-xs); }\n'
    + '.qty-amount input { font-size: var(--text-2xl); }\n'
    + '.field input { font-size: 16px; }';
  assert.deepEqual(smallFieldRules(fine, scale, 'sample'), []);
});

test('no field is styled below 16px, or iOS zooms the app and will not undo it', () => {
  const scale = typeScale(tokens);
  const hits = [
    ...smallFieldRules(base, scale, 'base.css'),
    ...smallFieldRules(pages, scale, 'pages.css'),
    ...smallFieldRules(components, scale, 'components.css'),
  ];
  assert.deepEqual(hits, [],
    `iOS Safari zooms in on focus below 16px and never zooms back out:\n${
      hits.map((h) => `  ${h.where}  ${h.selector}  font-size: ${h.value} (${h.px}px)`).join('\n')}`);
});

test('base.css floors every field at the threshold', () => {
  // The inputs that set no size of their own inherit from body, which is 15.2px,
  // so the floor is what actually protects most of the app.
  assert.match(base, /input, select, textarea \{ font-size: 16px; \}/);
  const floorAt = base.indexOf('input, select, textarea { font-size: 16px; }');
  const inheritAt = base.indexOf('button, input, select, textarea { font: inherit');
  assert.ok(inheritAt !== -1 && floorAt > inheritAt,
    'the floor must come after `font: inherit`, which would otherwise win');
});
