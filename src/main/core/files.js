// files.js — file inspector backend: tree listing, text read/write with auto-save,
// NBT read/edit for .dat/.nbt files, read-only .mca region browsing, delete/rename.
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./paths');
const nbt = require('./nbt');
const logger = require('./logger');

const MAX_TEXT = 2 * 1024 * 1024; // 2MB text cap
const MAX_NBT = 8 * 1024 * 1024;  // 8MB nbt cap

function safeRoot(root) {
  const real = path.resolve(root);
  if (!fs.existsSync(real)) throw new Error('Folder does not exist');
  return real;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** List a directory: [{name, type: 'file'|'dir', size, mtime}] sorted dirs-first. */
function list(root, sub = '') {
  const base = safeRoot(root);
  const target = path.resolve(base, sub || '.');
  if (!isInside(base, target) && target !== base) throw new Error('Path escapes the sandbox');
  const entries = fs.readdirSync(target, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.tmp-')) continue;
    try {
      const st = fs.statSync(path.join(target, e.name));
      out.push({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch { out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: 0, mtime: 0 }); }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: sub, entries: out };
}

function resolveFile(root, sub) {
  const base = safeRoot(root);
  const target = path.resolve(base, sub || '.');
  if (!isInside(base, target)) throw new Error('Path escapes the sandbox');
  return target;
}

function readText(root, sub) {
  const f = resolveFile(root, sub);
  const st = fs.statSync(f);
  if (st.size > MAX_TEXT) throw new Error('File too large for the text editor (2MB limit)');
  return { content: fs.readFileSync(f, 'utf8'), size: st.size, mtime: st.mtimeMs };
}

/** Write text; tiny atomic write. Called by the auto-saving editor. */
function writeText(root, sub, content) {
  const f = resolveFile(root, sub);
  const tmp = f + '.tmp-save';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, f);
  logger.files.debug(`saved ${sub}`);
  return { ok: true, mtime: fs.statSync(f).mtimeMs };
}

const NBT_EXTS = ['.dat', '.dat_old', '.nbt'];

function isNbtFile(name) {
  const base = path.basename(name);
  return NBT_EXTS.some(ext => base.endsWith(ext)) && !base.endsWith('.log');
}

/** Parse NBT file into a JSON tree for the UI. */
function readNbt(root, sub) {
  const f = resolveFile(root, sub);
  const st = fs.statSync(f);
  if (st.size > MAX_NBT) throw new Error('NBT file too large (8MB limit)');
  const parsed = nbt.parse(fs.readFileSync(f));
  return { name: parsed.name, tree: parsed.value, truncated: parsed.consumed < parsed.total };
}

/** Apply an edited NBT tree back to the file. */
function writeNbt(root, sub, { name, tree }) {
  const f = resolveFile(root, sub);
  const out = nbt.serialize({ name: name || '', value: tree }, { gzip: true });
  const tmp = f + '.tmp-save';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, f);
  logger.files.info(`NBT saved: ${sub}`);
  return { ok: true };
}

/** Read-only region (.mca) chunk index. */
function readRegion(root, sub, limit = 200) {
  const f = resolveFile(root, sub);
  const buf = fs.readFileSync(f);
  const chunks = nbt.parseRegion(buf, { limit });
  return { chunks: chunks.map(c => ({ x: c.x, z: c.z, error: c.error || null, hasNbt: !!c.nbt })) };
}

function readRegionChunk(root, sub, index) {
  const f = resolveFile(root, sub);
  const buf = fs.readFileSync(f);
  const chunks = nbt.parseRegion(buf, { limit: 1024 });
  const c = chunks.find(c => c.x === (index % 32) && c.z === Math.floor(index / 32)) ||
    chunks[Number.isInteger(index) ? index : 0];
  if (!c) throw new Error('Chunk not present');
  return { x: c.x, z: c.z, tree: c.nbt ? c.nbt.value : null, error: c.error || null };
}

function mkdir(root, sub, name) {
  const dir = resolveFile(root, path.dirname(path.join(sub, name)));
  fs.mkdirSync(path.join(dir, path.basename(name)), { recursive: true });
  return { ok: true };
}

function touch(root, sub, name) {
  const dir = resolveFile(root, sub);
  fs.writeFileSync(path.join(dir, name), '', 'utf8');
  return { ok: true };
}

function remove(root, sub) {
  const f = resolveFile(root, sub);
  fs.rmSync(f, { recursive: true, force: true });
  return { ok: true };
}

function rename(root, sub, newName) {
  const f = resolveFile(root, sub);
  const target = path.join(path.dirname(f), path.basename(newName));
  fs.renameSync(f, target);
  return { ok: true };
}

function sizeOfDir(dir) {
  let size = 0, files = 0;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { try { size += fs.statSync(p).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { size, files };
}

module.exports = {
  list, readText, writeText, readNbt, writeNbt,
  readRegion, readRegionChunk, mkdir, touch, remove, rename, sizeOfDir, isNbtFile,
};
