#!/usr/bin/env node
// probe-nx.js — v3.0.0 artifact probe: the bundled NX mod jar + the NX Interface
// resource packs + the bundledNx()/options helpers. Pure node, no network.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
console.log('1) NX mod jar (src/main/nx)');
const NX_SRC = path.join(__dirname, '..', 'src', 'main', 'nx');
const jarName = fs.existsSync(NX_SRC) ? fs.readdirSync(NX_SRC).find(f => /^nx-\d[\w.]*\.jar$/.test(f)) : null;
ok(!!jarName, `NX jar shipped with the launcher (${jarName})`);
if (jarName) {
  const jarPath = path.join(NX_SRC, jarName);
  const buf = fs.readFileSync(jarPath);
  // minimal zip parse: local header + inflate fabric.mod.json
  ok(buf.readUInt32LE(0) === 0x04034b50, 'valid zip (local file header signature)');
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8), csize = buf.readUInt32LE(off + 18),
      nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString();
    const dataStart = off + 30 + nameLen + extraLen;
    entries.push({ name, method, csize, dataStart });
    off = dataStart + csize;
    if (method === 0) off = dataStart + csize; else off = dataStart + csize; // sizes known (zip written with sizes)
  }
  const names = entries.map(e => e.name);
  const fmEntry = entries.find(e => e.name === 'fabric.mod.json');
  ok(!!fmEntry, 'fabric.mod.json present at jar root');
  if (fmEntry) {
    const raw = buf.slice(fmEntry.dataStart, fmEntry.dataStart + fmEntry.csize);
    const data = fmEntry.method === 8 ? zlib.inflateRawSync(raw) : raw;
    const fm = JSON.parse(data.toString('utf8'));
    ok(fm.id === 'nx' && fm.environment === 'client', 'mod id "nx", client environment');
    ok(fm.name === 'NX Client' && fm.version === jarName.replace(/^nx-|\.jar$/g, ''), 'name/version match the jar filename');
    ok(Array.isArray(fm.entrypoints.client) && fm.entrypoints.client.includes('dev.neurax.nx.NXClient'), 'client entrypoint wired');
    ok(Array.isArray(fm.entrypoints.modmenu) && fm.entrypoints.modmenu.includes('dev.neurax.nx.NXModMenu'), 'ModMenu entrypoint wired');
    ok(fm.depends && fm.depends.minecraft === '>=26.1 <26.2', 'version-scoped: minecraft >=26.1 <26.2 (26.1.2 only)');
    ok(fm.suggests && 'sodium' in fm.suggests && 'vulkanmod' in fm.suggests, 'suggests sodium + vulkanmod (compatible with both)');
    ok(names.includes('assets/nx/icon.png'), 'mod icon embedded');
  }
  for (const cls of ['dev/neurax/nx/NXClient.class', 'dev/neurax/nx/NXConfig.class', 'dev/neurax/nx/NXConfigScreen.class', 'dev/neurax/nx/NXModMenu.class']) {
    const e = entries.find(x => x.name === cls);
    ok(!!e, `${cls} present`);
    if (e) {
      const raw = buf.slice(e.dataStart, e.dataStart + e.csize);
      const data = e.method === 8 ? zlib.inflateRawSync(raw) : raw;
      ok(data[6] * 256 + data[7] === 69, `${path.basename(cls)} compiled for Java 25 (class v69)`);
    }
  }
  ok(names.includes('dev/neurax/nx/NXClient.class') && !names.some(n => n.includes('mixin')), 'zero mixins — nothing that can fight Sodium/VulkanMod');
}

console.log('2) bundledNx() wiring');
const client = require('../src/main/core/client.js');
const nx26 = client.bundledNx('26.1.2');
const nx263 = client.bundledNx('26.3');
const nx1211 = client.bundledNx('1.21.11');
ok(!!nx26 && nx26.slug === 'nx' && nx26.bundled === true, '26.1.2 -> bundled NX resolved');
ok(nx263 === null && nx1211 === null, 'out-of-scope versions -> null (never injected elsewhere)');
ok(client.STACK_VERSION === 3 && client.INJECTOR_VERSION === 3, 'stack + injector versions current (v3 = NX-only split, GUI packs purged)');
ok(typeof client.purgeGuiThemePacks === 'function' && client.prepareLaunch, 'prepareLaunch + purgeGuiThemePacks exported (launch wiring + pack purge)');

console.log('3) resource-pack injection REMOVED (v1.0)');
const PACKS = path.join(__dirname, '..', 'src', 'main', 'clientpacks');
ok(!fs.existsSync(PACKS), 'clientpacks dir deleted from the source tree');
const nxInject = require('../src/main/core/nx-inject.js');
ok(typeof nxInject.purgeInjectedPack === 'function' && !nxInject.injectGameDir, 'nx-inject is purge-only (injectGameDir gone)');
const tmpGD = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-purge-'));
fs.mkdirSync(path.join(tmpGD, 'resourcepacks'), { recursive: true });
fs.writeFileSync(path.join(tmpGD, 'resourcepacks', 'NX-UI-64x.zip'), 'old pack');
fs.writeFileSync(path.join(tmpGD, '.nx-injected-v3'), 'marker');
fs.writeFileSync(path.join(tmpGD, 'options.txt'), 'resourcePacks:["vanilla","file/NX-UI-64x.zip","file/user-pack.zip"]\nsoundCategory master:1.0\n');
const purgeRes = nxInject.purgeInjectedPack(tmpGD);
ok(purgeRes.removedPack && purgeRes.removedMarker && purgeRes.cleanedOptions, 'purge removes the pack zip + marker + options.txt entry');
const opts = fs.readFileSync(path.join(tmpGD, 'options.txt'), 'utf8');
ok(opts.includes('file/user-pack.zip') && !opts.includes('NX-UI-64x'), 'user packs survive the purge untouched');
fs.rmSync(tmpGD, { recursive: true, force: true });

console.log('4) options.txt perf helpers');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-opt-'));
client.setOptionLines(tmp, { maxFps: 260, enableVsync: 'false' });
let got = client.getOptionLines(tmp, ['maxFps', 'enableVsync', 'resourcePacks']);
ok(got.maxFps === '260' && got.enableVsync === 'false' && got.resourcePacks === null, 'set/read roundtrip on a fresh gameDir');
client.setOptionLines(tmp, { maxFps: 120 });
got = client.getOptionLines(tmp, ['maxFps', 'enableVsync']);
ok(got.maxFps === '120' && got.enableVsync === 'false', 'existing line patched in place, others untouched');
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
