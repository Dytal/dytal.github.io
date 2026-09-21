// net.js — HTTP helpers: JSON fetch with timeout+retry, file download with progress,
// and a persistent JSON file cache under .neurax/cache.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DIRS, writeJSON, readJSON } = require('./paths');
const logger = require('./logger');

const UA = 'NeuraxLauncher/2.0 (+https://neurax.launcher)';

function request(url, { method = 'GET', headers = {}, body = null, timeout = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }
    const mod = u.protocol === 'http:' ? http : https;
    const opts = {
      method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, ...headers },
      timeout,
    };
    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, { method, headers, body, timeout, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`Timeout after ${timeout}ms: ${url}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJSON(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status !== 200) {
    const snippet = res.buffer.slice(0, 200).toString('utf8');
    throw new Error(`HTTP ${res.status} for ${url} — ${snippet}`);
  }
  return JSON.parse(res.buffer.toString('utf8'));
}

async function getText(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.buffer.toString('utf8');
}

/** Robust Windows-safe rename: retries with backoff, clears the destination,
 *  and falls back to copy+unlink when the AV/indexer holds a lock (EPERM). */
function finalizeDownload(tmp, dest) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  return (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await sleep(250 * Math.pow(2, attempt - 1)); // 250ms .. 4s
      try {
        // a stale destination that is locked/undeletable is the #1 EPERM cause
        try { fs.rmSync(dest, { force: true }); } catch {}
        fs.renameSync(tmp, dest);
        return;
      } catch (e) {
        lastErr = e;
        if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
      }
    }
    // last resort: copy (works across locks that only block rename on Windows)
    try {
      fs.copyFileSync(tmp, dest);
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return;
    } catch (e) { throw lastErr || e; }
  })();
}

/** Unique temp name per attempt — two downloads must never share a .part file
 *  (parallel launches used to collide on the same name and EPERM-rename). */
function partName(dest) {
  const uniq = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${dest}.part-${uniq}`;
}

/** Download to file with progress callback (received, total). Returns bytes. */
async function download(url, dest, { onProgress = null, headers = {}, tries = 3 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const tmp = partName(dest);
    let fd = null;
    try {
      const res = await request(url, { headers });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      // stream to disk in chunks so progress is real
      fd = fs.openSync(tmp, 'w');
      let received = 0;
      const buf = res.buffer;
      const CH = 1 << 20;
      for (let off = 0; off < buf.length; off += CH) {
        const end = Math.min(off + CH, buf.length);
        fs.writeSync(fd, buf, off, end - off);
        received = end;
        if (onProgress) { try { onProgress(received, Math.max(total, buf.length)); } catch {} }
      }
      fs.closeSync(fd); fd = null;
      await finalizeDownload(tmp, dest);
      return buf.length;
    } catch (e) {
      lastErr = e;
      logger.raw('download').warn(`download retry ${i + 1}/${tries} for ${url}: ${e.message}`);
      try { if (fd !== null) fs.closeSync(fd); } catch {}
      try { fs.rmSync(tmp, { force: true }); } catch {}
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---- persistent cache (file-backed) ----
function cacheGet(key, maxAgeMs) {
  const file = path.join(DIRS.cache, sanitize(key) + '.json');
  const wrap = readJSON(file);
  if (!wrap) return null;
  if (maxAgeMs != null && Date.now() - wrap.t > maxAgeMs) return null;
  return wrap.v;
}

function cacheSet(key, value) {
  try { writeJSON(path.join(DIRS.cache, sanitize(key) + '.json'), { t: Date.now(), v: value }); }
  catch (e) { logger.core.warn('cacheSet failed: ' + e.message); }
}

function cacheClear() {
  try {
    for (const f of fs.readdirSync(DIRS.cache)) {
      if (f.endsWith('.json')) { try { fs.unlinkSync(path.join(DIRS.cache, f)); } catch {} }
    }
  } catch {}
}

function sanitize(key) { return String(key).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120); }

/** Fetch JSON with stale-while-error cache: prefer fresh, fall back to stale copy. */
async function cachedJSON(url, { maxAgeMs = 30 * 60 * 1000, key = url } = {}) {
  const fresh = cacheGet(key, maxAgeMs);
  if (fresh) return { data: fresh, fromCache: true };
  try {
    const data = await getJSON(url);
    cacheSet(key, data);
    return { data, fromCache: false };
  } catch (e) {
    const stale = cacheGet(key, null);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw e;
  }
}

module.exports = { request, getJSON, getText, download, cacheGet, cacheSet, cacheClear, cachedJSON };
