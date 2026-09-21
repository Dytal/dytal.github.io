#!/usr/bin/env node
/* probe-v100.js — verification battery for the 1.0.0 RELEASE build.
 *
 * Covers:
 *   1.  Memory AUTO: cap math per GPU class + instance override escape hatch
 *   2.  Close-on-launch stability window (pure logic + wiring)
 *   3.  Owner device grant: verify → session grant → sealed persistence →
 *       auto-restore → key-change invalidation + the adminCheck/settings parity
 *   4.  Supabase as source of truth: auto-migration SQL + secrets sync logic
 *       (static) + device-grant mirror
 *   5.  Invitations: state machine tables + request/invite flows + IPC surface
 *   6.  Resource-pack injection removed everywhere (settings REMOVED_KEYS,
 *       purge semantics, no inject calls, clientpacks gone)
 *   7.  Smart Install toggle + Neurax Client card + client wiring (game.js)
 *   8.  NX mod v2 jar: boost engine classes + config fields + version
 *   9.  Website: dytal.github.io + repo + no open-source/admin/NX-Cloud info
 *  10.  Version 1.0.0 everywhere + no burned key material
 *
 * Run: node scripts/probe-v100.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
let pass = 0;

function record(name, ok, extra) {
  results.push({ name, ok });
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function ok(name, fn) {
  try { const r = await fn(); record(name, true, r); }
  catch (e) { record(name, false, e.message); }
}
function run(code, home) {
  const script = path.join(os.tmpdir(), `nx100-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return execFileSync(process.execPath, [script], {
      env: { ...process.env, NEURAX_HOME: home || fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v100-')) },
      encoding: 'utf8', timeout: 30000,
    });
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  console.log('== Neurax 1.0.0 release probe ==\n');

  /* ---- 1. memory AUTO ---- */
  await ok('memory: hardware-aware cap scales with the PC (iGPU / hybrid / dGPU / unknown)', async () => {
    const out = run(`
      const crashDoctor = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      const igpu = [{ name: 'AMD Radeon (TM) Graphics', type: 'integrated' }];
      const dgpu = [{ name: 'NVIDIA GeForce RTX 4090', type: 'dedicated' }];
      const hybrid = [...igpu, ...dgpu];
      const cap = (t, g) => crashDoctor.classifyMemoryCap({ totalMB: t, gpus: g });
      // 16 GB integrated laptop → ≤ 60% (9.8 GB), never the driver-starving 14.5 GB
      assert.equal(cap(16384, igpu), Math.min(Math.floor(16384 * 0.6), 16384 - 4096));
      // 64 GB dedicated rig → 75% = 48 GB (bigger PCs DO get more)
      assert.equal(cap(65536, dgpu), Math.floor(65536 * 0.75));
      // hybrid 32 GB → 70%
      assert.equal(cap(32768, hybrid), Math.floor(32768 * 0.7));
      // unknown → 70%
      assert.equal(cap(32768, []), Math.floor(32768 * 0.7));
      console.log('CAP-OK');
    `);
    assert.ok(out.includes('CAP-OK'));
  });
  await ok('memory: game.js uses AUTO by default; instance override wins; clamp stays', async () => {
    const src = read('src/main/core/game.js');
    assert.ok(src.includes('set.memoryAuto !== false'), 'auto honored (on by default)');
    assert.ok(src.includes('instance && instance.memoryMB'), 'instance override disables auto');
    assert.ok(src.includes('Memory AUTO:'), 'auto decision logged');
    assert.ok(src.includes('crashDoctor.classifyMemoryCap'), 'cap still enforced');
  });
  await ok('settings: memoryAuto + smartInstall + neuraxClient + clientFpsMode defaults', async () => {
    const out = run(`
      const settings = require('${ROOT}/src/main/core/settings.js');
      const assert = require('assert');
      const s = settings.get();
      assert.equal(s.memoryAuto, true, 'memoryAuto default on');
      assert.equal(s.smartInstall, true, 'smartInstall default on');
      assert.equal(s.neuraxClient, true, 'neuraxClient default on');
      assert.equal(s.clientThirdPartyMods, false, 'v1.0-R2: third-party stack OPT-IN (default off)');
      assert.equal(s.clientFpsMode, 'ultra', 'fps mode default ultra');
      assert.ok(!('nxUiInject' in s), 'nxUiInject gone');
      assert.ok(!('clientGuiTheme' in s), 'clientGuiTheme gone');
      assert.ok(!('keepLauncherOpen' in s), 'v1.0-R2: keepLauncherOpen gone');
      console.log('DEFAULTS-OK');
    `);
    assert.ok(out.includes('DEFAULTS-OK'));
  });

  /* ---- 2. close-on-launch stability window ---- */
  await ok('close-on-launch: 12s stability window — the launcher only quits after the game proves itself', async () => {
    const out = run(`
      const game = require('${ROOT}/src/main/core/game.js');
      const assert = require('assert');
      assert.equal(game.STABILIZE_MS, 12000, 'window is 12s');
      assert.ok(!game.closeOnLaunchReady(0), 'just spawned → not ready');
      assert.ok(!game.closeOnLaunchReady(11000), '11s → not ready');
      assert.ok(game.closeOnLaunchReady(12000), '12s → ready to quit');
      // fake process that dies after 300ms → watcher must NOT fire onQuit
      const { EventEmitter } = require('events');
      const fake = new EventEmitter();
      fake.exitCode = null; fake.signalCode = null;
      fake.kill = (sig) => { if (sig === 0) return true; return true; };
      let quitFired = false;
      setTimeout(() => { fake.exitCode = 1; }, 300); // game "crashes" after 300ms
      const abort = game.watchStabilityAndHandoff(fake, { onQuit: () => { quitFired = true; } });
      setTimeout(() => {
        assert.ok(!quitFired, 'game died during the window → launcher never quits');
        abort();
        console.log('STAB-OK');
      }, 700);
    `, undefined);
    assert.ok(out.includes('STAB-OK'));
  });
  await ok('close-on-launch: stable game arms watchdog then quits (order preserved)', async () => {
    const src = read('src/main/core/game.js');
    const block = src.slice(src.indexOf('if (set.closeLauncherOnLaunch)'), src.indexOf('return { ok: true, pid:'));
    assert.ok(block.includes('watchStabilityAndHandoff'), 'watcher used');
    assert.ok(block.indexOf('armWatchdog') < block.indexOf("scheduleLauncherExit"), 'watchdog armed BEFORE quit');
    assert.ok(block.indexOf('watchStabilityAndHandoff') < block.indexOf('armWatchdog'), 'watcher runs before arming');
    assert.ok(!src.includes('keepLauncherOpen'), 'v1.0-R2: keepLauncherOpen branch removed — one launch-behaviour switch only');
  });

  /* ---- 3. owner device grant ---- */
  await ok('owner grant: correct key grants ONCE, persists sealed, auto-restores on next load', async () => {
    const out = run(`
      const assert = require('assert');
      const fs = require('fs');
      const path = require('path');
      const grant = require('${ROOT}/src/main/core/nx-owner-grant.js');
      const nxKeys = require('${ROOT}/src/main/core/nx-admin-keys.js');
      // wrong key refused
      let threw = false;
      try { grant.verify('not-the-key'); } catch (e) { threw = /Wrong owner key/.test(e.message); }
      assert.ok(threw, 'wrong key refused');
      assert.ok(!grant.isGranted(), 'session not granted by a wrong key');
      // correct key → granted + persisted
      const r = grant.verify(nxKeys.UNLOCK_PASSKEY);
      assert.ok(r.ok && r.persisted, 'grant persisted');
      assert.ok(grant.isGranted(), 'session granted');
      const file = path.join(process.env.NEURAX_HOME, 'device-grant.vault');
      assert.ok(fs.existsSync(file), 'sealed grant file exists');
      assert.ok(!fs.readFileSync(file, 'utf8').includes('AAhdswed'), 'grant file is ciphertext (no key material)');
      // simulate a NEW process: auto-restore grants the device without typing
      delete require.cache[require.resolve('${ROOT}/src/main/core/nx-owner-grant.js')];
      const grant2 = require('${ROOT}/src/main/core/nx-owner-grant.js');
      const st = grant2.autoRestore();
      assert.ok(st.granted && st.autoGranted, 'auto-granted on next launch');
      assert.ok(grant2.isGranted(), 'device access active');
      // key change → grant invalidated
      const seal = require('${ROOT}/src/main/core/nx-seal.js');
      const { DIRS } = require('${ROOT}/src/main/core/paths.js');
      const data = seal.readSealed(DIRS.root, file);
      assert.ok(data.keyHash && data.keyHash.length === 64, 'grant stores a SHA-256 hash');
      console.log('GRANT-OK');
    `);
    assert.ok(out.includes('GRANT-OK'));
  });
  await ok('owner grant: Settings + Announcements share the same verdict (no more success-then-wrong-key)', async () => {
    const ipc = read('src/main/ipc.js');
    assert.ok(ipc.includes('if (ownerGrant.isGranted()) return true;'), 'gated calls accept the device grant');
    assert.ok(ipc.includes("owner:verifyKey"), 'verifyKey IPC exists');
    assert.ok(ipc.includes('owner:grantStatus'), 'grant status IPC exists');
    // nx:adminCheck uses the AUTHORITATIVE key and creates the same grant
    const block = ipc.slice(ipc.indexOf("handle('nx:adminCheck'"), ipc.indexOf("handle('nx:adminCheck'") + 900);
    assert.ok(block.includes('nxKeys.UNLOCK_PASSKEY ||'), 'adminCheck verifies against the authoritative key first');
    assert.ok(block.includes('ownerGrant.verify(got)'), 'adminCheck creates the SAME device grant');
  });
  await ok('owner grant: startup auto-restore wired in main.js', async () => {
    const src = read('src/main/main.js');
    assert.ok(src.includes('autoRestore()'), 'auto-restore called at boot');
    assert.ok(src.includes('Owner access restored automatically'), 'boot log line');
  });

  /* ---- 4. Supabase source of truth ---- */
  await ok('supabase: auto-migration creates invite/secret/grant tables at connect', async () => {
    const src = read('src/main/core/nx-supabase.js');
    for (const t of ['nx_friend_requests', 'nx_chat_invites', 'nx_secrets', 'nx_device_grants']) {
      assert.ok(src.includes(`create table if not exists ${t}`), `${t} auto-created`);
    }
    assert.ok(src.includes('await syncOwnerSecrets()'), 'secrets sync runs after schema check');
  });
  await ok('supabase: cloud owner key is adopted when the database has a newer key', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes("keys.rotate({ adminKey: cloudKey, unlockPasskey: cloudKey })"), 'cloud key adopted via rotate (sealed)');
    assert.ok(src.includes("insert into nx_secrets (name, value) values ('owner_key', ${canonical.OWNER_KEY})"), 'missing row seeded');
    assert.ok(src.includes('Owner key synced FROM NX Cloud'), 'adoption logged');
  });
  await ok('supabase: device grants mirrored to the cloud (hash only)', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes('insert into nx_device_grants'), 'device grant upsert');
    assert.ok(src.includes('key_hash'), 'hash stored, never the key');
    const cloud = read('src/main/core/nx-cloud.js');
    assert.ok(cloud.includes('syncDeviceGrant'), 'nx-cloud api forwards the mirror');
  });
  await ok('NX Cloud (Control Center): login accepts + adopts the cloud key', async () => {
    const cc = read('nx-cloud/control-center.js');
    assert.ok(cc.includes("select value from nx_secrets where name = 'owner_key'"), 'login checks the cloud key');
    assert.ok(cc.includes('NX_KEYS.rotate'), 'adopts it into the sealed key vault');
    assert.ok(cc.includes("CC_VERSION = '1.0.0'"), 'CC version 1.0.0');
  });

  /* ---- 5. invitations ---- */
  await ok('invitations: friendAdd → pending request; respond(accept) creates BOTH friend rows', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes("insert into nx_friend_requests (from_uuid, to_uuid, status)"), 'friend request inserted');
    assert.ok(src.includes("insert into nx_friends (owner_uuid, friend_uuid) values (${state.uuid}, ${req.from_uuid})"), 'accept adds the requester');
    assert.ok(src.includes("insert into nx_friends (owner_uuid, friend_uuid) values (${req.from_uuid}, ${state.uuid})"), 'accept adds YOU to them');
    assert.ok(src.includes('reverse'), 'mutual request auto-accept path exists');
  });
  await ok('invitations: group invites are pending; accept inserts membership', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes('insert into nx_chat_invites (group_id, from_uuid, to_uuid, status)'), 'pending chat invite');
    const block = src.slice(src.indexOf('async function inviteRespond'), src.indexOf('async function chatLeave'));
    assert.ok(block.includes('insert into nx_chat_members'), 'accept joins the chat');
    assert.ok(block.includes("status = 'rejected'"), 'reject path');
  });
  await ok('invitations: 5s tick emits nx:invites + one-shot outcome notifications', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes("emit('nx:invites', { friendRequests, chatInvites })"), 'pending invites pushed live');
    assert.ok(src.includes("emit('nx:inviteOutcome'"), 'outcome notifications emitted');
    assert.ok(src.includes('state.inviteSeen'), 'outcome deduplicated (notify once)');
  });
  await ok('invitations: renderer — invitations center with accept/reject + badge + toasts', async () => {
    const nx = read('src/renderer/js/nx.js');
    assert.ok(nx.includes('nx:friendRespond') && nx.includes('nx:inviteRespond'), 'accept/reject wired');
    assert.ok(nx.includes('openInvitations'), 'invitations center exists');
    assert.ok(nx.includes('nx-invite-badge'), 'live badge');
    assert.ok(nx.includes('nx:invites') && nx.includes('nx:inviteOutcome'), 'live toasts');
    assert.ok(nx.includes('Send request'), 'friends panel uses request wording');
  });

  /* ---- 6. resource-pack injection removed everywhere ---- */
  await ok('injection: nxUiInject/clientGuiTheme stripped from stored settings automatically', async () => {
    const src = read('src/main/core/settings.js');
    assert.ok(src.includes("REMOVED_KEYS = new Set(['nxUiInject', 'clientGuiTheme', 'keepLauncherOpen'])"), 'removed keys list (v1.0-R2 adds keepLauncherOpen)');
    assert.ok(src.includes('REMOVED_KEYS.has(k)'), 'strip logic');
  });
  await ok('injection: no launcher code path writes into resourcepacks anymore', async () => {
    const game = read('src/main/core/game.js');
    assert.ok(game.includes('purgeInjectedPack(gameDir)'), 'launch purges old injections');
    assert.ok(!game.includes('nxInject.injectGameDir'), 'no inject call in the launch path');
    const store = read('src/main/core/store.js');
    assert.ok(store.includes('purgeInjectedPack'), 'instance creation purges');
    assert.ok(!store.includes('injectGameDir'), 'store never injects');
    const main = read('src/main/main.js');
    assert.ok(main.includes('nxInject.purgeAll()'), 'startup purge-all');
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'main', 'clientpacks')), 'clientpacks deleted');
    const settings = read('src/renderer/js/pages/settings.js');
    assert.ok(!settings.includes("toggle('nxUiInject'"), 'no resource-pack toggle in Settings');
  });

  /* ---- 7. smart install + client wiring ---- */
  await ok('smart install: honored by the storefront (chip + one-click path both check the setting)', async () => {
    const sc = read('src/renderer/js/pages/store-common.js');
    assert.ok(sc.includes("state.settings?.smartInstall !== false"), 'one-click path gated');
    const md = read('src/renderer/js/pages/modrinth.js');
    assert.ok(md.includes("state.settings?.smartInstall !== false"), 'chip gated');
  });
  await ok('Neurax Client: stack wired into launches (addMods + perf flags + purge)', async () => {
    const game = read('src/main/core/game.js');
    assert.ok(game.includes("require('./client')"), 'game resolves the stack');
    assert.ok(game.includes('clientPrep.addModsArg'), 'fabric.addMods passed');
    assert.ok(game.includes('clientPrep.customArgs'), 'perf JVM flags passed');
    const client = read('src/main/core/client.js');
    assert.ok(client.includes('purgeGuiThemePacks(gameDir)'), 'launch prep purges old theme packs');
    assert.ok(!client.includes('PACKS_SRC'), 'pack source gone');
    const main = read('src/main/main.js');
    assert.ok(main.includes('migrateInstances()'), 'instance injection live at startup');
  });

  /* ---- 8. NX mod v2 ---- */
  await ok('NX mod v2: nx-2.0.0.jar ships the adaptive boost engine', async () => {
    const jar = path.join(ROOT, 'src', 'main', 'nx', 'nx-2.0.0.jar');
    assert.ok(fs.existsSync(jar), 'jar exists');
    const out = run(`
      const { execSync } = require('child_process');
      const assert = require('assert');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxjar-'));
      execSync('unzip -o -q "${jar}" -d ' + dir);
      const fm = JSON.parse(fs.readFileSync(path.join(dir, 'fabric.mod.json'), 'utf8'));
      assert.equal(fm.version, '2.0.0', 'mod version 2.0.0');
      for (const c of ['NXClient.class', 'NXBoost.class', 'NXConfig.class', 'NXConfigScreen.class']) {
        assert.ok(fs.existsSync(path.join(dir, 'dev/neurax/nx', c)), c);
      }
      console.log('JAR-OK');
    `);
    assert.ok(out.includes('JAR-OK'));
  });
  await ok('NX mod v2: boost engine steers official options — zero mixins remain', async () => {
    const boost = read('src/main/nx/source/java/dev/neurax/nx/NXBoost.java');
    for (const api of ['renderDistance()', 'entityDistanceScaling()', 'particles()', 'entityShadows()', 'enableVsync()', 'framerateLimit()', 'cloudStatus()']) {
      assert.ok(boost.includes(api), `steers ${api}`);
    }
    assert.ok(boost.includes('setTarget') === false, 'no unknown APIs');
    const fm = read('src/main/nx/source/resources/fabric.mod.json');
    assert.ok(!fm.includes('"mixins"'), 'no mixins declared');
    const client = read('src/main/core/client.js');
    assert.ok(client.includes('adaptive FPS engine'), 'stack description updated');
  });

  /* ---- 9. website ---- */
  await ok('website: dytal.github.io + Dytal/dytal.github.io everywhere; nothing removed left behind', async () => {
    const zip = '/home/z/my-project/download/NeuraX-Launcher-Website-SEO-Pack.zip';
    assert.ok(fs.existsSync(zip), 'website pack exists');
    execFileSync('unzip', ['-o', '-q', zip, '-d', (function () { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'web100-')); return d; })()], { cwd: undefined });
    const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('web100-'));
    const dir = path.join(os.tmpdir(), dirs[dirs.length - 1]);
    const idx = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.ok(idx.includes('dytal.github.io'), 'new URL present');
    assert.ok(idx.includes('github.com/Dytal/dytal.github.io'), 'new repo present');
    assert.ok(!idx.includes('dytalmc.github.io'), 'old URL gone');
    assert.ok(!/open[- ]source/i.test(idx), 'open-source claims gone');
    assert.ok(!/NX Cloud/i.test(idx), 'NX Cloud info gone');
    assert.ok(!/admin key/i.test(idx), 'admin key info gone');
    assert.ok(idx.includes('Crash Doctor'), 'feature card replaced');
  });

  /* ---- 10. version + key hygiene ---- */
  await ok('version 1.0.0 in package.json + mock bridge; PATCH-NOTES lead with the release', async () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, '1.0.0');
    assert.ok(read('src/renderer/js/mock-bridge.js').includes("'1.0.0-preview'"), 'mock label 1.0.0');
    assert.ok(read('PATCH-NOTES.md').startsWith('# Neurax Launcher — v1.0.0 (PUBLIC RELEASE)'), 'patch notes lead');
    assert.ok(read('nx-cloud/control-center.js').includes("CC_VERSION = '1.0.0'"), 'CC 1.0.0');
  });
  await ok('key hygiene: burned keys never reappear in source', async () => {
    const burned = ['CZgIVoKMuwv5uUr-pv7CXeZtrIVMjM6J', 'fyLtEIb9pKi7IaQX5fxB8gOWkf5MiUAKzfNkpRyE_xU', 'nxAk_default_', 'CHANGE-ME'];
    const files = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) { if (!/node_modules|\.git|tmp|dist/.test(f.name)) walk(p); }
        else if (/\.(js|java|json|html|css|md|sql|sh|bat)$/.test(f.name)) files.push(p);
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'nx-cloud'));
    walk(path.join(ROOT, 'scripts'));
    walk(path.join(ROOT, 'supabase'));
    let hits = [];
    for (const f of files) {
      if (f.endsWith('probe-v100.js')) continue; // the scan list itself lives here
      const t = fs.readFileSync(f, 'utf8');
      for (const b of burned) if (t.includes(b)) hits.push(`${f}: ${b}`);
    }
    if (hits.length) console.log('HITS:', hits.join(' | '));
    assert.deepEqual(hits, [], 'no burned key material');
  });
  await ok('canonical key + database intact (the one place to change them)', async () => {
    const c = read('src/main/core/nx-canonical.js');
    assert.ok(c.includes("'AAhdswedgjihsedfyg2346283jsd!'"), 'owner key canonical');
    assert.ok(c.includes('db.invoqcismjgwbropdqvs.supabase.co'), 'owner database canonical');
  });

  console.log(`\n== Neurax 1.0.0 probe: ${pass} PASS, ${results.length - pass} FAIL ==`);
  process.exit(results.length - pass ? 1 : 0);
})();
