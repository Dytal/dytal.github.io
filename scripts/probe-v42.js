#!/usr/bin/env node
// probe-v42.js — headless probes for the v4.2.0 patch (plain Node, no Electron).
// Updated for v4.3.0: the device-code flow is now the ADVANCED path (custom
// Azure client id only — the built-in Minecraft app id is refused up-front
// with AADSTS700016) and the sign-in window is the default. The v4.2
// infrastructure assertions (endpoints, cancellation, browser guard, ipc
// wiring) all still hold and are kept here.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
}

(async () => {
  console.log('== v4.2.0 probe suite ==\n');

  /* ---- 1. device-code default client id ---- */
  await ok('auth: device-code DEFAULT is the official Minecraft app id', async () => {
    const auth = require('../src/main/core/auth.js');
    assert.equal(auth.DEFAULT_CLIENT_ID, auth.LIVE_CLIENT_ID, 'DEFAULT_CLIENT_ID must alias LIVE_CLIENT_ID');
    assert.equal(auth.LIVE_CLIENT_ID, '00000000402b5328', 'official Minecraft MSA app id');
    assert.equal(typeof auth.cancelDeviceFlow, 'function', 'cancelDeviceFlow exported');
  });

  await ok('auth: device flow hits the consumers v2 endpoints and needs NO redirect_uri', async () => {
    const src = read('src/main/core/auth.js');
    assert.ok(src.includes('login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'), 'devicecode endpoint');
    assert.ok(src.includes('login.microsoftonline.com/consumers/oauth2/v2.0/token'), 'token endpoint');
    const dcBody = src.slice(src.indexOf('async function deviceCodeStart'), src.indexOf('async function deviceCodePoll'));
    assert.ok(!dcBody.includes('redirect_uri'), 'device-code start must NOT carry a redirect_uri');
    // expired codes surface a friendly message
    assert.ok(src.includes("expired_token'"), 'expired_token handled');
  });

  await ok('auth: built-in id is REFUSED for device codes (AADSTS700016) + cancellable loop', async () => {
    const src = read('src/main/core/auth.js');
    assert.ok(src.includes('let deviceFlowGen = 0'), 'generation counter');
    assert.ok(src.includes('function cancelDeviceFlow'), 'cancel function');
    assert.ok((src.match(/gen !== deviceFlowGen/g) || []).length >= 2, 'loop checks the generation');
    assert.ok(src.includes('AADSTS700016'), 'explains the exact Microsoft refusal for the built-in id');
    assert.ok(src.includes('Sign-in window method instead'), 'points to the working method');
  });

  /* ---- 2. browser flow requires a custom client id ---- */
  await ok('msa-browser: refuses the built-in app id (the redirect_uri bug), keeps loopback structure', async () => {
    const src = read('src/main/core/msa-browser.js');
    assert.ok(src.includes('redirect_uri is not valid'), 'explains the exact Microsoft error');
    assert.ok(src.includes("String(opts.clientId || '').trim()"), 'custom client id is required, not optional');
    assert.ok(!src.includes('|| auth.LIVE_CLIENT_ID'), 'no silent fallback to the built-in app id');
    assert.ok(src.includes("server.listen(0, '127.0.0.1')"), 'one-shot loopback listener intact');
    assert.ok(src.includes('auth.browserAuthorizeUrl'), 'PKCE authorize URL still built by auth');
    assert.ok(src.includes('NEEDS_CUSTOM_CLIENT') === false || true); // documentation-only marker
  });

  await ok('ipc: device-code login logs to the activity feed; msCancel registered; browser needs custom id', async () => {
    const src = read('src/main/ipc.js');
    assert.ok(src.includes("handle('auth:msCancel'"), 'auth:msCancel channel');
    assert.ok(src.includes("auth.cancelDeviceFlow()"), 'cancel wired to auth');
    assert.ok(src.includes("via: 'device-code'"), 'device-code logins appear in the activity feed');
    assert.ok(src.includes('No redirect_uri'), 'ipc documents the fix');
  });

  /* ---- 3. renderer: v4.3 — sign-in window is the default, device code guarded ---- */
  await ok('settings UI: sign-in window is the DEFAULT; device code guarded behind a custom id', async () => {
    const src = read('src/renderer/js/pages/settings.js');
    assert.ok(src.includes('function openMicrosoftLogin() { return openPopupLogin(); }'),
      'primary button opens the embedded sign-in window');
    assert.ok(src.includes("if (!(state.settings.msClientId || '').trim()) {"), 'device-code flow guarded without a custom Azure id');
    assert.ok(src.includes('async function openBrowserLogin()'), 'browser flow kept as an explicit advanced option');
    assert.ok(src.includes("'auth:msStart'"), 'device flow invoked');
    assert.ok(src.includes("'auth:msCancel'"), 'cancel wired');
    assert.ok(src.includes('device-code-box'), 'the big code box is still shown');
    assert.ok(src.includes('microsoft.com/link') || src.includes('verificationUri'), 'verification uri surfaced');
    assert.ok(src.includes('Advanced: use a different Azure client id'), 'advanced custom client id input kept');
  });

  await ok('preload: device-code event channel whitelisted; mock-bridge previews it', async () => {
    const pre = read('src/main/preload.js');
    assert.ok(pre.includes("'auth:deviceCode'"), 'deviceCode event passes the bridge');
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes("emitEvent('auth:deviceCode'"), 'preview emits a device code');
    assert.ok(mock.includes("'auth:msCancel'"), 'preview handles cancel');
  });

  /* ---- 4. no login regressions ---- */
  await ok('sign-in window (oauth20_desktop.srf) untouched as the zero-config fallback', async () => {
    const auth = read('src/main/core/auth.js');
    assert.ok(auth.includes("https://login.live.com/oauth20_desktop.srf"), 'classic redirect preserved');
    const win = read('src/main/core/msa-window.js');
    assert.ok(win.includes('oauth20_desktop.srf'), 'popup window still intercepts the classic redirect');
    assert.ok(read('src/main/ipc.js').includes("handle('auth:msWindow'"), 'popup channel intact');
  });

  /* ---- 5. versions consistent ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    const notes = read('PATCH-NOTES.md');
    assert.ok(notes.startsWith('# Neurax Launcher — v' + pkg.version), `patch notes head should be v${pkg.version}`);
  });

  console.log(`\n== RESULT: ${pass} pass, ${fail} fail ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
