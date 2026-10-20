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
  assert.match(src, /mealPrompt\(note\)/);
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

// ---- a described meal, no photo at all --------------------------------------------

test('a described meal sends the text and no images', async () => {
  const [call] = await capture(() => photo.describeMeal('  two street tacos \n and chips '));
  assert.equal(call.name, 'read-food-photo');
  assert.equal(call.body.mode, 'describe');
  assert.equal(call.body.description, 'two street tacos \n and chips');
  assert.equal('images' in call.body, false);
});

test('an empty description never reaches the network', async () => {
  const calls = await capture(async () => {
    await assert.rejects(() => photo.describeMeal(''), /Describe what you ate/);
    await assert.rejects(() => photo.describeMeal('   '), /Describe what you ate/);
  });
  assert.equal(calls.length, 0);
});

test('cleanDescription gives a description more room than a note, but still a cap', () => {
  assert.ok(prompt.DESCRIPTION_MAX > prompt.NOTE_MAX);
  const text = prompt.cleanDescription('tacos '.repeat(200));
  assert.ok(text.length <= prompt.DESCRIPTION_MAX, `got ${text.length}`);
  assert.equal(prompt.cleanDescription('   '), null);
  assert.equal(prompt.cleanDescription(42), null);
});

test('the describe prompt quotes the description and keeps the meal JSON shape', () => {
  const text = prompt.describePrompt('two street tacos al pastor');
  assert.ok(text.startsWith(prompt.DESCRIBE_PROMPT));
  assert.ok(text.includes('"""two street tacos al pastor"""'));
  assert.match(prompt.DESCRIBE_PROMPT, /"items":/);
  assert.match(prompt.DESCRIBE_PROMPT, /"confidence":/);
  assert.match(prompt.DESCRIBE_PROMPT, /restaurant or brand/);
  assert.match(prompt.DESCRIBE_PROMPT, /typical serving/);
});

test('the function routes describe mode through cleanDescription and describePrompt', async () => {
  const src = await source('../supabase/functions/read-food-photo/index.ts');
  assert.match(src, /description = cleanDescription\(body\?\.description\)/);
  assert.match(src, /describePrompt\(description!\)/);
  assert.match(src, /mode === "describe" && !description/, 'an empty description must be refused');
  assert.match(src, /mode !== "describe" && !images\.length/, 'photo modes still require a photo');
  assert.doesNotMatch(src, /const DESCRIBE_PROMPT/, 'the prompt lives in meal-prompt.ts, not a copy here');
});

test('the describe sheet binds the box and lands in the estimate sheet', async () => {
  const html = await source('../docs/index.html');
  const start = html.indexOf('<template x-if="describing">');
  assert.ok(start > -1, 'the describe sheet is missing');
  const sheet = html.slice(start, html.indexOf('</template>', start));
  assert.match(sheet, /x-model="describing\.text"/);
  assert.match(sheet, /@click="readDescription\(\)"/);

  // Two ways in: the + menu, and a search that found nothing (seeded with the term).
  assert.match(html, /@click="startDescribe\(term\)"/);
  assert.match(html, /startDescribe\(\)/);

  const app = await source('../docs/js/app.js');
  assert.match(app, /this\.estimate = result/, 'a description reviews in the same estimate sheet');
  const reads = app.match(/photo\.describeMeal\(/g) ?? [];
  assert.equal(reads.length, 1, 'only readDescription() should call describeMeal');
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

// ---- the reply's shape is binding -----------------------------------------------

// A plate came back with calories on every item and protein, carbs and fat all
// zero: the reply named the macros differently and the function filled the gaps.
test('a meal or description reply must carry every macro on every item', () => {
  const item = prompt.MEAL_SCHEMA.properties.items.items;
  assert.deepEqual([...item.required].sort(),
    ['calories', 'carbs_g', 'fat_g', 'name', 'portion', 'protein_g']);
  for (const key of ['calories', 'protein_g', 'carbs_g', 'fat_g']) assert.equal(item.properties[key].type, 'NUMBER');
});

test('the function sends that schema for meals and descriptions, not label reads', async () => {
  const src = await source('../supabase/functions/read-food-photo/index.ts');
  assert.match(src, /schema: mode === "label" \? null : MEAL_SCHEMA/);
});

test('a macro missing from the reply stays missing rather than becoming zero', async () => {
  const src = await source('../supabase/functions/read-food-photo/index.ts');
  for (const key of ['protein_g', 'carbs_g', 'fat_g']) {
    assert.match(src, new RegExp(`${key}: num\\(raw\\?\\.${key}\\),`));
  }
});

// ---- a stuck reader -----------------------------------------------------------

// A pasted label hung until the platform killed the function at 150 seconds,
// which reached the app as "Edge Function returned a non-2xx status code".
const gemini = await import('../supabase/functions/read-food-photo/gemini.ts');

/** A fetch that never answers until its deadline fires, then fails as fetch does. */
const hangs = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});
const answers = (text) => async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] } }],
}));

test('a model that hangs gives way to the next one', async () => {
  const asked = [];
  const result = await gemini.askGemini('k', 'p', [], {
    model: 'first',
    attemptMs: 20,
    fetch: (url, init) => {
      asked.push(url.match(/models\/([^:]+)/)[1]);
      return asked.length === 1 ? hangs(url, init) : answers('{"ok":true}')();
    },
  });
  assert.deepEqual(result, { text: '{"ok":true}' });
  assert.deepEqual(asked, ['first', gemini.FALLBACK_MODELS[0]], 'not the stuck model a second time');
});

test('when every model hangs it gives up inside its budget and says the reader is slow', async () => {
  let asked = 0;
  const result = await gemini.askGemini('k', 'p', [], {
    attemptMs: 30, budgetMs: 80, fetch: (url, init) => { asked += 1; return hangs(url, init); },
  });
  assert.match(result.error, /slow/);
  assert.ok(asked <= 3, `stopped at the budget rather than trying all five models (${asked})`);
});

test('the budget leaves the platform\'s 150 seconds room to answer', () => {
  assert.ok(gemini.BUDGET_MS <= 120_000);
  assert.ok(gemini.ATTEMPT_MS < gemini.BUDGET_MS);
});

test('the schema goes in the request when given, and not otherwise', async () => {
  const bodies = [];
  const fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return answers('{}')(); };
  await gemini.askGemini('k', 'p', [], { schema: prompt.MEAL_SCHEMA, fetch });
  await gemini.askGemini('k', 'p', [], { fetch });
  assert.deepEqual(bodies[0].generationConfig.responseSchema, prompt.MEAL_SCHEMA);
  assert.equal('responseSchema' in bodies[1].generationConfig, false);
});
