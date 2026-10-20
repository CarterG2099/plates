import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const html = await readFile(
  fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');

/**
 * Every <template> that sits between an <svg> and its </svg>.
 *
 * The HTML parser puts such a template in the SVG namespace, where it is a
 * plain SVGElement rather than an HTMLTemplateElement — it has no `.content`
 * fragment, so Alpine's x-for has nothing to clone. The loop does not throw
 * and does not warn; it simply never runs, and the literal child element is
 * left in the document with none of its bindings applied. Cheap to grep for,
 * invisible in review, so it gets a test.
 */
function templatesInsideSvg(source) {
  const found = [];
  const svg = /<svg\b[^>]*>([\s\S]*?)<\/svg>/gi;
  for (let m; (m = svg.exec(source)) !== null;) {
    const inner = m[1];
    // t.index is relative to the svg's contents, so offset past the open tag.
    const start = m.index + m[0].indexOf('>') + 1;
    const tpl = /<template\b[^>]*>/gi;
    for (let t; (t = tpl.exec(inner)) !== null;) {
      found.push({ tag: t[0], line: source.slice(0, start + t.index).split('\n').length });
    }
  }
  return found;
}

test('the scan catches an x-for template nested in an svg', () => {
  const bad = `<div>
    <svg viewBox="0 0 10 10">
      <template x-for="pt in points"><circle :cx="pt.x"/></template>
    </svg>
  </div>`;
  const hits = templatesInsideSvg(bad);
  assert.equal(hits.length, 1);
  assert.match(hits[0].tag, /x-for/);
  assert.equal(hits[0].line, 3);
});

test('the scan ignores a template that merely wraps an svg', () => {
  const fine = `<template x-if="plot">
    <div><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></div>
  </template>`;
  assert.deepEqual(templatesInsideSvg(fine), []);
});

test('index.html has no template inside an svg', () => {
  const hits = templatesInsideSvg(html);
  assert.deepEqual(hits, [],
    `x-for/x-if inside <svg> never runs; build the markup and use x-html instead:\n${
      hits.map((h) => `  index.html:${h.line}  ${h.tag}`).join('\n')}`);
});

/**
 * Every Alpine attribute binding whose name carries a capital letter.
 *
 * The HTML parser lowercases attribute names, so `:viewBox` reaches Alpine as
 * `:viewbox` and gets set as `viewbox`. HTML does not care, but SVG and MathML
 * attributes are case-sensitive, so the attribute is ignored and the binding
 * does nothing at all — no error, no warning. `:viewBox` cost this page its
 * whole coordinate system that way. Set such attributes with x-effect and
 * $el.setAttribute instead, which preserves the case.
 */
function camelCasedBindings(source) {
  const found = [];
  const re = /(?:^|\s)(?:x-bind)?:([a-zA-Z-]*[A-Z][a-zA-Z-]*)=/g;
  for (let m; (m = re.exec(source)) !== null;) {
    found.push({ attr: m[1], line: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

test('the scan catches a camelCased binding', () => {
  const hits = camelCasedBindings('<svg :viewBox="`0 0 ${w} ${h}`"><path :d="line"/></svg>');
  assert.deepEqual(hits.map((h) => h.attr), ['viewBox']);
});

test('the scan leaves lowercase and hyphenated bindings alone', () => {
  const fine = '<div :class="x" :aria-label="y" x-bind:disabled="z" @pointermove="f"></div>';
  assert.deepEqual(camelCasedBindings(fine), []);
});

test('index.html binds no camelCased attributes', () => {
  const hits = camelCasedBindings(html);
  assert.deepEqual(hits, [],
    `these bindings are silently dropped; use x-effect + $el.setAttribute:\n${
      hits.map((h) => `  index.html:${h.line}  :${h.attr}`).join('\n')}`);
});

// The two-rows bug: :value rewrites the DOM box on every re-render, and the
// refresh after each background sync landed mid-typing — editing two rows and
// checking one reset the other. While focused, the binding must hand back the
// box's own text.
test('set-cell value bindings never overwrite a focused input', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');

  const cells = [...html.matchAll(/class="cell num"[^>]*:value="([^"]*)"/gs)].map((m) => m[1]);
  assert.ok(cells.length >= 4, `expected the four set cells, found ${cells.length}`);
  for (const binding of cells) {
    assert.match(binding, /\$el === document\.activeElement/,
      `a set cell binding lacks the focused guard: ${binding}`);
  }
});

// ---- the loading barbell -----------------------------------------------------

test('both boot screens show the loading barbell, three plates a side', () => {
  const loaders = html.match(/<div class="loader" role="status" aria-label="Loading">[\s\S]*?<div class="loader-word">Plates<\/div>/g) ?? [];
  assert.equal(loaders.length, 2, 'the static #boot screen and the Alpine boot template');
  for (const loader of loaders) {
    for (const side of ['left', 'right']) {
      for (const plate of ['25', '20', '15']) {
        assert.match(loader, new RegExp(`class="loader-plate is-${side} is-${plate}"`), `${side} ${plate}`);
      }
    }
  }
  const boot = html.slice(html.indexOf('<div id="boot">'), html.indexOf('<div class="app"'));
  assert.match(boot, /class="loader"/, '#boot carries it, before any script runs');
  assert.doesNotMatch(html, /class="spinner" role="status" aria-label="Loading"/, 'the old boot spinner is gone');
});

test('the Alpine boot screen picks the loop up where #boot left it', () => {
  assert.match(html, /x-init="\$el\.style\.setProperty\('--loader-phase', `-\$\{Math\.round\(performance\.now\(\) % 2400\)\}ms`\)"/);
});

test('the loader is in base.css, stills under reduced motion, and runs on the page phase', async () => {
  const css = await readFile(fileURLToPath(new URL('../docs/css/base.css', import.meta.url)), 'utf8');
  assert.match(css, /@keyframes loader-rep/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.loader-lift, \.loader-floor, \.loader-plate \{ animation: none; \}/);
  // The shorthand resets the delay, so each animated part sets the phase after it.
  assert.equal((css.match(/animation-delay: var\(--loader-phase, 0s\);/g) ?? []).length, 3);
});

// The quick-add row showed "1.5 servings · 130 kcal" — last time's amount next
// to one serving's calories. Both numbers must come from the same amount.
test('the quick-add row prices the amount it will log, not one serving', () => {
  const row = html.match(/<template x-for="item in results"[\s\S]*?<\/template>/)?.[0];
  assert.ok(row, 'the results row template exists');
  assert.match(row, /amountLabel\(rowQuantity\(item\)/, 'the amount shown is what + logs');
  assert.match(row, /Math\.round\(rowKcal\(item\)\)/, 'and the kcal are for that amount');
  assert.doesNotMatch(row, /Math\.round\(item\.calories\)/, 'per-serving calories never sit next to a different amount');
});

test('each estimated food has its own portion stepper, beside its remove button', async () => {
  const html = await readFile(fileURLToPath(new URL('../docs/index.html', import.meta.url)), 'utf8');
  const sheet = html.slice(html.indexOf('<!-- Meal estimate'), html.indexOf('<!-- Plate photo, before'));
  assert.match(sheet, /@click="stepEstimateItem\(i, -1\)"/);
  assert.match(sheet, /@click="stepEstimateItem\(i, 1\)"/);
  assert.match(sheet, /x-text="portionLabel\(item\)"/);
  assert.match(sheet, /x-text="estimateItemLine\(item\)"/);
});
