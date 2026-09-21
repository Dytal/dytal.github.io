// probe-client.js — engine-level tests for the Neurax Client (v2.3.0).
// Uses a FAKE Modrinth (net.getJSON patched) + FAKE downloads so no network is
// touched, proving: resolution, per-version skipping, sha1 handling, cache TTL,
// offline fallback, fabric.addMods arg format, perf args, theme pack install,
// options.txt patching (idempotent), and never-block-launch semantics.
'use strict';
const fs = require('fs');
const path = require('path');

process.env.NEURAX_HOME = '/tmp/neurax-probe-client-' + Date.now();
const NEURAX = process.env.NEURAX_HOME;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.error('  ✗ ' + label); }
}

// ---- fake net BEFORE requiring engine modules that use it -------------------
const net = require('../src/main/core/net');
let fakeVersions = {};       // slug -> array of Modrinth version objects
// modrinth.js captures cachedJSON at import time, so patch the module function
const modrinthMod = require('../src/main/core/modrinth');
modrinthMod.getVersions = async (slug) => fakeVersions[slug] || [];
net.download = async (url, dest) => {
  const f = fakeFiles.get(url);
  if (!f) throw new Error('fake net: no file for ' + url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.buffer);
  return f.buffer.length;
};

const crypto = require('crypto');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const fakeFiles = new Map(); // url -> { buffer }
const jar = (name, ver) => ({
  id: 'v-' + name, version_number: ver,
  loaders: ['fabric'], game_versions: ['26.3'],
  files: [{ primary: true, filename: name + '-' + ver + '.jar', url: 'https://cdn.modrinth.com/fake/' + name + '.jar', hashes: { sha1: null } }],
});

// ---- engine under test ------------------------------------------------------
const settingsMod = require('../src/main/core/settings');
const client = require('../src/main/core/client');
const paths = require('../src/main/core/paths');

(async () => {
  console.log('— Neurax Client engine probe —');

  // settings v3 migration: fullscreen default flips ON
  settingsMod.load();
  ok(settingsMod.get().version === 3, 'settings migrated to v3');
  ok(settingsMod.get().playFullscreen === true, 'v3 migration: playFullscreen defaults ON');
  ok(settingsMod.get().neuraxClient === true && settingsMod.get().clientFpsMode === 'ultra' && settingsMod.get().clientGuiTheme === 'auto', 'v3 defaults: neuraxClient/ultra/auto');
  settingsMod.set({ playFullscreen: false });
  settingsMod.save();
  settingsMod.load();
  ok(settingsMod.get().playFullscreen === false, 'existing explicit choice survives migration reload');

  // fake Modrinth data: 26.3 has sodium/lithium; entityculling/krypton missing (like reality)
  fakeVersions = {
    'sodium': [jar('sodium', 'mc26.3-0.9.2-fabric')],
    'lithium': [jar('lithium', 'mc26.3-0.3.2-fabric')],
    'iris': [jar('iris', '1.11.6+26.3')],
    'fabric-api': [jar('fabric-api', '0.161.0+26.3')],
    'ferrite-core': [jar('ferrite-core', '9.0.0-fabric')],
    'immediatelyfast': [jar('immediatelyfast', '1.17.1+26.3')],
    'entityculling': [],       // no build for 26.3
    'krypton': [],             // no build for 26.3
    'dynamic-fps': [jar('dynamic-fps', '3.11.10')],
    'c2me-fabric': [jar('c2me-fabric', '0.4.2-alpha.26.3')],
    'sodium-extra': [jar('sodium-extra', 'mc26.3-0.3.9-fabric')],
  };
  for (const [slug, vs] of Object.entries(fakeVersions)) {
    for (const v of vs) {
      const buf = Buffer.from('fake-jar-' + slug);
      v.files[0].hashes = { sha1: sha1(buf) };
      fakeFiles.set(v.files[0].url, { buffer: buf });
    }
  }

  console.log('1) resolveStack (ultra, 26.3) — downloads + sha1 + skips');
  const r1 = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'ultra' });
  ok(r1.injected === true, 'injected=true');
  ok(r1.mods.length === 9, `9/11 mods resolved (entityculling+krypton skipped for 26.3) — got ${r1.mods.length}`);
  ok(r1.mods.some(m => m.slug === 'c2me-fabric'), 'ultra includes C2ME (fast chunks)');
  ok(r1.mods.some(m => m.slug === 'iris'), 'ultra includes Iris (shaders)');
  ok(r1.fromCache === false, 'first resolve is fresh');

  console.log('2) cache hit within TTL — no network');
  const r2 = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'ultra' });
  ok(r2.fromCache === true && r2.mods.length === 9, 'second resolve served from cache');

  console.log('3) balanced mode excludes ultra-only mods');
  const r3 = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'balanced' });
  ok(r3.mods.length === 7, `balanced = 7 mods — got ${r3.mods.length}`);
  ok(!r3.mods.some(m => m.slug === 'c2me-fabric') && !r3.mods.some(m => m.slug === 'sodium-extra'), 'balanced excludes C2ME/Sodium Extra');

  console.log('4) fabric.addMods token format');
  const arg = client.fabricAddModsArg(r1.mods);
  ok(arg !== null, 'addMods token produced for a resolved stack');
  ok(arg.startsWith('-Dfabric.addMods='), 'token starts with -Dfabric.addMods=');
  const pathsPart = arg.slice('-Dfabric.addMods='.length);
  ok(pathsPart.split(path.delimiter).length === 9, '9 jar paths joined with the OS path delimiter');
  ok(pathsPart.split(path.delimiter).every(p => fs.existsSync(p)), 'every referenced jar exists on disk');

  console.log('5) perf JVM args');
  const ultra = client.perfJvmArgs('ultra'), bal = client.perfJvmArgs('balanced');
  ok(ultra[0] === '-XX:+UnlockExperimentalVMOptions', 'experimental unlock comes FIRST');
  ok(ultra.some(a => a.startsWith('-XX:MaxGCPauseMillis')), 'G1 pause target present');
  ok(ultra.length > bal.length, 'ultra strictly stronger than balanced');
  ok(ultra.every(a => a.startsWith('-XX') || a.startsWith('-D')), 'only JVM flags (no game args mixed in)');

  console.log('6) offline fallback — stale cache still injects');
  fakeVersions = {}; // network gone
  const r6 = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'ultra', force: true });
  ok(r6.mods.length === 0 && r6.injected === false, 'forced re-resolve offline -> clean skip, no throw');
  const r6b = await client.resolveStack({ gameVersion: '26.3', fpsMode: 'ultra' });
  ok(r6b.injected === true && r6b.mods.length === 9, 'non-forced resolve after TTL still serves cached files');

  console.log('7) never-blocks-launch: prepareLaunch with dead network');
  const gameDir = path.join(NEURAX, 'testgame');
  fs.mkdirSync(gameDir, { recursive: true });
  settingsMod.set({ theme: 'purple', clientGuiTheme: 'auto', neuraxClient: true, clientFpsMode: 'ultra' });
  const prep = await client.prepareLaunch({ gameDir, gameVersion: '26.3', loader: 'fabric' });
  ok(Array.isArray(prep.customArgs) && prep.customArgs.length > 0, 'perf args survive network failure');
  ok(prep.pack === 'neurax-ui-purple', 'GUI pack applied (auto->launcher theme purple)');
  ok(prep.addModsArg !== null, 'cached stack still injected offline (7-day files exist)');

  console.log('8) GUI pack install + options.txt idempotency');
  const packDir = path.join(gameDir, 'resourcepacks', 'neurax-ui-purple');
  ok(fs.existsSync(path.join(packDir, 'pack.mcmeta')), 'pack.mcmeta copied');
  ok(fs.existsSync(path.join(packDir, 'assets', 'minecraft', 'textures', 'gui', 'sprites', 'widget', 'button.png')), 'sprites copied');
  const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.mcmeta'), 'utf8'));
  ok(meta.pack.supported_formats && meta.pack.supported_formats.max_inclusive >= 999, 'supported_formats range covers future pack formats');
  const optFile = path.join(gameDir, 'options.txt');
  const readPacks = () => JSON.parse(fs.readFileSync(optFile, 'utf8').split('\n').find(l => l.startsWith('resourcePacks:')).slice('resourcePacks:'.length));
  let pk = readPacks();
  ok(pk[0] === 'vanilla' && pk[1] === 'file/neurax-ui-purple', 'vanilla first, pack enabled second');
  client.applyGuiTheme({ gameDir, theme: 'purple' }); // apply again
  client.applyGuiTheme({ gameDir, theme: 'cyan' });   // switch theme
  pk = readPacks();
  ok(pk[1] === 'file/neurax-ui-cyan' && !pk.includes('file/neurax-ui-purple'), 'theme switch replaces the old neurax pack, keeps user packs');
  const before = readPacks();
  client.applyGuiTheme({ gameDir, theme: 'cyan' });
  ok(JSON.stringify(readPacks()) === JSON.stringify(before), 'idempotent: re-apply does not duplicate');

  console.log('9) vanilla/forge launches: no injection, perf args + pack still applied');
  const prep2 = await client.prepareLaunch({ gameDir, gameVersion: '26.3', loader: 'vanilla' });
  ok(prep2.addModsArg === null, 'no fabric.addMods for vanilla');
  ok(prep2.customArgs.length > 0, 'perf args applied for vanilla too');

  console.log('10) client disabled -> pure vanilla behavior');
  settingsMod.set({ neuraxClient: false });
  const prep3 = await client.prepareLaunch({ gameDir, gameVersion: '26.3', loader: 'fabric' });
  ok(prep3.addModsArg === null, 'disabled client injects nothing');
  settingsMod.set({ neuraxClient: true });

  console.log('11) status() shape for the Settings UI');
  const st = client.status();
  ok(st.supportedVersions.includes('26.3') && st.supportedVersions.includes('1.21.11'), 'supported versions listed');
  ok(st.stack.length === 12 && st.stack.every(m => m.purpose) && st.stack[0].slug === 'nx', 'stack metadata complete (12 incl. bundled NX first)');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
