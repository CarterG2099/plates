/**
 * The note that rides along with a plate photo.
 *
 * "Made with Greek yogurt", "from Cafe Rio" — what the camera can't see. Three
 * places have to agree for it to reach the model: the client sends it, the Edge
 * Function reads it, and the prompt carries it. The prompt module is imported
 * straight from supabase/functions, so this is the source Deno runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installBrowser } from './helpers/browser.mjs';

installBrowser();
globalThis.createImageBitmap = async () => ({ width: 4000, height: 3000, close() {} });

const photo = await import('../docs/js/photo.js');
const { supabase } = await import('../docs/js/supabase.js');
const prompt = await import('../supabase/functions/read-food-photo/meal-prompt.ts');

const source = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** Run `fn` with invoke recording its calls; returns what was sent. */
async function capture(fn) {
  const real = supabase.functions.invoke;
  const calls = [];
  supabase.functions.invoke = async (name, options) => {
    calls.push({ name, body: options.body });
    return { data: { items: [], confidence: 'low', note: null }, error: null };
  };
  try {
    await fn();
  } finally {
    supabase.functions.invoke = real;
  }
  return calls;
}

const FILE = { name: 'plate.jpg' };

// ---- the client sends it --------------------------------------------------------

test('a meal estimate carries the note, trimmed', async () => {
  const [call] = await capture(() => photo.estimateMeal(FILE, '  made with Greek yogurt \n'));
  assert.equal(call.name, 'read-food-photo');
  assert.equal(call.body.mode, 'meal');
  assert.equal(call.body.note, 'made with Greek yogurt');
  assert.equal(call.body.images.length, 1);
});

test('no note, or a blank one, sends the same request as before notes existed', async () => {
  const calls = await capture(async () => {
    await photo.estimateMeal(FILE);
    await photo.estimateMeal(FILE, '   ');
  });
  for (const call of calls) assert.equal('note' in call.body, false);
});

test('a label read never sends a note', async () => {
  const calls = await capture(() => photo.readLabel(FILE));
  assert.equal(calls[0].body.mode, 'label');
  assert.equal('note' in calls[0].body, false);
});

// ---- the function reads it ------------------------------------------------------

test('cleanNote keeps one trimmed line and drops anything that isn\'t text', () => {
  assert.equal(prompt.cleanNote('  from   Cafe Rio\n\nno rice  '), 'from Cafe Rio no rice');
  assert.equal(prompt.cleanNote(''), null);
  assert.equal(prompt.cleanNote('   '), null);
  assert.equal(prompt.cleanNote(undefined), null);
  assert.equal(prompt.cleanNote(42), null);
  assert.equal(prompt.cleanNote({ note: 'x' }), null);
});

test('cleanNote caps a long note so it can\'t crowd out the instructions', () => {
  const note = prompt.cleanNote('yogurt '.repeat(200));
  assert.ok(note.length <= prompt.NOTE_MAX, `got ${note.length}`);
  assert.equal(note, note.trim());
});

test('the function passes the body\'s note through cleanNote into the meal prompt', async () => {
  const src = await source('../supabase/functions/read-food-photo/index.ts');
  assert.match(src, /note = cleanNote\(body\?\.note\)/);
  assert.match(src, /mode === "meal" \? mealPrompt\(note\) : LABEL_PROMPT/);
  assert.doesNotMatch(src, /const MEAL_PROMPT/, 'the prompt lives in meal-prompt.ts, not a copy here');
});

// ---- the prompt carries it ------------------------------------------------------

test('without a note the prompt is the plain photo prompt', () => {
  assert.equal(prompt.mealPrompt(null), prompt.MEAL_PROMPT);
  assert.equal(prompt.mealPrompt(undefined), prompt.MEAL_PROMPT);
  assert.equal(prompt.mealPrompt(''), prompt.MEAL_PROMPT);
});

test('a note is quoted after the instructions and outranks the picture', () => {
  const text = prompt.mealPrompt('made with Greek yogurt, from Cafe Rio');
  assert.ok(text.startsWith(prompt.MEAL_PROMPT));
  assert.ok(text.includes('"""made with Greek yogurt, from Cafe Rio"""'));
  assert.match(text, /go with the note/);
  assert.match(text, /restaurant or brand/);
  assert.match(text, /substitute ingredient/);
});

// ---- the app asks for it --------------------------------------------------------

test('every plate photo goes through the note sheet before it is read', async () => {
  // Two ways in — the scanner's camera-app fallback and New meal → From a
  // photo — and one read. A second direct call would be a path that skips the
  // note box.
  const app = await source('../docs/js/app.js');
  const reads = app.match(/photo\.estimateMeal\(/g) ?? [];
  assert.equal(reads.length, 1, 'only readMealPhoto() should call estimateMeal');
  assert.match(app, /photo\.estimateMeal\(pending\.file, pending\.note\)/);
  assert.match(app, /this\.openMealPhoto\(file, 'meal'\)/);
  assert.match(app, /this\.openMealPhoto\(file, 'estimate'\)/);
});

test('the note sheet binds the box and reads on Read it and on Enter', async () => {
  const html = await source('../docs/index.html');
  const start = html.indexOf('<template x-if="mealPhoto">');
  assert.ok(start > -1, 'the note sheet is missing');
  const sheet = html.slice(start, html.indexOf('</template>', start));
  assert.match(sheet, /x-model="mealPhoto\.note"/);
  assert.match(sheet, /@keydown\.enter\.prevent="readMealPhoto\(\)"/);
  assert.match(sheet, /@click="readMealPhoto\(\)"/);
  assert.match(sheet, /:src="mealPhoto\.url"/);
});
