// Generates build/icon.png — NX gradient logo on dark rounded square.
// Pure Node (zlib + manual PNG chunks). Run: node scripts/make-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512; // canvas size

// --- tiny software renderer: signed distance for shapes, 4x4 supersampling ---
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function mix(a, b, t) { return a + (b - a) * t; }

// rounded-rect SDF
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// N letter geometry: two vertical bars + diagonal, in letter box
// box: x0..x1, y0..y1
function sdN(px, py, x0, x1, y0, y1, thickness) {
  const w = x1 - x0, h = y1 - y0;
  const t = thickness;
  // left bar: vertical stripe
  const dLeft = sdRoundRect(px, py, x0 + t / 2, (y0 + y1) / 2, t / 2, h / 2, Math.min(t / 2, 0.02));
  // right bar
  const dRight = sdRoundRect(px, py, x1 - t / 2, (y0 + y1) / 2, t / 2, h / 2, Math.min(t / 2, 0.02));
  // diagonal from top-left to bottom-right
  // segment between P1=(x0+t*0.1, y0+t*0.6) and P2=(x1-t*0.1, y1-t*0.6)
  const p1x = x0 + w * 0.10, p1y = y0 + h * 0.14;
  const p2x = x1 - w * 0.10, p2y = y1 - h * 0.14;
  const vx = p2x - p1x, vy = p2y - p1y;
  const wx = px - p1x, wy = py - p1y;
  const len2 = vx * vx + vy * vy;
  let tSeg = clamp((wx * vx + wy * vy) / len2, 0, 1);
  const cxp = p1x + vx * tSeg, cyp = p1y + vy * tSeg;
  const dDiag = Math.hypot(px - cxp, py - cyp) - t * 0.62;
  return Math.min(dLeft, dRight, dDiag);
}

// cyan→blue→magenta gradient like mockup logo
function logoColor(px, py) {
  const t = clamp((py / S) * 0.55 + (px / S) * 0.45, 0, 1);
  // stops: cyan (34,211,238) -> blue (59,130,246) -> magenta (217,70,239)
  let r, g, b;
  if (t < 0.5) {
    const u = t / 0.5;
    r = mix(34, 59, u); g = mix(211, 130, u); b = mix(238, 246, u);
  } else {
    const u = (t - 0.5) / 0.5;
    r = mix(59, 217, u); g = mix(130, 70, u); b = mix(246, 239, u);
  }
  return [r, g, b];
}

function bg(px, py) {
  // dark #0b0f14 with subtle vertical gradient to #101820
  const t = py / S;
  return [mix(8, 16, t), mix(11, 24, t), mix(14, 32, t)];
}

function render(size) {
  const rows = [];
  const scale = S / size;
  const ss = 3; // supersample per axis
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) * scale;
          const py = (y + (sy + 0.5) / ss) * scale;
          // dst starts transparent
          let dr = 0, dg = 0, db = 0, da = 0;
          // paint background rounded square
          const dBg = sdRoundRect(px, py, S / 2, S / 2, S * 0.46, S * 0.46, S * 0.12);
          const bgA = clamp(0.5 - dBg, 0, 1);
          if (bgA > 0) {
            const [br, bgc, bb] = bg(px, py);
            dr = br * bgA + dr * (1 - bgA);
            dg = bgc * bgA + dg * (1 - bgA);
            db = bb * bgA + db * (1 - bgA);
            da = bgA + da * (1 - bgA);
          }
          // paint letter N over it
          const dN = sdN(px, py, S * 0.30, S * 0.70, S * 0.24, S * 0.76, S * 0.085);
          const nA = clamp(0.5 - dN, 0, 1);
          if (nA > 0) {
            const [lr, lg, lb] = logoColor(px, py);
            dr = lr * nA + dr * (1 - nA);
            dg = lg * nA + dg * (1 - nA);
            db = lb * nA + db * (1 - nA);
            da = nA + da * (1 - nA);
          }
          r += dr; g += dg; b += db; a += da;
        }
      }
      const n = ss * ss;
      row[x * 4 + 0] = clamp(Math.round(r / n), 0, 255);
      row[x * 4 + 1] = clamp(Math.round(g / n), 0, 255);
      row[x * 4 + 2] = clamp(Math.round(b / n), 0, 255);
      row[x * 4 + 3] = clamp(Math.round((a / n) * 255), 0, 255);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

function pngEncode(width, height, rgba) {
  function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw with filter bytes
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const size = 256;
const rgba = render(size);
const out = pngEncode(size, size, rgba);
const dest = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(dest, out);
console.log('Wrote', dest, out.length, 'bytes');
