#!/usr/bin/env node
/* probe-features.js — v2.2.0 Modrinth power update verification.
   Builds a REAL .mrpack file (self-contained minimal ZIP writer, store method),
   then exercises the full converter path offline:
     1. readMrpackIndex preview
     2. installMrpack → NEW instance (overrides copied, loader/version patched, marker written)
     3. installMrpack → EXISTING instance (converts it)
     4. path-traversal .mrpack refused
     5. non-mrpack zip refused
   Run: node scripts/probe-features.js                                     */
'use strict';
process.env.NEURAX_HOME = process.env.NEURAX_HOME || '/tmp/neurax-probe-' + Date.now();

const fs = require('fs');
const path = require('path');
const assert = require('assert');

/* ---------- minimal ZIP writer (no compression, valid CRC32) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/** files: [{ name, data(Buffer|string) }] → Buffer (a real, extractable .zip/.mrpack) */
function buildZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------- build the probe modpack ---------- */
const packDir = '/tmp/neurax-probe-build-' + Date.now();
fs.mkdirSync(packDir, { recursive: true });
const index = {
  formatVersion: 1, game: 'minecraft',
  name: 'Probe Pack', versionId: '1.0.0', summary: 'probe-features test pack',
  files: [
    // server-side-only file must be skipped on client import (no download attempted)
    { path: 'server-mods/side-only.jar', hashes: { sha1: '0'.repeat(40) },
      env: { client: 'unsupported', server: 'required' },
      downloads: ['https://cdn.modrinth.com/never-downloaded.jar'], fileSize: 1 },
  ],
  dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.16.9' },
  overrides: 'overrides',
};
const mrpackPath = path.join(packDir, 'probe-pack.mrpack');
fs.writeFileSync(mrpackPath, buildZip([
  { name: 'modrinth.index.json', data: JSON.stringify(index, null, 2) },
  { name: 'overrides/config/options.txt', data: 'probe:1\n' },
  { name: 'overrides/mods/placeholder.txt', data: 'not a real mod\n' },
  { name: 'server-overrides/mots.txt', data: 'server only\n' },
]));
console.log('built mrpack:', mrpackPath, fs.statSync(mrpackPath).size, 'bytes');

/* malicious pack: file entry escapes the game dir */
const evilPath = path.join(packDir, 'evil.mrpack');
fs.writeFileSync(evilPath, buildZip([
  { name: 'modrinth.index.json', data: JSON.stringify({
    formatVersion: 1, game: 'minecraft', name: 'Evil', files: [
      { path: '../../exploit.txt', downloads: ['https://cdn.modrinth.com/x'], fileSize: 1 },
    ], dependencies: { minecraft: '1.21.4' },
  }) },
]));
/* not a modpack at all */
const junkPath = path.join(packDir, 'junk.mrpack');
fs.writeFileSync(junkPath, buildZip([{ name: 'readme.txt', data: 'hello' }]));

/* ---------- run the probe ---------- */
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.error('  ✗', name, '→', e.message); }
}

(async () => {
  const mr = require('../src/main/core/modrinth');
  const store = require('../src/main/core/store');
  require('../src/main/core/paths').ensureDirs();

  await check('readMrpackIndex previews the pack', async () => {
    const info = await mr.readMrpackIndex(mrpackPath);
    assert.strictEqual(info.name, 'Probe Pack');
    assert.strictEqual(info.gameVersion, '1.21.4');
    assert.strictEqual(info.loader, 'fabric');
    assert.strictEqual(info.loaderVersion, '0.16.9');
    assert.strictEqual(info.fileCount, 1);
    assert.strictEqual(info.hasOverrides, true);
  });

  await check('installMrpack → NEW instance: overrides + loader patch + marker + env skip', async () => {
    const statuses = [];
    const res = await mr.installMrpack({
      mrpackPath, target: { type: 'new-instance', name: 'Probe Imported', memoryMB: 2048 },
      onStatus: (s) => statuses.push(s),
    });
    assert.strictEqual(res.loader, 'fabric');
    assert.strictEqual(res.version, '1.21.4');
    assert.strictEqual(res.files, 0);          // the only declared file is server-side → skipped
    assert.strictEqual(res.skipped, 1);
    const inst = store.getInstance(res.instanceId);
    assert.strictEqual(inst.name, 'Probe Imported');
    assert.strictEqual(inst.loader, 'fabric');
    assert.strictEqual(inst.loaderVersion, '0.16.9');
    const gameDir = store.instanceGameDir(res.instanceId);
    assert.ok(fs.existsSync(path.join(gameDir, 'config/options.txt')), 'overrides copied');
    assert.ok(fs.existsSync(path.join(gameDir, 'mods/placeholder.txt')), 'override mods dir copied');
    assert.ok(!fs.existsSync(path.join(gameDir, 'mots.txt')), 'server-overrides NOT copied');
    assert.ok(fs.existsSync(path.join(gameDir, '.neurax-modpack.json')), 'provenance marker');
    assert.ok(statuses.length >= 2, 'status callbacks fired');
  });

  await check('installMrpack → EXISTING instance converts it', async () => {
    const inst = store.createInstance({ name: 'Old Vanilla', version: '1.19.4', loader: 'vanilla' });
    const res = await mr.installMrpack({ mrpackPath, target: { type: 'instance', instanceId: inst.id } });
    const after = store.getInstance(inst.id);
    assert.strictEqual(after.version, '1.21.4');
    assert.strictEqual(after.loader, 'fabric');
    assert.strictEqual(res.instanceId, inst.id);
  });

  await check('path-traversal .mrpack is REFUSED', async () => {
    await assert.rejects(() => mr.installMrpack({ mrpackPath: evilPath, target: { type: 'new-instance', name: 'Evil' } }), /Unsafe path/);
  });

  await check('non-mrpack zip is REFUSED with a clear error', async () => {
    await assert.rejects(() => mr.readMrpackIndex(junkPath), /Not a valid .mrpack/);
    await assert.rejects(() => mr.installMrpack({ mrpackPath: junkPath, target: { type: 'new-instance' } }), /Not a valid .mrpack/);
  });

  await check('downloadMrpackFile refuses non-Modrinth URLs (unit-level)', async () => {
    await assert.rejects(async () => mr.assertCdnUrl('http://cdn.modrinth.com/x.mrpack'), /Refusing non-Modrinth/);
    await assert.rejects(async () => mr.assertCdnUrl('https://evil.example.com/x.mrpack'), /Refusing non-Modrinth/);
    await assert.rejects(async () => mr.assertCdnUrl('not a url'), /Invalid download URL/);
    mr.assertCdnUrl('https://cdn.modrinth.com/data/AABBCC/versions/1.0/pack.mrpack'); // must not throw
  });

  console.log(`\n${pass}/${pass + fail} probe checks passed. Data root: ${process.env.NEURAX_HOME}`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error('probe crashed:', e); process.exit(1); });
