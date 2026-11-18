/**
 * png-scan.cjs — dependency-free PNG region scanner for device evidence.
 *
 * WHY: the Liquid Bar investigation needs OBJECTIVE pixel evidence ("is the
 * bubble painted, and over which columns?") instead of a visual impression, and
 * this machine has no Pillow/ImageMagick. Node's zlib is enough to decode a
 * non-interlaced 8-bit PNG, which is exactly what `adb exec-out screencap -p`
 * produces.
 *
 * Usage:
 *   node scripts/png-scan.cjs shot.png <x0> <y0> <x1> <y1>
 *
 * Reports, inside the region:
 *   • the count of "bubble-blue" pixels per column (b - r >= 18, a light blue
 *     tint over the frosted pill) and the resulting bounding box,
 *   • the mean b-r ramp per column, so a sheen gradient (no bubble) is clearly
 *     distinguishable from a painted rounded rect (a plateau).
 *
 * Read-only. Never modifies the image.
 */
'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8) throw new Error('only 8-bit PNG supported, got ' + depth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('unsupported color type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = i >= channels && prev ? prev[i - channels] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

const [, , file, x0s, y0s, x1s, y1s] = process.argv;
if (!file) {
  console.error('usage: node scripts/png-scan.cjs <png> [x0 y0 x1 y1]');
  process.exit(2);
}
const img = decodePng(file);
const x0 = Math.max(0, Number(x0s) || 0);
const y0 = Math.max(0, Number(y0s) || 0);
const x1 = Math.min(img.width, Number(x1s) || img.width);
const y1 = Math.min(img.height, Number(y1s) || img.height);

const px = (x, y) => {
  const i = (y * img.width + x) * img.channels;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
};

let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, hits = 0;
const colHits = new Array(x1 - x0).fill(0);
const colRamp = new Array(x1 - x0).fill(0);
for (let y = y0; y < y1; y++) {
  for (let x = x0; x < x1; x++) {
    const [r, , b] = px(x, y);
    colRamp[x - x0] += b - r;
    if (b - r >= 18 && b >= 140) {
      hits++;
      colHits[x - x0]++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}

console.log('image      :', file, `${img.width}x${img.height} ch=${img.channels}`);
console.log('region     :', `x ${x0}..${x1}  y ${y0}..${y1}`);
console.log('blue pixels:', hits);
if (hits > 0) {
  console.log('bbox       :', `x ${minX}..${maxX} (w ${maxX - minX + 1})  y ${minY}..${maxY} (h ${maxY - minY + 1})`);
} else {
  console.log('bbox       : NONE (no bubble-tinted pixel in this region)');
}
const ramp = colRamp.map((v) => +(v / (y1 - y0)).toFixed(1));
console.log('mean b-r per column (region start \u2192 end, sampled every 24 px):');
const sample = [];
for (let i = 0; i < ramp.length; i += 24) sample.push(`${x0 + i}:${ramp[i]}`);
console.log(' ', sample.join('  '));
const dense = colHits
  .map((c, i) => (c >= Math.max(4, Math.floor((y1 - y0) * 0.05)) ? x0 + i : -1))
  .filter((v) => v >= 0);
if (dense.length) console.log('dense cols :', dense[0], '..', dense[dense.length - 1], `(${dense.length} cols)`);
