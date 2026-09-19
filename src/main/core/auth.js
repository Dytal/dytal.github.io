// auth.js — Microsoft account login -> XBL -> XSTS -> Minecraft services.
// Tokens are stored encrypted (Electron safeStorage/DPAPI on Windows) in .neurax/auth.
// TWO login paths:
//   1. POPUP WINDOW (default, easiest): an embedded window opens login.live.com with
//      the official Minecraft MSA app id (00000000402b5328). The user just signs in
//      (email/password/2FA) — no codes, no Azure setup. The OAuth code lands on the
//      classic oauth20_desktop.srf redirect, which the app intercepts. Verified live:
//      scope XboxLive.signin offline_access is accepted for this app.
//   2. DEVICE CODE (fallback / advanced): with a custom Azure client id — same as
//      before (login.microsoftonline.com consumers tenant).
// Offline mode available for offline play.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS, writeJSON, readJSON } = require('./paths');
const { getJSON, request } = require('./net');
const logger = require('./logger');
const vault = require('./nx-vault'); // encrypted memory: remembers logins + passkeys

const SCOPE = 'XboxLive.signin offline_access';
// Classic MSA endpoints + the official Minecraft app id — used by the popup flow.
const LIVE_CLIENT_ID = '00000000402b5328';
const LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
// Fallback device flow needs a third-party Azure app (first-party ids like Azure CLI
// are rejected: "users are not permitted to consent to first party applications").
const DEFAULT_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const TOKENS_FILE = path.join(DIRS.auth, 'tokens.json');

let safe = null;
function setSafeStorage(s) { safe = s; } // called from main with electron.safeStorage

function encrypt(text) {
  if (safe && safe.isEncryptionAvailable()) {
    return { enc: 'safeStorage', v: safe.encryptString(text).toString('base64') };
  }
  return { enc: 'plain', v: Buffer.from(text, 'utf8').toString('base64') };
}
function decrypt(blob) {
  if (!blob) return null;
  if (blob.enc === 'safeStorage' && safe && safe.isEncryptionAvailable()) {
    return safe.decryptString(Buffer.from(blob.v, 'base64'));
  }
  return Buffer.from(blob.v, 'base64').toString('utf8');
}

function loadTokens() { return readJSON(TOKENS_FILE, {}); }
function saveTokens(t) { writeJSON(TOKENS_FILE, t); }

/* Short-lived memo so the parallel restore attempts (app boot + renderer boot
   + opening Settings) never fire several refreshes for the same token —
   Microsoft rotates refresh tokens and parallel refreshes can invalidate one. */
let cachedAccount = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;
function invalidateCache() { cachedAccount = null; cachedAt = 0; }
function clearTokens() { try { fs.rmSync(TOKENS_FILE, { force: true }); } catch {} invalidateCache(); }

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
  if (data.error) throw new Error(data.error_description || data.error);
  return { pending: false, msToken: data };
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
  const body = new URLSearchParams({
    client_id: clientId || LIVE_CLIENT_ID,
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
  const account = await minecraftFromMsToken(data.access_token);
  saveTokens({
    flow: 'live',
    msRefresh: encrypt(data.refresh_token || ''),
    msAccess: encrypt(data.access_token),
    msAccessExp: Date.now() + (data.expires_in || 86400) * 1000,
    clientId: encrypt(String(clientId || LIVE_CLIENT_ID)),
    profile: { name: account.name, uuid: account.uuid },
  });
  cachedAccount = account; cachedAt = Date.now();
  const { set } = require('./settings');
  set({ lastAccount: { type: 'msa', name: account.name, uuid: account.uuid } });
  try { vault.rememberLogin(account); } catch {}
  logger.auth.info(`Microsoft login OK: ${account.name}`);
  return account;
}

/** Full device-flow login. onUserCode(userCode, verificationUri) must be shown to the user. */
async function loginMicrosoft(clientId, onUserCode) {
  const cid = String(clientId || '').trim() || DEFAULT_CLIENT_ID;
  const dc = await deviceCodeStart(cid);
  onUserCode(dc.user_code, dc.verification_uri);
  const interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    let r;
    try { r = await deviceCodePoll(cid, dc.device_code); }
    catch (e) { throw e; }
    if (r.pending) continue;
    const account = await minecraftFromMsToken(r.msToken.access_token);
    saveTokens({
      flow: 'v2',
      msRefresh: encrypt(r.msToken.refresh_token || ''),
      msAccess: encrypt(r.msToken.access_token),
      msAccessExp: Date.now() + (r.msToken.expires_in || 86400) * 1000,
      clientId: encrypt(cid),
      profile: { name: account.name, uuid: account.uuid },
    });
    cachedAccount = account; cachedAt = Date.now();
    const { set } = require('./settings');
    set({ lastAccount: { type: 'msa', name: account.name, uuid: account.uuid } });
    try { vault.rememberLogin(account); } catch {}
    logger.auth.info(`Microsoft login OK: ${account.name}`);
    return account;
  }
  throw new Error('Device code expired before approval.');
}

/** Silent refresh on startup. Returns account or null. */
async function restoreSession() {
  const t = loadTokens();
  if (!t.msRefresh) return null;
  try {
    const refresh = decrypt(t.msRefresh);
    const clientId = decrypt(t.clientId);
    if (!refresh || !clientId) return null;
    // tokens from the popup flow live on login.live.com, old device-flow tokens on msonline
    const isLive = t.flow === 'live' || clientId === LIVE_CLIENT_ID;
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
    saveTokens({
      ...t,
      msRefresh: encrypt(data.refresh_token || refresh),
      msAccess: encrypt(data.access_token),
      msAccessExp: Date.now() + (data.expires_in || 86400) * 1000,
    });
    cachedAccount = account;
    cachedAt = Date.now();
    try { vault.rememberLogin(account); } catch {} // silent restores are remembered too
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
  loginWithMsaCode, msaAuthorizeUrl,
  clearTokens, setSafeStorage, fetchSkin, loadTokens,
  DEFAULT_CLIENT_ID, LIVE_CLIENT_ID, LIVE_REDIRECT,
};
