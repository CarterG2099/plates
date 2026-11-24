/**
 * The look, held in place.
 *
 * On 2026-11-24 the app dropped monospace and tracked capitals everywhere
 * (they read as a developer tool) for the phone's own font, sentence case,
 * soft-filled buttons and real icons. These keep it from drifting back one
 * rule at a time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const CSS = ['../docs/css/tokens.css', '../docs/css/base.css', '../docs/css/components.css', '../docs/css/pages.css'];
const css = (await Promise.all(CSS.map(read))).join('\n');
const html = await read('../docs/index.html');
const both = `${css}\n${html}`;

/** Declarations only: comments explain history and may name what was removed. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

test('nothing is set in monospace', () => {
  assert.doesNotMatch(code(both), /var\(--font-mono\)/);
});

test('nothing is forced into capitals', () => {
  assert.doesNotMatch(code(both), /text-transform:\s*uppercase/);
});

test('no widened letter spacing, except the PIN boxes, whose dots it spaces', () => {
  const widened = [...code(both).matchAll(/letter-spacing:\s*(\.?\d*\.?\d+)(em|ch)/g)]
    .filter((m) => Number(m[1]) > 0);
  const allowed = widened.filter((m) => m[2] === 'ch' || m[0].includes('.3em'));
  assert.deepEqual(widened.map((m) => m[0]), allowed.map((m) => m[0]));
  assert.ok(widened.length <= 4, `expected only the PIN boxes, got ${widened.map((m) => m[0]).join(', ')}`);
});

test('numbers keep their columns without a monospace font', () => {
  assert.match(css, /body \{[^}]*font-variant-numeric: tabular-nums;/);
});

test('no text character stands in for an icon', () => {
  for (const glyph of ['×', '‹', '›', '✓', '⋯', '−', '+', '⌕']) {
    const alone = new RegExp(`>\\s*${glyph.replace(/[+]/g, '\\+')}\\s*</(button|span)>`);
    assert.doesNotMatch(html, alone, `a lone ${glyph} is still an icon`);
  }
});

test('every tab has an icon and a label', () => {
  const bar = html.slice(html.indexOf('<nav class="tabbar">'), html.indexOf('</nav>', html.indexOf('<nav class="tabbar">')));
  for (const [view, label] of [['today', 'Today'], ['plan', 'Plan'], ['train', 'Train'], ['stats', 'Stats']]) {
    assert.match(bar, new RegExp(`\\$store\\.ui\\.go\\('${view}'\\)">\\s*<svg class="icon"[\\s\\S]*?</svg>\\s*<span>${label}</span>`), view);
  }
  assert.match(css, /\.tabbar button\.is-active \.icon \{ color: var\(--color-primary-hover\); \}/);
});

test('buttons are soft-filled rounded rectangles, not outlined pills', () => {
  const btn = css.match(/\n\.btn \{[^}]+\}/)[0];
  assert.match(btn, /border-radius: var\(--radius-control\);/);
  assert.match(btn, /background: var\(--color-fill\);/);
  assert.match(btn, /border: 1px solid transparent;/);
  assert.match(btn, /white-space: nowrap;/);
  for (const sel of ['.tap', '.qty-step', '.chip']) {
    const rule = css.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{[^}]+\\}`))[0];
    assert.match(rule, /background: var\(--color-fill\);/, sel);
    assert.doesNotMatch(rule, /border: 1px solid var\(--color-border\)/, sel);
  }
});

test('a section heading reads as a heading, and the count beside it stays quiet', () => {
  const head = css.match(/\n\.section-head \{[^}]+\}/)[0];
  assert.match(head, /font-size: var\(--text-lg\);/);
  assert.match(head, /color: var\(--color-text\);/);
  assert.match(css, /\.section-head > span \+ span \{[^}]*font-size: var\(--text-sm\);[^}]*color: var\(--color-text-dim\);/);
});

test('a row\'s chevron is a hint, but the avatar keeps its circle', () => {
  assert.match(css, /span\.tap:not\(\.avatar\) \{ background: none; \}/);
  assert.match(css, /\.tap\.avatar \{[^}]*background: var\(--color-primary-soft\);/);
});
