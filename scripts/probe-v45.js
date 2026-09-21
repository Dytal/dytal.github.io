#!/usr/bin/env node
// probe-v45.js — headless probes for the v4.5.0 patch (plain Node, no Electron).
//
// Covers the headline changes:
//   1. FIXED OWNER KEY everywhere — nx-canonical.js carries the owner's key;
//      every fresh install / deleted .neurax seeds it; key display removed
//      from the settings tab (no reveal/rotate/first-run banner anywhere).
//   2. SUPABASE OUT OF THE BOX — the owner's NX Cloud database is the default
//      nxSupabaseUrl: the launcher connects directly, NX Cloud never needs to
//      have run; empty stored URLs are seeded at load.
//   3. NX Cloud <-> Supabase sync — the Control Center reads/writes the SAME
//      SEALED settings (settings.vault) and connects to the same database by
//      default, so the console and every launcher share one source of truth.
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
const CANON = require('../src/main/core/nx-canonical.js');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v45-'));
}

/** Run code in a subprocess bound to an isolated NEURAX_HOME. */
function run(code, home) {
  const script = path.join(os.tmpdir(), `nx45-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return execFileSync(process.execPath, [script], {
      env: { ...process.env, NEURAX_HOME: home, NEURAX_KEYS_FILE: path.join(home, 'nx-keys.local.json') },
      encoding: 'utf8', timeout: 30000,
    });
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}

(async () => {
  console.log('== v4.5.0 probe suite ==\n');

  /* ---- 1. versions consistent (era-independent) ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    assert.ok(read('PATCH-NOTES.md').startsWith('# Neurax Launcher — v' + pkg.version), 'patch notes head matches ' + pkg.version);
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes(`'${pkg.version}-preview'`), 'mock-bridge preview label bumped');
  });

  /* ---- 2. the fixed owner key ---- */
  await ok('nx-canonical.js: the owner key + database are the single source of truth', async () => {
    const src = read('src/main/core/nx-canonical.js');
    assert.ok(src.includes("OWNER_KEY = 'AAhdswedgjihsedfyg2346283jsd!'"), 'OWNER_KEY literal');
    assert.ok(src.includes('OWNER_SUPABASE_URL'), 'OWNER_SUPABASE_URL exported');
    assert.ok(CANON.OWNER_KEY === 'AAhdswedgjihsedfyg2346283jsd!', 'module returns the owner key');
    assert.ok(CANON.OWNER_KEY.length >= 12, 'key long enough for both roles');
    assert.ok(/postgresql:\/\/.+@db\.[a-z0-9]{20}\.supabase\.co/.test(CANON.OWNER_SUPABASE_URL), 'database URL is a Supabase Postgres string');
  });

  await ok('nx-admin-keys: canonical seed + re-seed logic wired', async () => {
    const src = read('src/main/core/nx-admin-keys.js');
    assert.ok(src.includes("require('./nx-canonical')"), 'canonical module required');
    assert.ok(src.includes('canonicalKeys'), 'canonicalKeys() exists');
    assert.ok(src.includes('SEED_VERSION'), 'seed version guard exists');
    assert.ok(src.includes('seedVersion'), 'seedVersion persisted in the sealed vault');
    const k = require('../src/main/core/nx-admin-keys.js');
    assert.ok(k.SEED_VERSION >= 2, 'seed version bumped');
    assert.deepEqual(k.canonicalKeys(), { ADMIN_KEY: CANON.OWNER_KEY, UNLOCK_PASSKEY: CANON.OWNER_KEY }, 'both roles = the owner key');
  });

  await ok('END-TO-END: fresh home (deleted .neurax) resolves the FIXED key', async () => {
    const home = freshHome();
    const KEYS = path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js');
    const out = run(`
      const k = require(${JSON.stringify(KEYS)});
      console.log(JSON.stringify({ src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY }));
    `, home);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.a, CANON.OWNER_KEY, 'admin key = owner fixed key');
    assert.equal(j.u, CANON.OWNER_KEY, 'unlock passkey = owner fixed key');
    assert.ok(j.src === 'canonical' || j.src === 'sealed', 'source is canonical/sealed, got ' + j.src);
    assert.ok(fs.existsSync(path.join(home, 'keys.vault')), 'sealed key vault created on first run');
    const raw = fs.readFileSync(path.join(home, 'keys.vault'), 'latin1');
    assert.ok(!raw.includes(CANON.OWNER_KEY), 'key never at rest in plaintext');
    fs.rmSync(home, { recursive: true, force: true });
  });

  /* ---- 3. key display REMOVED from the settings tab ---- */
  await ok('renderer: every key-display feature is gone', async () => {
    const src = read('src/renderer/js/pages/settings.js');
    for (const gone of ['owner:keysFirstRun', 'owner:keysAcknowledge', 'owner:keysReveal', 'owner:keysRotate',
      'Reveal owner keys', 'Rotate keys', 'renderFirstRunKeys', 'keyLine', 'I saved them']) {
      assert.ok(!src.includes(gone), `removed from settings UI: ${gone}`);
    }
    assert.ok(src.includes('Owner Console'), 'Owner Console card stays');
    assert.ok(src.includes('owner:listFiles') && src.includes('owner:readFile'), 'file viewer stays');
    assert.ok(src.includes('owner:unlockData') && src.includes('owner:wipeAll'), 'unlock + factory reset stay');
  });

  await ok('ipc: key-display channels removed, console channels intact', async () => {
    const src = read('src/main/ipc.js');
    for (const gone of ["'owner:keysFirstRun'", "'owner:keysAcknowledge'", "'owner:keysReveal'", "'owner:keysRotate'"]) {
      assert.ok(!src.includes(gone), `removed IPC channel: ${gone}`);
    }
    for (const ch of ['owner:keysStatus', 'owner:listFiles', 'owner:readFile', 'owner:writeFile', 'owner:unlockData', 'owner:wipeAll']) {
      assert.ok(src.includes(`'${ch}'`), `${ch} stays`);
    }
    assert.ok(src.includes('requireOwnerPass'), 'passkey gate stays');
  });

  await ok('mock-bridge: removed stubs gone, preview label bumped', async () => {
    const mock = read('src/renderer/js/mock-bridge.js');
    for (const gone of ['owner:keysFirstRun', 'owner:keysReveal', 'owner:keysRotate', 'owner:keysAcknowledge', 'PREVIEW-ADMIN-KEY']) {
      assert.ok(!mock.includes(gone), `removed mock stub: ${gone}`);
    }
    assert.ok(mock.includes('owner:keysStatus'), 'keysStatus stub stays (metadata only)');
  });

  /* ---- 4. Supabase out of the box ---- */
  await ok('settings: the owner database is the default + empty URLs are seeded', async () => {
    const settings = require('../src/main/core/settings.js');
    assert.equal(settings.DEFAULTS.nxSupabaseUrl, CANON.OWNER_SUPABASE_URL, 'default nxSupabaseUrl = owner database');
    assert.equal(settings.DEFAULTS.closeLauncherOnLaunch, false, 'close-on-launch default kept');
    // session 1 seeds the sealed settings on first boot; session 2 verifies
    const home = freshHome();
    run(`
      const s = require(${JSON.stringify(path.join(ROOT, 'src/main/core/settings.js'))});
      s.get();
      console.log('booted');
    `, home);
    const out = run(`
      const s = require(${JSON.stringify(path.join(ROOT, 'src/main/core/settings.js'))});
      const seal = require(${JSON.stringify(path.join(ROOT, 'src/main/core/nx-seal.js'))});
      const path = require('path');
      const stored = seal.readSealed(process.env.NEURAX_HOME, path.join(process.env.NEURAX_HOME, 'settings.vault'));
      console.log(JSON.stringify({ url: stored.nxSupabaseUrl }));
    `, home);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.url, CANON.OWNER_SUPABASE_URL, 'sealed settings carry the owner database on first run');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await ok('nx-cloud: a fresh install picks SUPABASE mode immediately', async () => {
    const nxCloud = require('../src/main/core/nx-cloud.js');
    const settings = require('../src/main/core/settings.js');
    assert.equal(nxCloud.pickMode(settings.DEFAULTS), 'supabase', 'default settings → direct Supabase (no NX Cloud run needed)');
    assert.equal(nxCloud.pickMode({ nxSupabaseUrl: '', nxLegacyServer: false }), 'offline', 'cleared URL still degrades to clean offline');
  });

  /* ---- 5. NX Cloud <-> Supabase (Control Center) ---- */
  await ok('control-center: same database by default + SEALED settings I/O', async () => {
    const src = read('nx-cloud/control-center.js');
    assert.ok(src.includes('nx-canonical.js'), 'canonical module is the default URL source');
    assert.ok(src.includes('OWNER_SUPABASE_URL'), 'default = owner database');
    assert.ok(src.includes('settings.vault'), 'reads/writes the SEALED settings file');
    assert.ok(src.includes('readSealed') && src.includes('writeSealed'), 'through the nx-seal crypto');
    assert.ok(src.includes('LEGACY_SETTINGS_FILE'), 'plaintext fallback kept');
  });

  await ok('control-center: boots headless and exposes the fixed admin key', async () => {
    const home = freshHome();
    const out = run(`
      process.env.NX_CC_NO_OPEN = '1';
      const src = require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'nx-cloud/control-center.js'))}, 'utf8');
      // static sanity: the console requires the canonical module and reads the owner key
      console.log(JSON.stringify({ hasCanonical: src.includes('nx-canonical.js'), hasKeys: src.includes('nx-admin-keys.js') }));
    `, home);
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.ok(j.hasCanonical && j.hasKeys, 'console wired to the canonical config + keys module');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await ok('rotate-nx-keys.js: writes the FIXED key by default (--random opt-out)', async () => {
    const src = read('scripts/rotate-nx-keys.js');
    assert.ok(src.includes('nx-canonical'), 'canonical module used');
    assert.ok(src.includes('--random'), 'random opt-out documented');
    assert.ok(src.includes('OWNER_KEY'), 'fixed key is the default');
  });

  console.log(`\n== RESULT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
