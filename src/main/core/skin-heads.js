// skin-heads.js — player HEAD cropping for the whole launcher (Settings avatar,
// NX chat rows, online chip, admin panel).
//
// THE BUG THIS FIXES: the account chip rendered acc.skin.url — the FULL 64x64
// skin PNG — squeezed into a small circle. Everywhere a face is shown we now
// crop the 8x8 face at (8,8), alpha-composite the 8x8 HAT layer at (40,8) on
// top (so hats/hair overlays survive), nearest-neighbour upscale to 64x64 and
// serve a PNG data URL with image-rendering: pixelated in CSS.
//
// Resolution order (per player): memory cache → disk cache (.neurax/cache/heads)
// → cloud row (nx_identities.skin_head uploaded by that device) → local skin
// file → Mojang sessionserver → generated pixel avatar. Never throws.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DIRS } = require('./paths');
const logger = require('./logger');

const HEAD_DIR = path.join(DIRS.root, 'cache', 'heads');
const DISK_TTL = 7 * 24 * 3600e3;      // one week per head
const DISK_MAX = 400;                  // prune pool
const mem = new Map();                 // key -> { data, at }

/* ---------------------------------------------------------------- PNG out */
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of td) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, cb]);
}
function pngEncode(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------- generated pixel avatar */
/** Deterministic 8x8 mirrored pattern from a uuid/name hash, upscaled to 64. */
function generatedAvatarDataUrl(key) {
  const S = 8, UP = 8, W = S * UP;
  const h = crypto.createHash('sha256').update(String(key || 'nx')).digest();
  const hue = (h[0] << 16 | h[1] << 8 | h[2]) % 360;
  const hue2 = (hue + 70) % 360;
  const rgb = (hh, l) => {
    const c = (1 - Math.abs(2 * l - 1)), x = c * (1 - Math.abs((hh / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  };
  const rgba = Buffer.alloc(W * W * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const mirror = x < 4 ? x : S - 1 - x;
    const bit = h[(y * 4 + mirror) % h.length] >> (mirror % 5) & 1;
    const [r, g, b] = bit ? rgb(hue, 0.58) : rgb(hue2, 0.22);
    for (let dy = 0; dy < UP; dy++) for (let dx = 0; dx < UP; dx++) {
      const i = ((y * UP + dy) * W + (x * UP + dx)) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + pngEncode(W, W, rgba).toString('base64');
}

/* ------------------------------------------------------------- head crop */
/** Crop face + hat from a full skin PNG. Returns a 64x64 PNG buffer (or null). */
function headPngFromSkin(skinBuf) {
  try {
    const { nativeImage } = require('electron');
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
    const skin = nativeImage.createFromBuffer(skinBuf);
    if (skin.isEmpty()) return null;
    const sz = skin.getSize();
    if (sz.width !== 64 || (sz.height !== 64 && sz.height !== 32)) return null;
    const face = skin.crop({ x: 8, y: 8, width: 8, height: 8 }).getBitmap();   // BGRA
    let hat = null;
    try { hat = skin.crop({ x: 40, y: 8, width: 8, height: 8 }).getBitmap(); } catch { hat = null; }
    const W = 64, UP = 8;
    const out = Buffer.alloc(W * W * 4);
    for (let y = 0; y < W; y++) {
      const sy = Math.floor(y / UP);
      for (let x = 0; x < W; x++) {
        const sx = Math.floor(x / UP);
        const si = (sy * 8 + sx) * 4;
        const o = (y * W + x) * 4;
        // base face (opaque), BGRA → RGBA
        let r = face[si + 2], g = face[si + 1], b = face[si], a = 255;
        // hat layer alpha-over (hat pixel may be fully transparent)
        if (hat) {
          const ha = hat[si + 3] / 255;
          r = Math.round(hat[si + 2] * ha + r * (1 - ha));
          g = Math.round(hat[si + 1] * ha + g * (1 - ha));
          b = Math.round(hat[si] * ha + b * (1 - ha));
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
      }
    }
    return pngEncode(W, W, out);
  } catch (e) {
    logger.core?.debug?.('head crop failed: ' + e.message);
    return null;
  }
}

/* ------------------------------------------------------------ disk cache */
function cachePath(key) { return path.join(HEAD_DIR, `${String(key).replace(/[^a-zA-Z0-9-]/g, '')}.png`); }
function readDisk(key) {
  try {
    const p = cachePath(key);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > DISK_TTL) { fs.unlinkSync(p); return null; }
    const buf = fs.readFileSync(p);
    if (buf.length < 100 || buf[0] !== 0x89) return null;
    return buf;
  } catch { return null; }
}
function writeDisk(key, pngBuf) {
  try {
    fs.mkdirSync(HEAD_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), pngBuf);
    // prune pool when it grows past the cap
    const files = fs.readdirSync(HEAD_DIR).map((f) => {
      try { const st = fs.statSync(path.join(HEAD_DIR, f)); return { f, t: st.mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.t - b.t);
    for (let i = 0; i < files.length - DISK_MAX; i++) { try { fs.unlinkSync(path.join(HEAD_DIR, files[i].f)); } catch {} }
  } catch { /* cache is best-effort */ }
}

/* -------------------------------------------------------------- fetching */
function httpsGet(url, { timeout = 10000, binary = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = require('https').get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const cs = []; res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(cs);
        resolve(binary ? buf : JSON.parse(buf.toString('utf8')));
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** Fetch the full skin for a Mojang account UUID. */
async function skinForMojangUuid(uuid) {
  const raw = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(raw)) return null;
  const prof = await httpsGet(`https://sessionserver.mojang.com/session/minecraft/profile/${raw}`, { binary: false });
  const tex = (prof.properties || []).find((p) => p.name === 'textures');
  if (!tex) return null;
  const tj = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf8'));
  const url = tj.textures?.SKIN?.url;
  return url ? await httpsGet(url, { timeout: 12000 }) : null;
}

/**
 * Head data URL for any player.
 * @param {object} ref { uuid (Mojang uuid if known), name, cloudHead (data URL
 *        uploaded by the player's device), localSkinPath (optional) }
 */
async function headDataUrl(ref = {}) {
  const key = ref.uuid || ref.name || 'nx';
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.data;

  let dataUrl = null;
  // 1) cloud-uploaded head (exact uuid match only)
  if (!dataUrl && ref.cloudHead && ref.uuid && String(ref.cloudHead).startsWith('data:image/png;base64,')) {
    try {
      const png = Buffer.from(String(ref.cloudHead).split(',')[1], 'base64');
      if (png.length > 100 && png[0] === 0x89) { dataUrl = ref.cloudHead; writeDisk(key, png); }
    } catch {}
  }
  // 2) local skin file (the launcher already downloaded this player's skin)
  if (!dataUrl) {
    for (const p of [ref.localSkinPath, ref.uuid ? path.join(DIRS.skins, `${ref.uuid}.png`) : null]) {
      if (!p) continue;
      try { if (fs.statSync(p).size > 100) { const head = headPngFromSkin(fs.readFileSync(p)); if (head) { dataUrl = 'data:image/png;base64,' + head.toString('base64'); writeDisk(key, head); break; } } } catch {}
    }
  }
  // 3) Mojang sessionserver
  if (!dataUrl && ref.uuid && /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(ref.uuid))) {
    try {
      const skin = await skinForMojangUuid(ref.uuid);
      if (skin) { const head = headPngFromSkin(skin); if (head) { dataUrl = 'data:image/png;base64,' + head.toString('base64'); writeDisk(key, head); } }
    } catch (e) { logger.core?.debug?.('skin fetch failed: ' + e.message); }
  }
  // 4) disk cache from a previous run
  if (!dataUrl) {
    const png = readDisk(key);
    if (png) dataUrl = 'data:image/png;base64,' + png.toString('base64');
  }
  // 5) generated pixel avatar (offline players, fetch failures)
  if (!dataUrl) dataUrl = generatedAvatarDataUrl(ref.name || ref.uuid || 'nx');

  mem.set(key, { data: dataUrl, at: Date.now() });
  if (mem.size > 300) { const first = mem.keys().next().value; mem.delete(first); }
  return dataUrl;
}

function clearCaches() { mem.clear(); try { fs.rmSync(HEAD_DIR, { recursive: true, force: true }); } catch {} }

module.exports = { headDataUrl, headPngFromSkin, generatedAvatarDataUrl, pngEncode, clearCaches, HEAD_DIR };
