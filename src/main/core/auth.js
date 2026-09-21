// auth.js — Microsoft account login -> XBL -> XSTS -> Minecraft services.
// Tokens are stored ENCRYPTED in .neurax/auth/tokens.vault (v4.3 — the whole
// file is one AES-256-GCM envelope bound to this machine; the old per-field
// safeStorage/plain tokens.json is migrated and shredded on first run).
//
// THREE login paths (v4.3):
//   1. SIGN-IN WINDOW (DEFAULT — the zero-config method): an embedded window
//      signs in at login.live.com with the official Minecraft MSA app id and
//      lands on the ONE redirect it has registered
//      (https://login.live.com/oauth20_desktop.srf) — the code is caught from
//      the final URL. Works with 2FA / passkeys / saved sessions, needs no
//      Azure setup and no browser.
//   2. SYSTEM BROWSER + PKCE (needs the owner's OWN Azure app id): the Prism/
//      ATLauncher method. The built-in Minecraft app id does NOT allow
//      localhost redirects (Microsoft answers "redirect_uri is not valid" —
//      the v4.1.0 default bug), so the loopback browser flow is only enabled
//      when a custom client id is configured (NX Admin → Device & login IDs).
//   3. DEVICE CODE (custom Azure app id ONLY): MSA consumer apps like the
//      official Minecraft client are INVISIBLE to the device-code endpoint —
//      Microsoft answers AADSTS700016 ("application not found in the
//      directory") because the app lives in the consumer account service,
//      not Entra ID. Refused up-front for the built-in id; works only with a
//      custom Azure client id that enables public client flows.
// Offline mode available for offline play.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS, readJSON } = require('./paths');
const { getJSON, request } = require('./net');
const logger = require('./logger');
const vault = require('./nx-vault'); // encrypted memory: remembers logins + passkeys

const SCOPE = 'XboxLive.signin offline_access';
// The official Minecraft MSA app id — the ONLY built-in client id. It has
// exactly ONE registered redirect (oauth20_desktop.srf → the embedded
// sign-in window). Microsoft rejects everything else for it: localhost
// redirects (invalid_request) AND the device-code endpoint (AADSTS700016 —
// a consumer MSA app is not an Entra-ID directory app). Never point it at
// http://localhost and never expect device codes to work for it.
const LIVE_CLIENT_ID = '00000000402b5328';
const LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
// v4.3: the sign-in window is the only flow the official app id supports —
// it IS the default. A custom Azure client id (settings.msClientId) unlocks
// the browser and device-code paths.
const DEFAULT_CLIENT_ID = LIVE_CLIENT_ID;
const TOKENS_VAULT = path.join(DIRS.auth, 'tokens.vault');     // encrypted (v4.3)
const LEGACY_TOKENS_FILE = path.join(DIRS.auth, 'tokens.json'); // pre-4.3, migrated + shredded

let safe = null;
function setSafeStorage(s) { safe = s; } // called from main with electron.safeStorage

/* v4 LOGIN GATE — the NX Cloud blocklist gets the final word on every Microsoft
   login. The gate is registered by nx-cloud.js at boot (setLoginGate) so auth.js
   never imports the cloud module directly (no require cycles). A blocked
   account is refused on EVERY device, and already-signed-in devices are
   force-logged-out by the 5s cloud tick. */
let loginGateFn = null;
function setLoginGate(fn) { loginGateFn = typeof fn === 'function' ? fn : null; }

/* v4.1 ACCOUNT-CHANGED HOOK — nx-cloud.js registers a callback that force-pushes
   the fresh identity (name/uuid/type) to NX Cloud the MOMENT a login completes,
   a session restores or a logout happens. Before this, the cloud identity row
   could stay stale (or empty) until the next tick happened to differ — which is
   why "lock account X" / chat invites could not find a signed-in player. */
let accountChangedFn = null;
function setOnAccountChanged(fn) { accountChangedFn = typeof fn === 'function' ? fn : null; }
function notifyAccountChanged(account) {
  try { if (accountChangedFn) accountChangedFn(account || null); } catch {}
}
async function gateOrThrow(account) {
  if (!loginGateFn || !account || account.type !== 'msa') return account;
  const verdict = await loginGateFn(account).catch(() => ({ allowed: true })); // never block login on a gate outage
  if (verdict && verdict.allowed === false) {
    logger.auth.warn(`LOGIN BLOCKED by owner blocklist: ${account.name} (${verdict.reason || 'no reason given'})`);
    throw new Error('This Microsoft account is BLOCKED from using Neurax Launcher by the owner' + (verdict.reason ? ` — ${verdict.reason}` : '.') + ' This block applies on every device.');
  }
  return account;
}

function encrypt(text) { // eslint-disable-line no-unused-vars
  if (safe && safe.isEncryptionAvailable()) {
    return { enc: 'safeStorage', v: safe.encryptString(text).toString('base64') };
  }
  return { enc: 'plain', v: Buffer.from(text, 'utf8').toString('base64') };
}
/** LEGACY ONLY — decodes a field of the pre-4.3 tokens.json during the
 *  one-time migration into tokens.vault. New storage keeps raw strings
 *  inside the AES-256-GCM envelope, so per-field crypto is gone. */
function decrypt(blob) {
  if (!blob) return null;
  try {
    if (blob.enc === 'safeStorage' && safe && safe.isEncryptionAvailable()) {
      return safe.decryptString(Buffer.from(blob.v, 'base64'));
    }
    return Buffer.from(blob.v, 'base64').toString('utf8');
  } catch { return null; } // undecryptable (e.g. safeStorage blob w/o DPAPI) → refresh will fail once, user signs in again
}

/* v4.3 TOKEN STORAGE — the whole token object is ONE sealed NXVB1 envelope
   (.neurax/auth/tokens.vault). Strings are stored raw INSIDE the envelope:
   the AES-256-GCM layer + machine binding is the protection. The old
   tokens.json (safeStorage fields, or PLAINTEXT on machines where
   safeStorage was unavailable — including every released build, because
   setSafeStorage was never wired) is migrated once, then SHREDDED. */
function migrateLegacyTokens() {
  const legacy = readJSON(LEGACY_TOKENS_FILE, null);
  if (!legacy) return null;
  const migrated = {
    flow: legacy.flow || 'live',
    msRefresh: decrypt(legacy.msRefresh) || '',
    msAccess: decrypt(legacy.msAccess) || '',
    msAccessExp: legacy.msAccessExp || 0,
    clientId: decrypt(legacy.clientId) || LIVE_CLIENT_ID,
    profile: legacy.profile || null,
  };
  vault.writeSealed(DIRS.auth, TOKENS_VAULT, migrated);
  if (vault.shredPlaintext(LEGACY_TOKENS_FILE)) {
    logger.auth.info('Auth tokens migrated to encrypted tokens.vault — plaintext tokens.json shredded.');
  } else {
    logger.auth.warn('Auth tokens migrated, but plaintext tokens.json could not be fully shredded — delete it manually.');
  }
  return migrated;
}

function loadTokens() {
  const sealed = vault.readSealed(DIRS.auth, TOKENS_VAULT);
  if (sealed) return sealed;
  return migrateLegacyTokens() || {};
}
function saveTokens(t) { vault.writeSealed(DIRS.auth, TOKENS_VAULT, t || {}); }

/* Short-lived memo so the parallel restore attempts (app boot + renderer boot
   + opening Settings) never fire several refreshes for the same token —
   Microsoft rotates refresh tokens and parallel refreshes can invalidate one. */
let cachedAccount = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;
function invalidateCache() { cachedAccount = null; cachedAt = 0; }
function clearTokens() {
  // v4.4: the sealed vault is chmod'd READ-ONLY at rest — clear that flag
  // first, otherwise rmSync fails with EPERM on Windows and an old token
  // file could survive a logout.
  try { require('fs').chmodSync(TOKENS_VAULT, vault.RW_MODE); } catch {}
  try { fs.rmSync(TOKENS_VAULT, { force: true }); } catch {}
  try { fs.rmSync(LEGACY_TOKENS_FILE, { force: true }); } catch {} // v4.3: kill any pre-migration leftover too
  invalidateCache();
  notifyAccountChanged(null); // v4.1: cloud drops the identity right away
}

function offlineUuid(name) {
  // classic offline uuid = md5("OfflinePlayer:" + name) formatted as v3
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Pure offline account object — does NOT touch stored settings. */
function offlineAccount(name) {
  const clean = String(name || 'Player').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player';
  return {
    type: 'offline', name: clean, uuid: offlineUuid(clean),
    accessToken: '0', skin: null, createdAt: Date.now(),
  };
}

/** Explicit offline login (Settings → Offline name) — remembers the choice. */
function loginOffline(name) {
  const account = offlineAccount(name);
  const { set } = require('./settings');
  set({ lastAccount: { type: 'offline', name: account.name, uuid: account.uuid } });
  try { vault.rememberLogin(account); } catch {}
  notifyAccountChanged(account); // v4.1: cloud shows the offline identity immediately
  logger.auth.info(`Offline account: ${account.name}`);
  return account;
}

async function deviceCodeStart(clientId) {
  const body = new URLSearchParams({ client_id: clientId, scope: SCOPE });
  const res = await request('https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 20000,
  });
  const data = JSON.parse(res.buffer.toString('utf8'));
  if (!data.device_code) throw new Error(data.error_description || 'Device code request failed');
  return data; // { device_code, user_code, verification_uri, expires_in, interval }
}

async function deviceCodePoll(clientId, dc) {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId, device_code: dc,
  });
  const res = await request('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 20000,
  });
  const data = JSON.parse(res.buffer.toString('utf8'));
  if (data.error === 'authorization_pending') return { pending: true };
  if (data.error === 'slow_down') return { pending: true, slow: true };
  if (data.error === 'expired_token') throw new Error('The device code expired — start the sign-in again.');
  if (data.error) throw new Error(data.error_description || data.error);
  return { pending: false, msToken: data };
}

/* ============================================================ v4.1 PKCE BROWSER FLOW
   The OAuth2 Authorization-Code flow with PKCE (RFC 7636) over the system
   default browser — exactly what modern launchers (Prism, ATLauncher, …) do.
   Pure functions here (no Electron imports — this module stays probe-able in
   plain Node); the loopback server + shell.openExternal live in msa-browser.js. */
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function browserAuthorizeUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + q.toString();
}

/** Exchange the loopback code for MSA tokens (PKCE verifier proves possession). */
async function exchangeBrowserCode({ code, verifier, clientId, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await request('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 25000,
  });
  const data = JSON.parse(res.buffer.toString('utf8'));
  if (!data.access_token) throw new Error(data.error_description || data.error || 'Microsoft token exchange failed');
  return data;
}

/** Shared tail of EVERY MSA login: blocklist gate -> save tokens -> remember. */
async function completeMsaLogin(msToken, flow, clientId) {
  const account = await minecraftFromMsToken(msToken.access_token);
  await gateOrThrow(account); // owner blocklist check BEFORE anything is saved
  saveTokens({
    flow,
    msRefresh: msToken.refresh_token || '',       // raw inside the sealed file (v4.3)
    msAccess: msToken.access_token,
    msAccessExp: Date.now() + (msToken.expires_in || 86400) * 1000,
    clientId: String(clientId || LIVE_CLIENT_ID),
    profile: { name: account.name, uuid: account.uuid },
  });
  cachedAccount = account; cachedAt = Date.now();
  const { set } = require('./settings');
  set({ lastAccount: { type: 'msa', name: account.name, uuid: account.uuid } });
  try { vault.rememberLogin(account); } catch {}
  notifyAccountChanged(account); // v4.1: cloud pushes the fresh identity immediately
  logger.auth.info(`Microsoft login OK: ${account.name}`);
  return account;
}

/** Minecraft services auth from an MSA access token. Returns account. */
async function minecraftFromMsToken(msAccessToken) {
  // 1. XBL
  const xblRes = await request('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    }),
    timeout: 25000,
  });
  const xbl = JSON.parse(xblRes.buffer.toString('utf8'));
  const xblToken = xbl.Token;
  const uhs = xbl.DisplayClaims.xui[0].uhs;

  // 2. XSTS
  const xstsRes = await request('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    }),
    timeout: 25000,
  });
  const xsts = JSON.parse(xstsRes.buffer.toString('utf8'));
  if (!xsts.Token) throw new Error('XSTS auth failed: ' + JSON.stringify(xsts).slice(0, 200));
  const xstsToken = xsts.Token;
  const xstsUhs = xsts.DisplayClaims.xui[0].uhs;

  // 3. Minecraft login
  const mcRes = await request('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${xstsUhs};${xstsToken}` }),
    timeout: 25000,
  });
  const mc = JSON.parse(mcRes.buffer.toString('utf8'));
  if (!mc.access_token) throw new Error('Minecraft auth failed');

  // 4. Profile (name, uuid, skins)
  let profile = null;
  const profRes = await request('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` }, timeout: 25000,
  });
  if (profRes.status === 200) {
    profile = JSON.parse(profRes.buffer.toString('utf8'));
  } else {
    throw new Error('This Microsoft account does not own Minecraft Java Edition.');
  }
  const skin = (profile.skins || []).find(s => s.state === 'ACTIVE') || null;
  return {
    type: 'msa',
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.access_token,
    skin,
    msExpiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    createdAt: Date.now(),
  };
}

/** URL for the embedded sign-in window (classic MSA / Minecraft app). */
function msaAuthorizeUrl(clientId) {
  const q = new URLSearchParams({
    client_id: clientId || LIVE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: LIVE_REDIRECT,
    scope: SCOPE,
    display: 'touch',
  });
  return 'https://login.live.com/oauth20_authorize.srf?' + q.toString();
}

/** Exchange an oauth code (from the popup redirect) for tokens, then run the MC chain. */
async function loginWithMsaCode(code, clientId) {
  const cid = String(clientId || '').trim() || LIVE_CLIENT_ID;
  const body = new URLSearchParams({
    client_id: cid,
    grant_type: 'authorization_code',
    code,
    redirect_uri: LIVE_REDIRECT,
  });
  const res = await request('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    timeout: 25000,
  });
  const data = JSON.parse(res.buffer.toString('utf8'));
  if (!data.access_token) {
    throw new Error(data.error_description || data.error || 'Microsoft token exchange failed');
  }
  return completeMsaLogin(data, 'live', cid);
}

/** v4.1 — finish the system-browser PKCE login (called by msa-browser.js). */
async function loginWithBrowserCode({ code, verifier, clientId, redirectUri }) {
  const cid = String(clientId || '').trim() || LIVE_CLIENT_ID;
  const msToken = await exchangeBrowserCode({ code, verifier, clientId: cid, redirectUri });
  return completeMsaLogin(msToken, 'pkce', cid);
}

/** Full device-flow login (v4.3 — custom Azure client id ONLY).
 *  onUserCode(userCode, verificationUri) must be shown to the user.
 *  The official Minecraft app id is REFUSED here without any network call:
 *  MSA consumer apps are not Entra-ID directory applications, so the device
 *  endpoint always answers AADSTS700016 (proven in the wild). The sign-in
 *  window is the zero-config path; device codes need your own Azure app. */
let deviceFlowGen = 0; // generation counter — a new login (or cancel) aborts older poll loops
/** Cancel an in-flight device-code login (v4.2). */
function cancelDeviceFlow() { deviceFlowGen++; }
async function loginMicrosoft(clientId, onUserCode) {
  const gen = ++deviceFlowGen;
  const cid = String(clientId || '').trim() || DEFAULT_CLIENT_ID;
  if (cid === LIVE_CLIENT_ID) {
    throw new Error('Device-code sign-in is not possible with the official Minecraft app id — Microsoft refuses it with AADSTS700016 (the app is not an Entra-ID directory application). Use the Sign-in window method instead, or set your own Azure client id (Settings → Advanced / NX Admin → Device & login IDs) to unlock device codes.');
  }
  let dc;
  try {
    dc = await deviceCodeStart(cid);
  } catch (e) {
    throw new Error('Microsoft refused the device-code start (' + e.message + '). Check that your Azure app allows public client flows and personal Microsoft accounts.');
  }
  if (gen !== deviceFlowGen) throw new Error('Sign-in cancelled.');
  onUserCode(dc.user_code, dc.verification_uri);
  const interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    if (gen !== deviceFlowGen) throw new Error('Sign-in cancelled.'); // superseded by a newer attempt / cancel
    let r;
    try { r = await deviceCodePoll(cid, dc.device_code); }
    catch (e) { throw e; }
    if (r.pending) continue;
    return completeMsaLogin(r.msToken, 'v2', cid);
  }
  throw new Error('Device code expired before approval.');
}

/** Silent refresh on startup. Returns account or null. */
async function restoreSession() {
  const t = loadTokens();
  if (!t.msRefresh) return null;
  try {
    const refresh = t.msRefresh;      // raw strings inside the sealed file (v4.3)
    const clientId = t.clientId || LIVE_CLIENT_ID;
    if (!refresh || !clientId) return null;
    // token issuer is decided by the flow that MINTED them:
    //   'live'  → popup window (login.live.com, refresh WITHOUT scope)
    //   'v2'    → device code / old builds (msonline v2, WITH scope)
    //   'pkce'  → v4.1 system browser (msonline v2, WITH scope)
    const isLive = t.flow === 'live';
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, scope: SCOPE,
    });
    if (isLive) body.delete('scope'); // classic MSA refresh: no scope field
    const res = await request(isLive
      ? 'https://login.live.com/oauth20_token.srf'
      : 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(), timeout: 25000,
    });
    const data = JSON.parse(res.buffer.toString('utf8'));
    if (!data.access_token) return null;
    const account = await minecraftFromMsToken(data.access_token);
    try { await gateOrThrow(account); } catch (e) {
      // a BLOCKED account must not keep a working session: wipe tokens + remembered choice
      clearTokens();
      try { require('./settings').set({ lastAccount: null }); } catch {}
      throw e;
    }
    saveTokens({
      ...t,
      msRefresh: data.refresh_token || refresh,
      msAccess: data.access_token,
      msAccessExp: Date.now() + (data.expires_in || 86400) * 1000,
    });
    cachedAccount = account;
    cachedAt = Date.now();
    try { vault.rememberLogin(account); } catch {} // silent restores are remembered too
    notifyAccountChanged(account); // v4.1: cloud identity stays fresh after silent refresh
    logger.auth.info(`Session restored for ${account.name}`);
    return account;
  } catch (e) {
    // tokens stay on disk — the next attempt (e.g. at launch) retries automatically
    logger.auth.warn('Session restore failed (will retry, login is kept): ' + e.message);
    return null;
  }
}

/* (session cache lives near the top of this file — see loadTokens) */

/**
 * Account for launching / display — NEVER destroys the saved session.
 * If MSA tokens exist but the silent refresh fails right now (no internet,
 * Microsoft hiccup), we return null WITHOUT downgrading to offline and WITHOUT
 * overwriting the remembered account — the session is retried automatically
 * on the next launch, so the user never has to sign in again.
 */
async function currentAccount() {
  const { get } = require('./settings');
  const t = loadTokens();
  const last = get().lastAccount;
  if (t.msRefresh && cachedAccount && Date.now() - cachedAt < CACHE_MS) return cachedAccount;
  if (t.msRefresh && (!last || last.type === 'msa')) {
    const acc = await restoreSession();
    if (acc) return acc;
    return null; // keep the saved login — do NOT fall back to offline
  }
  if (last && last.type === 'offline') return offlineAccount(last.name);
  return offlineAccount('Player');
}

/** What the Settings UI should show about the saved session. */
function getSessionInfo() {
  const t = loadTokens();
  const { get } = require('./settings');
  const last = get().lastAccount;
  return {
    hasSavedLogin: !!t.msRefresh,
    profileName: (t.profile && t.profile.name) || (last && last.type === 'msa' && last.name) || null,
    lastType: last ? last.type : null,
    cached: !!(cachedAccount && Date.now() - cachedAt < CACHE_MS),
  };
}

/** Download the active player's skin to .neurax/assets/skins */
async function fetchSkin(account) {
  try {
    if (!account || account.type !== 'msa' || !account.skin || !account.skin.url) return null;
    const dest = path.join(DIRS.skins, `${account.uuid}.png`);
    const { download } = require('./net');
    await download(account.skin.url, dest);
    return dest;
  } catch (e) { logger.auth.warn('skin fetch failed: ' + e.message); return null; }
}

module.exports = {
  loginOffline, loginMicrosoft, restoreSession, currentAccount, getSessionInfo,
  deviceCodeStart, deviceCodePoll, minecraftFromMsToken,
  loginWithMsaCode, msaAuthorizeUrl, loginWithBrowserCode,
  pkcePair, browserAuthorizeUrl, exchangeBrowserCode, completeMsaLogin,
  cancelDeviceFlow,
  clearTokens, setSafeStorage, fetchSkin, loadTokens, saveTokens,
  setLoginGate, setOnAccountChanged,
  DEFAULT_CLIENT_ID, LIVE_CLIENT_ID, LIVE_REDIRECT,
};
