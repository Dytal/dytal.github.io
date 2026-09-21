#!/usr/bin/env node
// probe-v44.js — headless probes for the v4.4.0 patch (plain Node, no Electron).
//
// Covers the headline changes:
//   1. OWNER KEYS sealed: .neurax/keys.vault replaces the plaintext
//      nx-keys.local.json — imported once, then SHREDDED (smoke-nx-keys.js
//      covers the full subprocess matrix; here we check the module surface).
//   2. .neurax deletable again: no deny-ACL protection inside .neurax,
//      lock file hidden-only, token-vault removal clears the read-only flag.
//   3. Close launcher on launch: zero-footprint watchdog script builder.
//   4. Offline-first NX Cloud: pickMode() logic + friendly supabaseOnly text.
//   5. Owner Console: IPC channels + renderer card.
//
// Functional tests run in isolated temp homes; static checks read sources.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v44-'));
}

/** Run code in a subprocess bound to an isolated NEURAX_HOME. */
function run(code, home) {
  const script = path.join(os.tmpdir(), `nx44-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return execFileSync(process.execPath, [script], {
      env: { ...process.env, NEURAX_HOME: home, NEURAX_KEYS_FILE: path.join(home, 'nx-keys.local.json') },
      encoding: 'utf8', timeout: 30000,
    });
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}

(async () => {
  console.log('== v4.4.0 probe suite ==\n');

  /* ---- 1. versions consistent (era-independent) ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    assert.ok(read('PATCH-NOTES.md').startsWith('# Neurax Launcher — v' + pkg.version), 'patch notes head matches ' + pkg.version);
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes(`'${pkg.version}-preview'`), 'mock-bridge preview label bumped');
  });

  /* ---- 2. nx-seal: the stdlib-only sealed-file core ---- */
  await ok('nx-seal: round-trip, tamper quarantine, plaintext shred', async () => {
    const seal = require('../src/main/core/nx-seal.js');
    const home = freshHome();
    const file = path.join(home, 'probe.vault');
    assert.equal(seal.readSealed(home, file), null, 'missing file reads null');
    seal.writeSealed(home, file, { hello: 'world', n: 7 });
    let raw = fs.readFileSync(file);
    assert.ok(raw.subarray(0, 6).equals(seal.MAGIC), 'NXVB1 magic');
    assert.ok(!raw.toString('latin1').includes('hello'), 'ciphertext at rest');
    assert.deepEqual(seal.readSealed(home, file), { hello: 'world', n: 7 }, 'round-trip');
    const st = fs.statSync(file);
    assert.ok(!(st.mode & 0o222), 'sealed file locked read-only at rest');
    // attacker edits the file (chmod first — that is exactly what the read-only lock resists)
    fs.chmodSync(file, 0o646); raw[20] ^= 0xff; fs.writeFileSync(file, raw);
    assert.equal(seal.readSealed(home, file), null, 'tamper → quarantine + null');
    assert.ok(fs.readdirSync(home).some((f) => f.includes('.corrupt-')), 'corrupt file quarantined');
    const plain = path.join(home, 'plain.txt');
    fs.writeFileSync(plain, 'SECRET-PLAINTEXT-CONTENT');
    assert.equal(seal.shredPlaintext(plain), true, 'shred ok');
    assert.ok(!fs.existsSync(plain), 'plaintext gone');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await ok('END-TO-END (2 sessions): fresh home → vault seeds → keys SEALED, no readable key file', async () => {
    const home = freshHome();
    const MOD = path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js');
    const KEYS = path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js');
    const SEAL = path.join(ROOT, 'src', 'main', 'core', 'nx-seal.js');
    const open = `const v = require(${JSON.stringify(MOD)}); v.launcherVault();`;
    // session 1: fresh machine — vault is seeded with the module's pending keys
    run(`${open}\nconsole.log('s1 ok');`, home);
    // session 2: the vault exists → adoption persists the SEALED key vault
    const out = run(`
      const v = require(${JSON.stringify(MOD)});
      const k = require(${JSON.stringify(KEYS)});
      const fs = require('fs'); const path = require('path'); const seal = require(${JSON.stringify(SEAL)});
      const root = process.env.NEURAX_HOME;
      const mem = v.launcherVault().get();
      const kv = path.join(root, 'keys.vault');
      const sealed = seal.readSealed(root, kv);
      console.log(JSON.stringify({
        src: k.KEYS_SOURCE, sealedExists: fs.existsSync(kv),
        plainGone: !fs.existsSync(path.join(root, 'nx-keys.local.json')),
        keysSealed: !!(sealed && sealed.adminKey && sealed.unlockPasskey),
        match: !!(sealed && sealed.adminKey === k.ADMIN_KEY && mem.adminKey === k.ADMIN_KEY),
      }));
    `, home);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.src, 'sealed', 'source becomes sealed');
    assert.ok(j.sealedExists && j.plainGone && j.keysSealed && j.match, JSON.stringify(j));
    const raw = fs.readFileSync(path.join(home, 'keys.vault'), 'latin1');
    assert.ok(!raw.includes('"adminKey":'), 'no plaintext key fields at rest');
    fs.rmSync(home, { recursive: true, force: true });
  });

  /* ---- 3. keys module: sealed storage surface + no plaintext writes ---- */
  await ok('nx-admin-keys: sealed keys.vault is the storage, no .neurax plaintext key file', async () => {
    const src = read('src/main/core/nx-admin-keys.js');
    assert.ok(src.includes("VAULT_NAME = 'keys.vault'"), 'keys.vault constant');
    assert.ok(src.includes('seal.writeSealed') && src.includes('seal.readSealed'), 'sealed read/write used');
    assert.ok(src.includes('shredPlaintext') || src.includes('seal.shredPlaintext'), 'legacy plaintext shredded');
    assert.ok(!src.includes('writeKeysTo'), 'old plaintext writer is gone');
    const k = require('../src/main/core/nx-admin-keys.js');
    assert.equal(typeof k.rotate, 'function', 'rotate() exported');
    assert.equal(typeof k.generateKeys, 'function', 'generateKeys() exported');
    assert.equal(typeof k.sealedKeysFile, 'function', 'sealedKeysFile() exported');
    assert.ok(k.KEYS_SOURCE.length > 0, 'KEYS_SOURCE resolves');
  });

  await ok('END-TO-END: legacy plaintext nx-keys.local.json → sealed + shredded', async () => {
    const home = freshHome();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'nx-keys.local.json'), JSON.stringify({ adminKey: 'PLAINTEXT-LEGACY-ADMIN-KEY-1', unlockPasskey: 'PLAINTEXT-LEGACY-PASS-0000001' }));
    const MOD = path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js');
    const KEYS = path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js');
    const SEAL = path.join(ROOT, 'src', 'main', 'core', 'nx-seal.js');
    const out = run(`
      const v = require(${JSON.stringify(MOD)});
      const k = require(${JSON.stringify(KEYS)});
      const fs = require('fs'); const path = require('path'); const seal = require(${JSON.stringify(SEAL)});
      const root = process.env.NEURAX_HOME;
      v.launcherVault();
      const sealed = seal.readSealed(root, path.join(root, 'keys.vault'));
      console.log(JSON.stringify({ src: k.KEYS_SOURCE, a: k.ADMIN_KEY,
        plainGone: !fs.existsSync(path.join(root, 'nx-keys.local.json')),
        sealedOk: !!(sealed && sealed.adminKey === k.ADMIN_KEY) }));
    `, home);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.src, 'sealed', 'sealed after migration');
    assert.equal(j.a, 'PLAINTEXT-LEGACY-ADMIN-KEY-1', 'keys imported unchanged');
    assert.ok(j.plainGone, 'readable key file inside .neurax SHREDDED');
    assert.ok(j.sealedOk, 'sealed vault carries the keys');
    fs.rmSync(home, { recursive: true, force: true });
  });

  /* ---- 4. .neurax deletable: protections fixed ---- */
  await ok('device-identity: soft protection inside .neurax + self-heal + unprotectAll', async () => {
    const src = read('src/main/core/device-identity.js');
    assert.ok(src.includes('softProtectWin'), 'soft (hidden-only) Windows protection exists');
    assert.ok(src.includes('unprotectFallbackIfHardened'), 'deny-ACL self-heal runs');
    assert.ok(src.includes('unprotectAll'), 'owner unlock exported');
    const identity = require('../src/main/core/device-identity.js');
    assert.equal(typeof identity.unprotectAll, 'function');
    assert.equal(typeof identity.protectedDir, 'function');
  });

  await ok('nx-cloud: lock file hidden-only (no +R) and cleared before unlink', async () => {
    const src = read('src/main/core/nx-cloud.js');
    assert.ok(!src.includes("'+H', '+R'"), 'read-only attribute no longer set on .nx-lock');
    const persistBlock = src.slice(src.indexOf('function persistLockLocal'), src.indexOf('function applyLock'));
    assert.ok(/chmodSync\(LOCK_FILE, 0o666\)/.test(persistBlock), 'read-only flag cleared before rewrite/unlink');
  });

  await ok('auth: token vault removal clears the read-only flag first', async () => {
    const src = read('src/main/core/auth.js');
    const block = src.slice(src.indexOf('function clearTokens'), src.indexOf('function offlineUuid'));
    assert.ok(block.includes('chmodSync'), 'chmod before rm (EPERM fix)');
  });

  /* ---- 5. close launcher on launch (static — game.js pulls npm deps) ---- */
  await ok('game.js: watchdog script is locale-safe + launcher exit wiring', async () => {
    const src = read('src/main/core/game.js');
    assert.ok(src.includes('function buildWatchdogScript'), 'builder exists + exported');
    assert.ok(src.includes("tasklist /FI \"PID eq ${pid}\""), 'PID poll');
    assert.ok(src.includes('ping -n 4 127.0.0.1'), 'stdin-safe delay (timeout.exe would abort)');
    assert.ok(src.includes('start'), 'relaunch command');
    assert.ok(src.includes('del "%~f0"'), 'self-deletes');
    assert.ok(src.includes('module.exports') && src.includes('buildWatchdogScript'), 'builder exported');
    assert.ok(src.includes('closeLauncherOnLaunch'), 'setting honored');
    assert.ok(!src.includes('keepLauncherOpen'), 'v1.0-R2: legacy keep-open toggle fully removed');
    assert.ok(src.includes("emitState('handoff'"), 'renderer informed before quit');
    assert.ok(src.includes('armWatchdog'), 'watchdog armed on close-on-launch');
  });

  await ok('settings: closeLauncherOnLaunch + keysAcknowledgedAt + nxLegacyServer defaults', async () => {
    const settings = require('../src/main/core/settings.js');
    assert.equal(settings.DEFAULTS.closeLauncherOnLaunch, false);
    assert.equal(settings.DEFAULTS.keysAcknowledgedAt, null);
    assert.equal(settings.DEFAULTS.nxLegacyServer, false);
  });

  /* ---- 6. offline-first NX Cloud ---- */
  await ok('nx-cloud.pickMode: supabase / legacy opt-in / offline default', async () => {
    const nxCloud = require('../src/main/core/nx-cloud.js');
    assert.equal(typeof nxCloud.pickMode, 'function');
    assert.equal(nxCloud.pickMode({ nxSupabaseUrl: 'postgresql://x' }), 'supabase');
    assert.equal(nxCloud.pickMode({ nxSupabaseUrl: '', nxLegacyServer: true }), 'server');
    assert.equal(nxCloud.pickMode({ nxSupabaseUrl: '', nxLegacyServer: false }), 'offline');
    assert.equal(nxCloud.pickMode({}), 'offline', 'fresh install = offline, never a doomed localhost relay');
  });

  await ok('nx-cloud: offline error text is honest and friendly', async () => {
    const src = read('src/main/core/nx-cloud.js');
    assert.ok(src.includes('which is not configured on this device'), 'no raw jargon for first-time users');
  });

  /* ---- 7. Owner Console wiring (v4.5 era: key display removed) ---- */
  await ok('ipc: all owner console channels registered', async () => {
    const src = read('src/main/ipc.js');
    for (const ch of ['owner:keysStatus', 'owner:listFiles', 'owner:readFile', 'owner:writeFile', 'owner:unlockData', 'owner:wipeAll']) {
      assert.ok(src.includes(`'${ch}'`), ch);
    }
    assert.ok(src.includes('requireOwnerPass'), 'passkey gate helper');
    assert.ok(src.includes('DELETE'), 'factory reset typed confirmation');
  });

  await ok('renderer: Owner Console card + close-on-launch toggle present', async () => {
    const src = read('src/renderer/js/pages/settings.js');
    assert.ok(src.includes("toggle('closeLauncherOnLaunch'"), 'checkbox added');
    assert.ok(src.includes('Owner Console'), 'card present');
    assert.ok(src.includes('owner:unlockData'), 'unlock .neurax button');
    assert.ok(src.includes('owner:wipeAll'), 'factory reset button');
    assert.ok(src.includes("st.mode === 'offline'"), 'friendly offline status');
  });

  await ok('renderer main: handoff state handled (launcher closing toast)', async () => {
    const src = read('src/renderer/js/main.js');
    assert.ok(src.includes("'handoff'"), 'handoff branch');
  });

  await ok('mock-bridge: owner console preview stubs present', async () => {
    const mock = read('src/renderer/js/mock-bridge.js');
    for (const ch of ['owner:keysStatus', 'owner:listFiles', 'owner:readFile', 'owner:writeFile', 'owner:unlockData', 'owner:wipeAll']) {
      assert.ok(mock.includes(ch), ch);
    }
    assert.ok(mock.includes('closeLauncherOnLaunch'), 'settings fallback');
  });

  console.log(`\n== RESULT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
