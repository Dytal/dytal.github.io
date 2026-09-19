// probe-inject.js — engine tests for INSTANCE-LEVEL Neurax Client injection (v2.3.1).
// FAKE Modrinth + FAKE Fabric meta + FAKE downloads (zero network). Proves:
//   creation hook auto-injects 26.1.2 instances, vanilla->fabric upgrade writes
//   a real profile JSON, managed mods land in <instance>/.minecraft/mods while
//   user mods survive, manifest + instance metadata stay consistent, injection
//   is idempotent + single-flight, fps-mode/theme changes re-sync the managed
//   set, uninject fully restores (loader + mods + pack + options.txt),
//   out-of-scope versions and disabled settings skip cleanly, forge gets pack
//   only, migration picks up existing instances, and the launch pipeline sees
//   instance-managed mods (no double addMods).
'use strict';
const fs = require('fs');
const path = require('path');

process.env.NEURAX_HOME = '/tmp/neurax-probe-inject-' + Date.now();
const NEURAX = process.env.NEURAX_HOME;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.error('  ✗ ' + label); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- fake net + fake Modrinth + fake Fabric meta (BEFORE engine requires) ---
const net = require('../src/main/core/net');
const modrinthMod = require('../src/main/core/modrinth');
const versionsMod = require('../src/main/core/versions');
modrinthMod.getVersions = async (slug) => fakeVersions[slug] || [];
net.download = async (url, dest) => {
  const f = fakeFiles.get(url);
  if (!f) throw new Error('fake net: no file for ' + url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, f.buffer);
  return f.buffer.length;
};
versionsMod.getFabricLoaderVersions = async () => [{ loader: '0.19.5', stable: true }, { loader: '0.19.4', stable: false }];
versionsMod.installFabricClient = async (root, mc, lv) => {
  const vid = `fabric-loader-${lv}-${mc}`;
  const dir = path.join(root, 'versions', vid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${vid}.json`), JSON.stringify({ id: vid, inheritsFrom: mc, fake: true }));
  fabricInstalls++;
  return vid;
};
let fabricInstalls = 0;

const crypto = require('crypto');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const fakeFiles = new Map();
const fakeVersions = {};
const jar = (name, ver, gv) => ({
  id: 'v-' + name, version_number: ver, loaders: ['fabric'], game_versions: [gv],
  files: [{ primary: true, filename: name + '-' + ver + '.jar', url: 'https://cdn.modrinth.com/fake/' + name + '.jar', hashes: { sha1: null } }],
});
const GV = '26.1.2';
const SLUGS = ['sodium', 'lithium', 'iris', 'fabric-api', 'ferrite-core', 'immediatelyfast', 'entityculling', 'krypton', 'dynamic-fps', 'c2me-fabric', 'sodium-extra'];
const ULTRA_ONLY = new Set(['c2me-fabric', 'sodium-extra']);
for (const slug of SLUGS) {
  const v = jar(slug, '1.0.0+' + GV, GV);
  const buf = Buffer.from('fake-jar-' + slug + '-' + GV);
  v.files[0].hashes = { sha1: sha1(buf) };
  fakeFiles.set(v.files[0].url, { buffer: buf });
  fakeVersions[slug] = [v];
}

// ---- engine under test -------------------------------------------------------
const settingsMod = require('../src/main/core/settings');
const store = require('../src/main/core/store');
const client = require('../src/main/core/client');
const pathsMod = require('../src/main/core/paths');

(async () => {
  console.log('— Neurax Client INSTANCE injection probe —');
  settingsMod.load();
  settingsMod.set({ theme: 'purple', clientGuiTheme: 'auto', neuraxClient: true, clientFpsMode: 'ultra' });

  let injectedEvents = 0;
  client.setBroadcaster((channel, payload) => { if (channel === 'client:injected' && payload && !payload.already) injectedEvents++; });

  console.log('1) creation hook: vanilla 26.1.2 instance auto-injects in the background');
  const inst = store.createInstance({ name: 'Inject Me', version: GV, loader: 'vanilla' });
  let cur = null;
  for (let i = 0; i < 100 && !(cur && cur.neuraxClient && cur.neuraxClient.injected); i++) { await sleep(50); cur = store.getInstance(inst.id); }
  ok(!!(cur && cur.neuraxClient && cur.neuraxClient.injected), 'creation hook injected without any manual call');
  ok(cur.loader === 'fabric' && cur.loaderVersion === '0.19.5', `vanilla upgraded to fabric ${cur.loader}/${cur.loaderVersion}`);
  const gameDir = store.instanceGameDir(inst.id);
  const profPath = path.join(pathsMod.DIRS.minecraft, 'versions', 'fabric-loader-0.19.5-' + GV, 'fabric-loader-0.19.5-' + GV + '.json');
  ok(fs.existsSync(profPath), 'fabric profile JSON written into the shared versions root');
  const modsDir = path.join(gameDir, 'mods');
  const modFiles = fs.readdirSync(modsDir);
  ok(modFiles.length === 12, `12 managed mods (11 stack + bundled NX) copied into instance mods/ — got ${modFiles.length}`);
  ok(fs.existsSync(path.join(modsDir, 'sodium-1.0.0+' + GV + '.jar')), 'sodium jar present');
  ok(fs.existsSync(path.join(gameDir, 'resourcepacks', 'neurax-ui-purple', 'pack.mcmeta')), 'themed GUI pack installed (auto -> launcher theme purple)');
  const optLines = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  ok(optLines.includes('["vanilla","file/neurax-ui-purple"]'), 'options.txt enables the pack (vanilla first)');
  const manifest = JSON.parse(fs.readFileSync(path.join(gameDir, 'neurax-client.json'), 'utf8'));
  ok(manifest.injectorVersion === 2 && manifest.gameVersion === GV && manifest.mods.length === 12, 'manifest complete (injector v2, 12 mods incl. NX)');
  ok(manifest.baseLoader === 'vanilla' && manifest.loaderChanged === true, 'manifest remembers the vanilla->fabric upgrade');
  ok(client.hasManagedMods(store.getInstance(inst.id)) === true, 'hasManagedMods() true for the launch pipeline');
  ok(manifest.mods.some(m => m.slug === 'nx' && m.file.startsWith('nx-')), 'bundled NX core is the first managed mod');
  ok(fs.existsSync(path.join(modsDir, manifest.mods.find(m => m.slug === 'nx').file)), 'NX jar physically in the instance mods folder');
  ok(optLines.includes('maxFps:260') && optLines.includes('enableVsync:false'), 'perf options: unlimited maxFps + vsync off (ultra)');
  ok(manifest.perf && manifest.perf.maxFps === 260 && manifest.perf.vsync === false, 'manifest.perf records the FPS unlock');

  console.log('2) user mods in mods/ survive a re-inject');
  const userJar = path.join(modsDir, 'my-own-mod.jar');
  fs.writeFileSync(userJar, 'user jar');
  const re = await client.injectInstance({ instanceId: inst.id, force: true });
  ok(re.ok === true && fs.existsSync(userJar), 'user jar untouched after forced re-inject');
  ok(fs.readdirSync(modsDir).length === 13, '12 managed (incl. NX) + 1 user jar');

  console.log('3) idempotency: fresh manifest -> already:true, no re-broadcast');
  const eventsBefore = injectedEvents;
  const again = await client.injectInstance({ instanceId: inst.id });
  ok(again.already === true && again.ok === true, 'second inject is a cheap no-op');
  ok(injectedEvents === eventsBefore, 'no duplicate client:injected broadcast');

  console.log('4) single-flight: creation hook + manual injects collapse into ONE injection');
  injectedEvents = 0;
  const inst2 = store.createInstance({ name: 'Race Me', version: GV, loader: 'vanilla' });
  const [a, b] = [client.injectInstance({ instanceId: inst2.id }), client.injectInstance({ instanceId: inst2.id })];
  await Promise.all([a, b]);
  for (let i = 0; i < 60; i++) { await sleep(50); const c = store.getInstance(inst2.id); if (c.neuraxClient && c.neuraxClient.injected) break; }
  ok(injectedEvents === 1, `3 concurrent callers produced exactly 1 physical injection (got ${injectedEvents})`);

  console.log('5) fps mode change -> managed set re-syncs (ultra-only files removed)');
  settingsMod.set({ clientFpsMode: 'balanced' });
  const bal = await client.injectInstance({ instanceId: inst.id });
  ok(bal.ok === true && !bal.already, 'stale manifest triggers a real re-inject');
  const managedNow = JSON.parse(fs.readFileSync(path.join(gameDir, 'neurax-client.json'), 'utf8')).mods;
  ok(managedNow.length === 10, `balanced stack = 10 managed mods (9 stack + NX) — got ${managedNow.length}`);
  ok(!fs.existsSync(path.join(modsDir, 'c2me-fabric-1.0.0+' + GV + '.jar')) && !fs.existsSync(path.join(modsDir, 'sodium-extra-1.0.0+' + GV + '.jar')), 'ultra-only jars removed from the instance');
  ok(fs.existsSync(userJar), 'user jar still untouched');
  settingsMod.set({ clientFpsMode: 'ultra' });
  await client.injectInstance({ instanceId: inst.id, force: true });

  console.log('6) theme change -> GUI pack swapped in options.txt');
  settingsMod.set({ theme: 'cyan' });
  await client.injectInstance({ instanceId: inst.id, force: true });
  const packs = JSON.parse(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8').split('\n').find(l => l.startsWith('resourcePacks:')).slice('resourcePacks:'.length));
  ok(packs[1] === 'file/neurax-ui-cyan' && !packs.includes('file/neurax-ui-purple'), 'cyan pack enabled, purple replaced');
  settingsMod.set({ theme: 'purple' });
  await client.injectInstance({ instanceId: inst.id, force: true });

  console.log('7) uninject restores everything (except user mods)');
  const un = await client.uninjectInstance({ instanceId: inst.id });
  ok(un.ok === true && un.removedMods === 12, `12 managed mods deleted — got ${un.removedMods}`);
  ok(fs.existsSync(userJar), 'user jar SURVIVES uninject');
  ok(fs.readdirSync(modsDir).filter(f => f !== 'my-own-mod.jar').length === 0, 'no managed jars left');
  const cur2 = store.getInstance(inst.id);
  ok(cur2.loader === 'vanilla' && cur2.loaderVersion === null, 'instance restored to vanilla loader');
  ok(!fs.existsSync(path.join(gameDir, 'neurax-client.json')), 'manifest deleted');
  ok(!fs.existsSync(path.join(gameDir, 'resourcepacks', 'neurax-ui-cyan')), 'pack folder removed');
  const optAfter = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
  ok(!optAfter.includes('neurax-ui'), 'options.txt cleaned');
  ok(client.hasManagedMods(cur2) === false, 'hasManagedMods() false again');

  console.log('8) out-of-scope version skips cleanly');
  const other = store.createInstance({ name: 'Old', version: '1.21.4', loader: 'vanilla' });
  const sk = await client.injectInstance({ instanceId: other.id, force: true });
  ok(sk.ok === false && sk.skipped === true && /not in scope/.test(sk.reason), '1.21.4 instance: clean skip with reason');

  console.log('9) forge instance: pack only, loader untouched, no fabric mods');
  const forgeInst = store.createInstance({ name: 'Forge 26', version: GV, loader: 'forge', loaderVersion: '59.0.42' });
  await sleep(250); // creation hook evaluates scope then skips mods for forge
  const fr = await client.injectInstance({ instanceId: forgeInst.id, force: true });
  ok(fr.ok === true && !fr.mods, 'no fabric mods injected into forge');
  ok(/Forge/.test(fr.modsWarning || ''), 'clear modsWarning for forge');
  ok(store.getInstance(forgeInst.id).loader === 'forge', 'forge loader untouched');
  ok(fs.existsSync(path.join(store.instanceGameDir(forgeInst.id), 'resourcepacks', 'neurax-ui-purple', 'pack.mcmeta')), 'GUI pack still applied to forge instance');

  console.log('10) disabled in Settings -> everything skips');
  settingsMod.set({ neuraxClient: false });
  const dis = await client.injectInstance({ instanceId: inst2.id, force: true });
  ok(dis.ok === false && dis.skipped === true && /disabled/.test(dis.reason), 'disabled client: clean skip');
  settingsMod.set({ neuraxClient: true });

  console.log('11) migration: existing un-injected instance gets picked up; second run is a no-op');
  const existing = store.createInstance({ name: 'Pre-existing', version: GV, loader: 'vanilla' });
  // remove what the creation hook did so migration starts from scratch
  await client.uninjectInstance({ instanceId: existing.id });
  store.updateInstance(existing.id, { loader: 'vanilla', loaderVersion: null });
  const mig = await client.migrateInstances();
  ok(mig.targets === 4, `migration found 4 in-scope instances (Inject Me, Race Me, Forge 26, Pre-existing) — got ${mig.targets}`);
  ok(mig.results.every(r => r.ok || r.skipped), 'every migration step ok/clean-skip');
  const pre = store.getInstance(existing.id);
  ok(pre.neuraxClient && pre.neuraxClient.injected && pre.loader === 'fabric', 'pre-existing instance injected by migration');
  const mig2 = await client.migrateInstances();
  ok(mig2.injected === 0, 'second migration: everything already fresh (0 re-injected, forge included)');

  console.log('12) launch pipeline: instance-managed -> no addMods, perf args + pack still applied');
  const prep = await client.prepareLaunch({
    gameDir: store.instanceGameDir(existing.id), gameVersion: GV, loader: 'fabric', instanceManaged: true,
  });
  ok(prep.addModsArg === null, 'NO -Dfabric.addMods (mods already in the instance mods folder)');
  ok(prep.customArgs.length > 0 && prep.customArgs[0] === '-XX:+UnlockExperimentalVMOptions', 'G1GC perf flags still applied');
  ok(prep.pack === 'neurax-ui-purple', 'GUI pack still refreshed at launch');

  console.log('13) status() exposes the rollout for the Settings UI');
  const st = client.status();
  ok(Array.isArray(st.instanceScope) && st.instanceScope.includes(GV), 'instanceScope listed');
  ok(st.instances.length >= 3 && st.instances.every(i => i.version === GV), 'per-instance summary listed');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
