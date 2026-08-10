#!/usr/bin/env node
// art.mjs — put a generated exercise drawing where the app will find it.
//
// The drawings come out of Gemini web as 2048px squares, either one exercise per
// image or four in a 2 × 2 sheet. This slices, downscales and files them under
// the slug the app derives from the exercise name.
//
// No dependencies, and no build step to hang one on: PNG is zlib-compressed
// scanlines and zlib ships with Node, so png.mjs does the whole job in ~150
// lines. sips was tried first and silently ignored --cropOffset for one corner,
// returning the uncompressed original at full size — a wrong answer that looks
// like a right one is worse than no tool.
//
//   node tools/art.mjs sheet <image> <tl> <tr> <bl> <br>
//   node tools/art.mjs sheet <image> --cols 3 <left> <middle> <right>
//   node tools/art.mjs single <image> <slug>
//
// Slugs are given without the .png. Nothing is written outside docs/img/exercises.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode, crop, resize } from './png.mjs';

// 512 covers the largest place a drawing renders (about 150px) on a 3× display.
// The list thumbnail is 44px, so this is already generous.
const SIZE = 512;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'img', 'exercises');

function die(message) {
  console.error(message);
  process.exit(1);
}

function write(image, slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) die(`"${slug}" is not a slug — lowercase, digits and hyphens only.`);
  const file = path.join(OUT_DIR, `${slug}.png`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, encode(resize(image, SIZE)));
  console.log(`${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)}kB`);
}

const [command, file, ...rest] = process.argv.slice(2);
if (!command || !file) die('usage: art.mjs sheet|single <image> ...');
if (!fs.existsSync(file)) die(`no such file: ${file}`);

const source = decode(fs.readFileSync(file));

if (command === 'single') {
  const [slug] = rest;
  if (!slug || rest.length > 1) die('single takes exactly one slug');
  write(source, slug);
} else if (command === 'sheet') {
  let cols = 2;
  const args = [...rest];
  const flag = args.indexOf('--cols');
  if (flag !== -1) {
    cols = Number(args.splice(flag, 2)[1]);
    if (!Number.isInteger(cols) || cols < 1) die('--cols needs a positive integer');
  }

  // A 2 × 2 sheet is square; a 3 × 1 strip is not. Deriving rows from the slug
  // count rather than assuming a square grid is what lets both work.
  const rows = Math.ceil(args.length / cols);
  const cellW = Math.floor(source.width / cols);
  const cellH = Math.floor(source.height / rows);

  if (!args.length) die('sheet needs at least one slug');
  if (args.length !== rows * cols) {
    die(`${args.length} slugs does not fill a ${cols}×${rows} grid — pass exactly ${rows * cols}, or set --cols`);
  }

  args.forEach((slug, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    write(crop(source, x, y, cellW, cellH), slug);
  });
} else {
  die(`unknown command "${command}" — expected sheet or single`);
}
