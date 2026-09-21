// probe-client-real.js — REAL network end-to-end: resolve the actual Neurax
// Client stack for Minecraft 26.3 from the live Modrinth API, verify sha1s,
// then confirm the fabric.addMods token and pack apply. Uses a throwaway
// NEURAX_HOME so the user's data is never touched.
'use strict';
process.env.NEURAX_HOME = '/tmp/neurax-probe-client-real-' + Date.now();
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.error('  ✗ ' + l); } };

(async () => {
  console.log('— Neurax Client REAL-network probe (live Modrinth) —');
  const settingsMod = require('../src/main/core/settings');
  const client = require('../src/main/core/client');
  settingsMod.load();

  const r = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'ultra' });
  ok(r.injected === true, 'stack resolved from live API');
  ok(r.mods.length >= 8, `enough mods resolved (${r.mods.length})`);
  ok(r.mods.every(m => fs.statSync(m.path).size > 10000), 'every jar downloaded with sane size');
  console.log('   stack: ' + r.mods.map(m => `${m.name}@${m.version}`).join(', '));

  const arg = client.fabricAddModsArg(r.mods);
  ok(arg && arg.startsWith('-Dfabric.addMods='), 'fabric.addMods token built');
  ok(arg.split(process.platform === 'win32' ? ';' : ':').length === r.mods.length, 'paths count matches');

  // quick second-version sanity: 1.21.11 (older lineage) — expect sodium present
  const r2 = await client.resolveStack({ gameVersion: '1.21.11', fpsMode: 'ultra' });
  ok(r2.injected && r2.mods.some(m => m.slug === 'sodium'), '1.21.11 resolves Sodium too (multi-version support)');
  console.log('   1.21.11 stack: ' + r2.mods.map(m => `${m.name}@${m.version}`).join(', '));

  // GUI pack apply into a fake game dir
  const gd = process.env.NEURAX_HOME + '/gamedir';
  fs.mkdirSync(gd, { recursive: true });
  const pack = client.applyGuiTheme({ gameDir: gd, theme: 'emerald' });
  ok(pack === 'neurax-ui-emerald', 'GUI pack applied to game dir');
  ok(fs.existsSync(gd + '/resourcepacks/neurax-ui-emerald/pack.mcmeta'), 'pack.mcmeta present');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
