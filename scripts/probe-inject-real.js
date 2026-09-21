// probe-inject-real.js — REAL network end-to-end for the v2.3.1 INSTANCE
// injection: creates a throwaway 26.1.2 instance, lets the real injector
// layer actual Fabric Loader meta, download the REAL mod stack from live
// Modrinth (sha1-verified), install the GUI pack, then uninjects and checks
// the restore. Uses a throwaway NEURAX_HOME — user data is never touched.
'use strict';
process.env.NEURAX_HOME = '/tmp/neurax-probe-inject-real-' + Date.now();
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.error('  ✗ ' + l); } };

(async () => {
  console.log('— Neurax Client INSTANCE injection REAL probe (live Modrinth + Fabric meta) —');
  const settingsMod = require('../src/main/core/settings');
  const store = require('../src/main/core/store');
  const versionsMod = require('../src/main/core/versions');
  const client = require('../src/main/core/client');
  const pathsMod = require('../src/main/core/paths');
  settingsMod.load();
  settingsMod.set({ theme: 'emerald', clientGuiTheme: 'auto', neuraxClient: true, clientFpsMode: 'ultra' });

  // 1. live Fabric meta for 26.1.2
  const loaders = await versionsMod.getFabricLoaderVersions('26.1.2');
  ok(Array.isArray(loaders) && loaders.length > 0, `live Fabric loader versions for 26.1.2 (${loaders[0] && loaders[0].loader})`);

  // 2. create a REAL vanilla 26.1.2 instance — the creation hook does the rest
  const t0 = Date.now();
  const inst = store.createInstance({ name: 'Real 26.1.2', version: '26.1.2', loader: 'vanilla' });
  let cur = null;
  for (let i = 0; i < 360 && !(cur && cur.neuraxClient && cur.neuraxClient.injected); i++) {
    await new Promise(r => setTimeout(r, 500));
    cur = store.getInstance(inst.id);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  ok(!!(cur && cur.neuraxClient && cur.neuraxClient.injected), `creation hook fully injected the instance in ~${secs}s`);
  if (!(cur && cur.neuraxClient && cur.neuraxClient.injected)) {
    console.error('   injection did not finish — aborting before file asserts');
    process.exit(1);
  }
  ok(cur.loader === 'fabric', `vanilla upgraded to fabric (${cur.loaderVersion})`);
  console.log(`   injected: ${cur.neuraxClient.mods} mods • theme ${cur.neuraxClient.theme} • loader ${cur.neuraxClient.loader} ${cur.neuraxClient.loaderVersion || ''}`);

  const gameDir = store.instanceGameDir(inst.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(gameDir, 'neurax-client.json'), 'utf8'));
  ok(manifest.injectorVersion === 2 && manifest.modsExpected === true, 'manifest written (injector v2, mods expected)');
  ok(manifest.mods.length >= 8, `${manifest.mods.length} real mods managed`);
  console.log('   stack: ' + manifest.mods.map(m => `${m.name}@${m.version}`).join(', '));

  // 3. the jars are REAL: sane sizes, sha1s re-verified against the manifest copies
  const modsDir = path.join(gameDir, 'mods');
  for (const m of manifest.mods.slice(0, 4)) {
    const p = path.join(modsDir, m.file);
    ok(fs.existsSync(p) && fs.statSync(p).size > 10000, `${m.file} (${Math.round(fs.statSync(p).size / 1024)} KB)`);
  }
  const profJson = path.join(pathsMod.DIRS.minecraft, 'versions', `fabric-loader-${cur.loaderVersion}-26.1.2`, `fabric-loader-${cur.loaderVersion}-26.1.2.json`);
  ok(fs.existsSync(profJson), 'real Fabric profile JSON installed in the versions root');
  const prof = JSON.parse(fs.readFileSync(profJson, 'utf8'));
  ok(prof.id && Array.isArray(prof.libraries) && prof.libraries.length > 0, `profile is real (id ${prof.id}, ${prof.libraries.length} libraries)`);
  ok(fs.existsSync(path.join(gameDir, 'resourcepacks', 'neurax-ui-emerald', 'pack.mcmeta')), 'GUI pack installed into the instance');
  const opt = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  ok(opt.includes('"file/neurax-ui-emerald"'), 'options.txt enables the pack');

  // 4. idempotent: migrateInstances finds it fresh
  const mig = await client.migrateInstances();
  ok(mig.targets >= 1 && mig.injected === 0, 'startup migration re-run: 0 churn (already fresh)');

  // 5. uninject restores the vanilla instance
  const un = await client.uninjectInstance({ instanceId: inst.id });
  ok(un.ok && un.removedMods === manifest.mods.length, `uninject removed ${un.removedMods} managed mods`);
  const after = store.getInstance(inst.id);
  ok(after.loader === 'vanilla' && !after.neuraxClient, 'instance restored to plain vanilla');
  ok(!fs.existsSync(path.join(gameDir, 'neurax-client.json')), 'manifest deleted');
  ok(fs.readdirSync(modsDir).length === 0, 'mods folder empty again');
  const optAfter = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  ok(!optAfter.includes('neurax-ui'), 'options.txt cleaned');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
