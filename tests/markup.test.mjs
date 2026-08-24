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
