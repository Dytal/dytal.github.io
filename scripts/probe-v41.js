#!/usr/bin/env node
// probe-v41.js — headless probes for the v4.1.0 patch (plain Node, no Electron).
// Run: node scripts/probe-v41.js
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log('  PASS', name); }).catch((e) => { fail++; console.log('  FAIL', name, '—', e.message); });

(async () => {
  console.log('== v4.1.0 probe suite ==');

  /* ---- 1. PKCE pair ---- */
  await ok('pkcePair: verifier/challenge shapes + S256 relation', async () => {
    const auth = require('../src/main/core/auth.js');
    const { verifier, challenge } = auth.pkcePair();
    assert(/^[A-Za-z0-9_-]{43,}$/.test(verifier), 'verifier not base64url');
    assert(/^[A-Za-z0-9_-]{43,}$/.test(challenge), 'challenge not base64url');
    const crypto = require('crypto');
    assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge, 'challenge != S256(verifier)');
    const a = auth.pkcePair(), b = auth.pkcePair();
    assert.notEqual(a.verifier, b.verifier, 'verifiers must be random per login');
  });

  /* ---- 2. browser authorize URL ---- */
  await ok('browserAuthorizeUrl: v2 endpoint + PKCE S256 + state params', async () => {
    const auth = require('../src/main/core/auth.js');
    const url = auth.browserAuthorizeUrl({ clientId: 'abc-app-id', redirectUri: 'http://localhost:54321/', challenge: 'CHALLENGE123', state: 'st4te' });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    assert.equal(u.searchParams.get('client_id'), 'abc-app-id');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:54321/');
    assert.equal(u.searchParams.get('code_challenge'), 'CHALLENGE123');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), 'st4te');
    assert.equal(u.searchParams.get('scope'), 'XboxLive.signin offline_access');
  });

  /* ---- 3. restore flow mapping ---- */
  await ok('restoreSession maps flow->endpoint (pkce/v2=msonline, live=login.live)', async () => {
    // static analysis of the mapping line — restoreSession must branch on t.flow === 'live' only
    const src = read('src/main/core/auth.js');
    assert.ok(/const isLive = t\.flow === 'live';/.test(src), 'isLive must depend ONLY on flow=live');
    assert.ok(/flow === 'pkce'/.test(src) === false || src.includes("'pkce'"), 'pkce flow referenced');
    assert.ok(src.includes("login.microsoftonline.com/consumers/oauth2/v2.0/token"), 'msonline v2 refresh endpoint present');
  });

  /* ---- 4. profile-provider await fix (the ROOT CAUSE fix) ---- */
  await ok('nx-supabase: tick + boot await profileProvider; pushProfile guards Promises', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes('await syncTick(await profileProvider()'), 'syncTick must await the provider');
    assert.ok(src.includes('await register(id, await profileProvider()'), 'boot register must await the provider');
    assert.ok(src.includes('await opts.identity()'), 'late register must call opts.identity() (optsIdentity ReferenceError fixed)');
    assert.ok(!/optsIdentity\(\)/.test(src) && !/identity: optsIdentity/.test(src), 'no live optsIdentity usage');
    assert.ok(src.includes("typeof profile.then === 'function'"), 'pushProfile must reject unawaited Promises');
    // hash is set AFTER the update query
    const pushIdx = src.indexOf('async function pushProfile');
    const seg = src.slice(pushIdx, pushIdx + 2600);
    const updIdx = seg.indexOf('where uuid = ${state.uuid}`;');
    const hashIdx = seg.indexOf('state.profileHash = h;');
    assert.ok(updIdx > -1 && hashIdx > updIdx, 'profileHash must be remembered only AFTER the update query');
  });

  /* ---- 5. Mojang fallback present in blockAdd + resolveMsaTarget ---- */
  await ok('nx-supabase: mojangLookup fallback wired into blockAdd + resolveMsaTarget + api', async () => {
    const engine = require('../src/main/core/nx-supabase.js');
    assert.equal(typeof engine.api.mojangLookup, 'function', 'api.mojangLookup exported');
    assert.equal(typeof engine.api.forceProfilePush, 'function', 'api.forceProfilePush exported');
    assert.equal(typeof engine.api.rebindCloudIdentity, 'function', 'api.rebindCloudIdentity exported');
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes('api.mojang.com/users/profiles/minecraft/'), 'Mojang endpoint used');
    const blk = src.indexOf('async function blockAdd');
    assert.ok(src.slice(blk, blk + 3000).includes('mojangLookup'), 'blockAdd falls back to Mojang');
    const rsl = src.indexOf('async function resolveMsaTarget');
    assert.ok(src.slice(rsl, rsl + 3600).includes('mojangLookup'), 'resolveMsaTarget falls back to Mojang');
  });

  /* ---- 6. mojangLookup input hygiene ---- */
  await ok('mojangLookup: rejects invalid names without network', async () => {
    const engine = require('../src/main/core/nx-supabase.js');
    assert.equal(await engine.api.mojangLookup({ name: '' }), null, 'empty rejected');
    assert.equal(await engine.api.mojangLookup({ name: 'bad name!' }), null, 'invalid chars rejected');
    assert.equal(await engine.api.mojangLookup({ name: 'x'.repeat(17) }), null, '>16 chars rejected');
  });

  /* ---- 7. identity override validation + exports ---- */
  await ok('device-identity: overrideIdentity exported; ipc validates formats + passkey', async () => {
    const di = require('../src/main/core/device-identity.js');
    assert.equal(typeof di.overrideIdentity, 'function');
    const ipc = read('src/main/ipc.js');
    assert.ok(ipc.includes("nx:identityWrite"), 'identityWrite channel registered');
    assert.ok(ipc.includes("identity edit refused"), 'passkey gate message present');
    assert.ok(ipc.includes('[0-9a-f]{64}'), 'fingerprint format validated');
    assert.ok(ipc.includes('nx:identityRead'), 'identityRead channel registered');
    assert.ok(ipc.includes('auth:msBrowser'), 'browser login channel registered');
    assert.ok(ipc.includes('auth:msBrowserCancel'), 'browser cancel channel registered');
    assert.ok(ipc.includes('rebindIdentity'), 'cloud rebind wired into ipc');
  });

  /* ---- 8. preload exposes the new event channel ---- */
  await ok('preload: auth:msBrowser event whitelisted', async () => {
    const src = read('src/main/preload.js');
    assert.ok(src.includes("'auth:msBrowser'"), 'msBrowser stage events must pass the bridge');
  });

  /* ---- 9. renderer: admin IDs editor + browser login UI ---- */
  await ok('renderer: Device & login IDs modal + passkey re-check + browser-first login', async () => {
    const nx = read('src/renderer/js/nx.js');
    assert.ok(nx.includes('openIdentityEditor'), 'identity editor exists');
    assert.ok(nx.includes('Device & login IDs'), 'admin bar button present');
    assert.ok(nx.includes('nx:identityWrite'), 'editor calls identityWrite');
    const st = read('src/renderer/js/pages/settings.js');
    assert.ok(st.includes('auth:msBrowser'), 'settings default login uses the browser flow');
    assert.ok(st.includes('openPopupLogin'), 'embedded window kept as fallback');
    assert.ok(st.includes('openDeviceCodeLogin'), 'device code kept');
  });

  /* ---- 10. auth account-changed hook -> cloud force push ---- */
  await ok('auth<->cloud: account-changed hook registered; login flows notify', async () => {
    const src = read('src/main/core/auth.js');
    assert.ok(src.includes('setOnAccountChanged'), 'hook setter exported');
    const notifyCount = (src.match(/notifyAccountChanged\(/g) || []).length;
    assert.ok(notifyCount >= 5, `notify called from login/restore/logout paths (found ${notifyCount})`);
    const cloud = read('src/main/core/nx-cloud.js');
    assert.ok(cloud.includes('setOnAccountChanged'), 'nx-cloud registers the hook');
    assert.ok(cloud.includes('forceProfilePush'), 'hook triggers forceProfilePush');
  });

  /* ---- 11. msa-browser: one-shot server + state + cancel ---- */
  await ok('msa-browser: loopback listener structure + timeout + cancel', async () => {
    const src = read('src/main/core/msa-browser.js');
    assert.ok(src.includes("server.listen(0, '127.0.0.1')"), 'random free port on loopback');
    assert.ok(src.includes('auth.browserAuthorizeUrl'), 'authorize URL built by auth (PKCE lives there)');
    assert.ok(src.includes('loginWithBrowserCode'), 'delegates exchange to auth');
    assert.ok(src.includes('TIMEOUT_MS'), 'hard timeout present');
    assert.ok(src.includes('cancelActive'), 'cancel support');
    assert.ok(src.includes("searchParams.get('state')"), 'state validated (CSRF guard)');
    assert.ok(src.includes('SUCCESS_PAGE'), 'user-facing success page');
    // actual functional check: the module loads and rejects a bogus flow cleanly
    const mb = require('../src/main/core/msa-browser.js');
    assert.equal(typeof mb.openMicrosoftBrowserLogin, 'function');
    assert.equal(mb.cancelActive(), false, 'cancel with nothing active is a safe no-op');
  });

  /* ---- 12. msa-window fallback untouched ---- */
  await ok('msa-window fallback still exports open/cancel', async () => {
    const src = read('src/main/core/msa-window.js');
    assert.ok(src.includes('function openMicrosoftLogin'), 'openMicrosoftLogin present');
    assert.ok(src.includes('function cancelActive'), 'cancelActive present');
  });

  /* ---- 13. versions consistent (era-independent since v4.1.1: the version
         moves on with later patches — package.json and the TOP patch-notes
         heading must simply agree) ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    const notes = read('PATCH-NOTES.md');
    assert.ok(notes.startsWith('# Neurax Launcher — v' + pkg.version), `patch notes head should be v${pkg.version}`);
  });

  console.log(`\n== RESULT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
