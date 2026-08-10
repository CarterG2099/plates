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

/** Mean luminance down a column (`axis` 0) or across a row (`axis` 1). */
function lineMean(img, index, axis) {
  const { width, height, channels, data } = img;
  const n = axis === 0 ? height : width;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const i = (axis === 0 ? k * width + index : index * width + k) * channels;
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / n;
}

/**
 * How far the divider between two cells bleeds either side of the boundary.
 *
 * Gemini draws a light rule between quadrants even when told not to — 8px on one
 * sheet, 20px on another — so cropping at the exact half leaves a bright strip
 * down the inside edge of every cell. Measured rather than hard-coded because it
 * has been a different width in every batch so far.
 *
 * A seam runs the full height, so a column mean separates it from artwork
 * cleanly; a figure crossing the boundary only lifts the mean a little.
 */
function seamRadius(img, boundary, axis, limit = 40) {
  const away = lineMean(img, boundary - limit * 2, axis);
  const bright = (k) => lineMean(img, k, axis) > away + 8;
  if (!bright(boundary) && !bright(boundary - 1)) return 0;

  let lo = boundary, hi = boundary - 1;
  while (lo - 1 > boundary - limit && bright(lo - 1)) lo--;
  while (hi + 1 < boundary + limit && bright(hi + 1)) hi++;
  return Math.max(boundary - lo, hi - boundary + 1);
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

  // One radius for the whole sheet: the widest divider found on any interior
  // boundary. Uneven insets would make the cells different sizes, and a drawing
  // that is 1% smaller than its neighbours is not worth the precision.
  let pad = 0;
  for (let c = 1; c < cols; c++) pad = Math.max(pad, seamRadius(source, c * cellW, 0));
  for (let r = 1; r < rows; r++) pad = Math.max(pad, seamRadius(source, r * cellH, 1));
  if (pad) console.log(`trimming a ${pad * 2}px divider between cells`);

  args.forEach((slug, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Inset every edge, not just the ones touching a divider, so each cell keeps
    // the same framing as its neighbours.
    write(crop(source, col * cellW + pad, row * cellH + pad, cellW - pad * 2, cellH - pad * 2), slug);
  });
} else {
  die(`unknown command "${command}" — expected sheet or single`);
}
