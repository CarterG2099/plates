// Minimal PNG read/write. No dependencies — zlib is built into Node, and this
// repo does not have a build step to hang a package on.
//
// Handles 8-bit truecolour with or without alpha, which is what every image
// coming out of Gemini has been. Anything else throws rather than guessing.
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @returns {{width:number, height:number, channels:number, data:Buffer}} RGBA-or-RGB rows, unfiltered. */
export function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let width = 0, height = 0, channels = 0;
  const idat = [];

  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      if (depth !== 8) throw new Error(`bit depth ${depth} unsupported`);
      if (colour === 2) channels = 3;
      else if (colour === 6) channels = 4;
      else throw new Error(`colour type ${colour} unsupported`);
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  // Undo the per-scanline filter. Each row's filter byte says how it was encoded
  // relative to the pixel to the left (a), the row above (b), and up-left (c).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`filter ${filter} at row ${y}`);
      row[i] = v & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

export function encode({ width, height, channels, data }) {
  const stride = width * channels;
  // Filter 0 (none) on every row. The gain from adaptive filtering is small on
  // flat art, and being obviously correct matters more here than a few percent.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function crop(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * img.channels);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * img.channels;
    img.data.copy(out, row * w * img.channels, from, from + w * img.channels);
  }
  return { width: w, height: h, channels: img.channels, data: out };
}

/** Box-filter downscale. Averaging beats nearest-neighbour on flat art edges. */
export function resize(img, size) {
  const { width, height, channels } = img;
  const out = Buffer.alloc(size * size * channels);
  const sx = width / size, sy = height / size;

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      for (let c = 0; c < channels; c++) {
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            sum += img.data[(yy * width + xx) * channels + c];
            n++;
          }
        }
        out[(y * size + x) * channels + c] = Math.round(sum / n);
      }
    }
  }
  return { width: size, height: size, channels, data: out };
}

/**
 * Paint a rectangle with a colour sampled from a known-empty corner.
 *
 * Used to take the Gemini sparkle off the bottom-right. The background is flat,
 * so a single sampled pixel matches exactly; sampling rather than hard-coding
 * means it still works if the model shifts the charcoal between batches.
 */
export function patch(img, x, y, w, h, sampleX, sampleY) {
  const { channels } = img;
  const at = (px, py) => (py * img.width + px) * channels;
  const src = at(sampleX, sampleY);
  const colour = img.data.subarray(src, src + channels);

  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      colour.copy(img.data, at(col, row));
    }
  }
  return img;
}
