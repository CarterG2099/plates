/**
 * No Alpine component may define the same member twice.
 *
 * An object literal keeps the last key written and says nothing about the ones
 * it dropped — no error, no warning. `trainPage` defined `collapsed` twice: once
 * as the folded-away workout's boolean, once as the array of folded routine
 * categories. The array won, and because an empty array is truthy, every workout
 * opened minimised; expanding one then set `collapsed = false`, and the next
 * `false.includes(...)` broke the category folds until the tab remounted.
 *
 * Two reported bugs, one duplicate key. This reads the source rather than the
 * running app because that is where the collision is visible at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

/**
 * Members of each `Alpine.data('name', () => ({ … }))` literal.
 *
 * Depth-counted from the opening brace rather than regex-matched over the whole
 * block, so a key nested inside a method body is not mistaken for a member of
 * the component. Every form the file uses is picked up: `foo: value`,
 * `foo(args) {`, `get foo()`, and `async foo(`.
 */
function componentMembers(source) {
  const found = new Map();
  const opener = /Alpine\.data\(\s*'([^']+)'\s*,\s*\(\)\s*=>\s*\(\{/g;

  for (let m; (m = opener.exec(source)) !== null;) {
    const name = m[1];
    const members = [];
    let depth = 1;
    let i = m.index + m[0].length;
    let lineStart = i;

    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === '\n') { lineStart = i + 1; continue; }

      // Only at depth 1 is a line a member of the component itself.
      if (depth === 1 && c === '\n') lineStart = i + 1;
    }

    // Re-scan the block line by line, tracking depth, collecting depth-1 keys.
    const block = source.slice(m.index + m[0].length, i);
    let d = 1;
    for (const line of block.split('\n')) {
      const atLineStart = d;
      for (const ch of line) {
        if (ch === '{' || ch === '[' || ch === '(') d++;
        else if (ch === '}' || ch === ']' || ch === ')') d--;
      }
      if (atLineStart !== 1) continue;

      const key = line.match(/^\s{2}(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[:(]/);
      if (key) members.push(key[1]);
    }
    found.set(name, members);
  }
  return found;
}

const components = componentMembers(src);

test('the scan finds the components and their members', () => {
  assert.ok(components.size >= 3, `only found ${components.size} components`);
  assert.ok(components.has('trainPage'));
  assert.ok(components.get('trainPage').includes('collapsed'),
    'the workout fold flag is still a member');
  assert.ok(components.get('trainPage').includes('foldedCategories'));
});

test('the scan would catch a duplicate, so a pass means something', () => {
  const planted = componentMembers(`Alpine.data('fake', () => ({
  collapsed: false,
  something() { return { collapsed: 1 }; },
  collapsed: [],
}))`);
  const keys = planted.get('fake');
  assert.deepEqual(keys, ['collapsed', 'something', 'collapsed'],
    'both spellings seen, and the one nested in a method body ignored');
});

test('no component defines the same member twice', () => {
  const clashes = [];
  for (const [name, members] of components) {
    const seen = new Set();
    for (const key of members) {
      if (seen.has(key)) clashes.push(`${name}.${key}`);
      seen.add(key);
    }
  }
  assert.deepEqual(clashes, [],
    `an object literal keeps the last one silently:\n  ${clashes.join('\n  ')}`);
});
