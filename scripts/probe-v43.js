#!/usr/bin/env node
// probe-v43.js — headless probes for the v4.3.0 patch (plain Node, no Electron).
//
// Covers the two headline changes:
//   1. EVERYTHING sensitive in .neurax is sealed (AES-256-GCM, machine-bound):
//      settings.vault, auth/tokens.vault, identity-cache.vault — with the
//      legacy plaintext files migrated AND shredded on first run.
//   2. The sign-in-window flow is the default; the device-code flow REFUSES
//      the official Minecraft app id up-front (AADSTS700016 — consumer MSA
//      apps are not Entra-ID directory apps) and only runs with a custom
//      Azure client id.
//
// Functional tests run in an isolated NEURAX_HOME (temp dir), so they never
// touch a real installation.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v43-'));
}

(async () => {
  console.log('== v4.3.0 probe suite ==\n');

  /* ---- 1. versions consistent (era-independent since v4.4) ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    assert.ok(read('PATCH-NOTES.md').startsWith('# Neurax Launcher — v' + pkg.version), 'patch notes head matches package version ' + pkg.version);
  });

  /* ---- 2. vault gained the generic sealed-file primitives ---- */
  await ok('nx-vault: readSealed / writeSealed / shredPlaintext exported + functional round-trip', async () => {
    const vault = require('../src/main/core/nx-vault.js');
    assert.equal(typeof vault.readSealed, 'function');
    assert.equal(typeof vault.writeSealed, 'function');
    assert.equal(typeof vault.shredPlaintext, 'function');
    const home = freshHome();
    const dir = path.join(home, 'root');
    const file = path.join(dir, 'test.vault');
    vault.writeSealed(dir, file, { hello: 'world', n: 42 });
    const raw = fs.readFileSync(file);
    assert.ok(raw.subarray(0, 6).toString('ascii').startsWith('NXVB1'), 'file carries the NXVB1 magic');
    assert.ok(!raw.toString('latin1').includes('hello'), 'no plaintext keys in the sealed bytes');
    assert.ok(!raw.toString('latin1').includes('world'), 'no plaintext values in the sealed bytes');
    assert.deepEqual(vault.readSealed(dir, file), { hello: 'world', n: 42 }, 'round-trip restores the object');
    // tamper → readSealed must refuse + quarantine (unlock first: writes are locked read-only)
    fs.chmodSync(file, 0o600);
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 5] ^= 0xff;
    fs.writeFileSync(file, tampered);
    assert.equal(vault.readSealed(dir, file), null, 'tampered envelope is refused');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('test.vault.corrupt-')), 'tampered file quarantined');
    // shred → gone (writeSealed re-creates the file after the quarantine above)
    vault.writeSealed(dir, file, { a: 1 });
    assert.ok(vault.shredPlaintext(file), 'shred reports success');
    assert.ok(!fs.existsSync(file), 'shredded file is gone');
    assert.ok(vault.shredPlaintext(file), 'shredding a missing file is a no-op success');
  });

  /* ---- 3. settings are sealed ---- */
  await ok('settings: persisted to settings.vault (sealed); plaintext settings.json shredded; owner key never stored', async () => {
    const src = read('src/main/core/settings.js');
    assert.ok(src.includes("path.join(DIRS.root, 'settings.vault')"), 'sealed settings file');
    assert.ok(src.includes("path.join(DIRS.root, 'settings.json')"), 'legacy file known');
    assert.ok(src.includes('new Set'), 'runtime-only field list');
    assert.ok(src.includes("'nxAdminPass'") && src.includes("'msRefreshToken'"), 'owner key + legacy token field excluded from disk');
    assert.ok(src.includes('shredPlaintext'), 'legacy plaintext is shredded');

    // functional: isolated home — create a LEGACY plaintext settings.json with
    // a poisoned owner key + legacy refresh token, load, verify migration.
    const home = freshHome();
    process.env.NEURAX_HOME = home;
    delete require.cache[require.resolve('../src/main/core/paths.js')];
    for (const m of Object.keys(require.cache)) {
      if (m.includes(`${path.sep}neurax-launcher${path.sep}src${path.sep}main${path.sep}`)) delete require.cache[m];
    }
    const legacyContent = {
      version: 4, theme: 'orange',
      nxAdminPass: 'LEAKED-OWNER-KEY-should-never-survive',
      msRefreshToken: 'LEAKED-REFRESH-TOKEN-should-never-survive',
    };
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(legacyContent, null, 2));
    const settings = require('../src/main/core/settings.js');
    const s = settings.load();
    assert.equal(s.theme, 'orange', 'legacy values are imported');
    assert.equal(s.nxAdminPass.length >= 12, true, 'owner key still resolves in memory (runtime)');
    assert.ok(!fs.existsSync(path.join(home, 'settings.json')), 'plaintext settings.json is GONE (shredded)');
    const sealedPath = path.join(home, 'settings.vault');
    assert.ok(fs.existsSync(sealedPath), 'settings.vault exists');
    const raw = fs.readFileSync(sealedPath).toString('latin1');
    assert.ok(!raw.includes('LEAKED-OWNER-KEY'), 'owner key leaked value absent from the sealed file');
    assert.ok(!raw.includes('LEAKED-REFRESH-TOKEN'), 'legacy refresh token absent from the sealed file');
    assert.ok(!raw.includes('orange'), 'even harmless values are ciphertext');
    // writes stay sealed + reload persistence
    settings.set({ theme: 'cyan' });
    const raw2 = fs.readFileSync(sealedPath).toString('latin1');
    assert.ok(!raw2.includes('cyan'), 'updated settings are still ciphertext');
    const again = require('../src/main/core/settings.js');
    delete require.cache[require.resolve('../src/main/core/settings.js')];
    const s2 = require('../src/main/core/settings.js').load();
    assert.equal(s2.theme, 'cyan', 'value survives a reload through the sealed file');
  });

  /* ---- 4. tokens are sealed ---- */
  await ok('auth: tokens persisted to tokens.vault (sealed); plaintext tokens.json migrated + shredded', async () => {
    const src = read('src/main/core/auth.js');
    assert.ok(src.includes("path.join(DIRS.auth, 'tokens.vault')"), 'sealed tokens file');
    assert.ok(src.includes("path.join(DIRS.auth, 'tokens.json')"), 'legacy tokens file known');
    assert.ok(src.includes('migrateLegacyTokens'), 'migration function present');
    assert.ok(src.includes('shredPlaintext'), 'legacy tokens file shredded');
    assert.ok(!src.match(/saveTokens\(\{[^}]*encrypt\(/s), 'new token saves must NOT re-introduce per-field encrypt');

    // functional: isolated home with a legacy plaintext tokens.json (enc:'plain' fields)
    const home = freshHome();
    process.env.NEURAX_HOME = home;
    for (const m of Object.keys(require.cache)) {
      if (m.includes(`${path.sep}neurax-launcher${path.sep}src${path.sep}main${path.sep}`)) delete require.cache[m];
    }
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    fs.mkdirSync(path.join(home, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(home, 'auth', 'tokens.json'), JSON.stringify({
      flow: 'live',
      msRefresh: { enc: 'plain', v: b64('LEGACY-REFRESH-TOKEN-VALUE') },
      msAccess: { enc: 'plain', v: b64('LEGACY-ACCESS-TOKEN-VALUE') },
      msAccessExp: 1234567890,
      clientId: { enc: 'plain', v: b64('00000000402b5328') },
      profile: { name: 'Dytalmc', uuid: 'abc' },
    }, null, 2));
    const paths = require('../src/main/core/paths.js');
    const auth = require('../src/main/core/auth.js');
    const t = auth.loadTokens();
    assert.equal(t.msRefresh, 'LEGACY-REFRESH-TOKEN-VALUE', 'legacy field decoded + imported');
    assert.equal(t.profile && t.profile.name, 'Dytalmc', 'profile imported');
    assert.ok(!fs.existsSync(path.join(home, 'auth', 'tokens.json')), 'plaintext tokens.json is GONE (shredded)');
    const sealedPath = path.join(home, 'auth', 'tokens.vault');
    assert.ok(fs.existsSync(sealedPath), 'tokens.vault exists');
    const raw = fs.readFileSync(sealedPath).toString('latin1');
    assert.ok(!raw.includes('LEGACY-REFRESH-TOKEN-VALUE'), 'refresh token value is ciphertext in the sealed file');
    assert.ok(!raw.includes('msRefresh'), 'field names are ciphertext too');
    // new save path is sealed as well
    auth.saveTokens({ ...t, msRefresh: 'BRAND-NEW-TOKEN-VALUE' });
    const raw2 = fs.readFileSync(sealedPath).toString('latin1');
    assert.ok(!raw2.includes('BRAND-NEW-TOKEN-VALUE'), 'freshly saved tokens are ciphertext');
    assert.equal(auth.loadTokens().msRefresh, 'BRAND-NEW-TOKEN-VALUE', 'sealed round-trip');
    assert.ok(paths.DIRS.auth, 'paths module stable');
  });

  /* ---- 5. identity cache is sealed ---- */
  await ok('device-identity: cache sealed to identity-cache.vault; plaintext copy shredded', async () => {
    const src = read('src/main/core/device-identity.js');
    assert.ok(src.includes("path.join(DIRS.root, 'identity-cache.vault')"), 'sealed cache file');
    assert.ok(src.includes('identity-cache.json'), 'legacy cache file known');
    assert.ok(src.includes('shredPlaintext'), 'legacy cache shredded');
  });

  /* ---- 6. device-code refusal for the built-in id ---- */
  await ok('auth: device-code with the OFFICIAL Minecraft app id refuses up-front (AADSTS700016 class)', async () => {
    for (const m of Object.keys(require.cache)) {
      if (m.includes(`${path.sep}neurax-launcher${path.sep}src${path.sep}main${path.sep}`)) delete require.cache[m];
    }
    process.env.NEURAX_HOME = freshHome();
    const auth = require('../src/main/core/auth.js');
    let threw = null;
    try { await auth.loginMicrosoft('', () => {}); } catch (e) { threw = e; }
    assert.ok(threw, 'the flow must refuse without any network call');
    assert.ok(/AADSTS700016/.test(threw.message), 'error names the real Microsoft error');
    assert.ok(/Sign-in window/i.test(threw.message), 'error points to the working method');
  });

  /* ---- 7. renderer wiring ---- */
  await ok('renderer: primary login opens the sign-in window; advanced chooser present', async () => {
    const src = read('src/renderer/js/pages/settings.js');
    assert.ok(src.includes('function openMicrosoftLogin() { return openPopupLogin(); }'), 'primary = window');
    assert.ok(src.includes('function openAdvancedLogin()'), 'advanced chooser exists');
    assert.ok(src.includes("if (!(state.settings.msClientId || '').trim()) {"), 'device-code guard (no doomed flow)');
    assert.ok(src.includes('AADSTS700016'), 'renderer explains the refusal too');
    assert.ok(src.includes("'auth:msWindowCancel'"), 'window cancel wired');
  });

  /* ---- 8. mock-bridge label (era-independent since v4.4) ---- */
  await ok('mock-bridge preview label matches package.json', async () => {
    const pkg = require('../package.json');
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes("'" + pkg.version + "-preview'"), 'version label bumped to ' + pkg.version);
    assert.ok(mock.includes('AADSTS700016'), 'preview comment documents the refusal');
  });

  /* ---- 9. no plaintext token/settings writes remain in main ---- */
  await ok('no writeJSON to settings.json / tokens.json remains anywhere in main', async () => {
    for (const f of ['src/main/core/settings.js', 'src/main/core/auth.js', 'src/main/core/device-identity.js']) {
      const src = read(f);
      assert.ok(!/writeJSON\((DIRS\.root \+ '\/settings\.json'|TOKENS_FILE)/.test(src), `${f} writes no plaintext settings/tokens`);
    }
    assert.ok(!read('src/main/core/auth.js').includes('writeJSON'), 'auth.js no longer needs writeJSON at all');
  });

  console.log(`\n== RESULT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
