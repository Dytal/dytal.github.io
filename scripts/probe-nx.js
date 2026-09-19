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
ok(client.STACK_VERSION === 2 && client.INJECTOR_VERSION === 2, 'stack + injector versions bumped (old caches/migrations invalidated)');

console.log('3) NX Interface resource packs (4 themes)');
const PACKS = path.join(__dirname, '..', 'src', 'main', 'clientpacks');
const THEMES = ['purple', 'emerald', 'cyan', 'orange'];
let fileSet = null;
for (const theme of THEMES) {
  const root = path.join(PACKS, theme);
  ok(fs.existsSync(path.join(root, 'pack.mcmeta')) && fs.existsSync(path.join(root, 'pack.png')), `${theme}: pack.mcmeta + pack.png`);
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'pack.mcmeta'), 'utf8'));
  ok(meta.pack.supported_formats && meta.pack.supported_formats.max_inclusive >= 999 && meta.pack.pack_format >= 34,
    `${theme}: supported_formats covers 26.x`);
  const sprites = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : sprites.push(path.relative(root, p).replace(/\\/g, '/')); } };
  walk(path.join(root, 'assets'));
  const pngs = sprites.filter(f => f.endsWith('.png'));
  if (fileSet === null) fileSet = sprites.slice().sort();
  ok(JSON.stringify(sprites.slice().sort()) === JSON.stringify(fileSet), `${theme}: identical file set across themes (${pngs.length} sprites)`);
  ok(!pngs.some(f => f.includes('container/') || f.includes('hud/')), `${theme}: NO inventory/HUD sprites (inventory stays vanilla)`);
  const dims = {
    'widget/button.png': [800, 80], 'widget/checkbox.png': [80, 80],
    'widget/slider.png': [800, 80], 'widget/slider_handle.png': [32, 80],
    'widget/scroller.png': [24, 128], 'widget/text_field.png': [800, 80],
    'tooltip/background.png': [400, 400], 'widget/cross_button.png': [56, 56],
    'widget/page_forward.png': [92, 52], 'widget/locked_button.png': [80, 80],
  };
  let dimOk = true;
  for (const [rel, [w, h]] of Object.entries(dims)) {
    const p = path.join(root, 'assets/minecraft/textures/gui/sprites', rel);
    if (!fs.existsSync(p)) { dimOk = false; continue; }
    const b = fs.readFileSync(p);
    // PNG IHDR: width @16, height @20 (big endian)
    const pw = b.readUInt32BE(16), ph = b.readUInt32BE(20);
    const frames = ph / h;
    if (pw !== w || !Number.isInteger(frames) || frames < 1 || frames > 12) dimOk = false;
  }
  ok(dimOk, `${theme}: all spot-checked sprites are exactly 4x vanilla (64x-class), strips whole-frame`);
  const mcf = JSON.parse(fs.readFileSync(path.join(root, 'assets/minecraft/textures/gui/sprites/widget/button_highlighted.png.mcmeta'), 'utf8'));
  ok(mcf.animation && mcf.animation.frames.length === 8 && mcf.gui.scaling.border === 12,
    `${theme}: button_highlighted animated (8 frames) + nine_slice border 12 (3x4)`);
}

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
