#!/usr/bin/env node
// badge.mjs — the notification badge, cut from the app icon's geometry.
//
// Android does not draw the badge. It reads the alpha channel, throws the colour
// away and fills the opaque part with the system accent — so an icon with no
// transparency arrives as a solid white box, which is exactly what the app icon
// is: RGB, no alpha, edge to edge.
//
// So the badge has to be the logo as a silhouette: opaque where the ring and the
// hub are, transparent everywhere else. The radii below are measured from
// icon-512.png rather than guessed, and kept as fractions so the shape survives
// the icon being redrawn at another size.
//
//   node tools/badge.mjs

import { writeFileSync } from 'node:fs';
import { encode } from './png.mjs';

const SIZE = 96;          // what Android asks for; it downscales from here
const SS = 4;             // supersampling, since these are curves at 96px

// Measured on icon-512.png, centre 256, as fractions of the canvas.
const OUTER = 215.5 / 512;
const INNER = 153.5 / 512;
const HUB   = 71.0 / 512;

const data = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;

    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        // Sample at the centre of each sub-pixel, in canvas fractions.
        const fx = (x + (sx + 0.5) / SS) / SIZE - 0.5;
        const fy = (y + (sy + 0.5) / SS) / SIZE - 0.5;
        const r = Math.hypot(fx, fy);

        if ((r <= OUTER && r >= INNER) || r <= HUB) hits++;
      }
    }

    const i = (y * SIZE + x) * 4;
    // White, because a platform that does render the badge rather than
    // silhouetting it draws it on a dark tray. Android ignores all three.
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round((hits / (SS * SS)) * 255);
  }
}

const out = new URL('../docs/icons/badge-96.png', import.meta.url);
writeFileSync(out, encode({ width: SIZE, height: SIZE, channels: 4, data }));

const opaque = data.filter((_, i) => i % 4 === 3 && data[i] === 255).length;
console.log(`badge-96.png: ${SIZE}x${SIZE} RGBA, ${opaque} fully opaque pixels`);
