// nx-cloud.js — NX Cloud orchestrator.
//
// THREE TRANSPORT MODES (nothing was removed — the self-hosted server still
// works exactly as before, it is just no longer the only option):
//
//   1. SUPABASE (default)  — the launcher talks straight to the owner's
//      Supabase Postgres (see supabase/nx-supabase-setup.sql). One sync tick
//      every 5 SECONDS: heartbeat, presence, locks, announcements, chat.
//      When the database is offline the UI keeps its cached data and queued
//      messages and reconnects silently — features never break hard.
//   2. SERVER (legacy)     — the bundled self-hosted nx-cloud/server.js relay
//      (HTTP + websocket), selected by clearing the Supabase URL in Settings.
//   3. OFFLINE             — no cloud configured: cached data only.
//
// Shared responsibilities that stay here regardless of mode: the LOCK
// enforcement (quit Minecraft + LOCKED screen + a local read-only mirror so a
// locked device STAYS locked across restarts), the device profile payload
// (player, skin head, instances, mods) and the API surface for the renderer.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { DIRS } = require('./paths');
const settingsMod = require('./settings');
const logger = require('./logger');
const identity = require('./device-identity');
const heads = require('./skin-heads');
const nxSupa = require('./nx-supabase');

const HEARTBEAT_MS = 20000;   // legacy server mode only (supabase ticks every 5s)
const LOCK_FILE = path.join(DIRS.root, '.nx-lock');

let broadcast = () => {};
let mode = 'offline';         // 'supabase' | 'server' | 'offline'
let state = {
  connected: false, online: 0, total: 0,
  uuid: null, deviceToken: null, cloudUrl: null,
  locked: null,          // { reason, by, until, at }
  announcements: [],     // latest known list (legacy mirror; supabase keeps its own)
  serverTime: 0, lastError: null,
};
let hbTimer = null;
let ws = null;
let wsGiveUp = false;
let gameRunning = false;
let inflight = {};
let cachedPlayerName = '';

function setBroadcast(fn) { broadcast = fn; }
function emit(event, payload) { try { broadcast(event, payload); } catch {} }
function publicState() {
  if (mode === 'supabase') return nxSupa.publicState();
  const { connected, online, total, uuid, locked, announcements, cloudUrl, lastError } = state;
  return { mode, connected, online, total, uuid, locked, announcements, cloudUrl, lastError, via: mode };
}

/* ---------------------------------------------------------------- http core (legacy server) */
function baseUrl() {
  const set = settingsMod.get();
  let u = (set.nxCloudUrl || 'http://127.0.0.1:8790').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}
function request(method, pathname, { json, raw, headers = {}, timeout = 15000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const url = baseUrl() + pathname;
    const mod = url.startsWith('https') ? require('https') : require('http');
    let req;
    try { req = mod.request(url, { method, headers, timeout }); }
    catch (e) { return reject(e); }
    req.on('timeout', () => { req.destroy(new Error('NX Cloud request timed out')); });
    req.on('error', reject);
    const chunks = [];
    let size = 0;
    req.on('response', (res) => {
      const total = Number(res.headers['content-length']) || 0;
      res.on('data', (c) => { chunks.push(c); size += c.length; if (onProgress && total) onProgress(size, total); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let body = null;
        try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(body);
        else reject(new Error((body && body.error) || `HTTP ${res.statusCode}`));
      });
      res.on('error', reject);
    });
    if (json !== undefined) {
      const body = Buffer.from(JSON.stringify(json), 'utf8');
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', body.length);
      req.end(body);
    } else if (raw) {
      raw.pipe(req);
      raw.on('error', (e) => req.destroy(e));
    } else req.end();
  });
}
function authed(method, pathname, opts = {}) {
  return request(method, pathname, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + state.deviceToken } });
}

/* ------------------------------------------------------------ device profile */
function modsOf(gameDir) {
  const out = [];
  try {
    for (const sub of ['mods', 'resourcepacks']) {
      const p = path.join(gameDir, sub);
      if (!fs.existsSync(p)) continue;
      for (const f of fs.readdirSync(p)) {
        if (f.endsWith('.jar') || f.endsWith('.zip')) out.push(f);
        if (out.length >= 200) break;
      }
    }
  } catch {}
  return out;
}
async function profilePayload() {
  const auth = require('./auth');
  const store = require('./store');
  let account = null;
  try { account = await auth.currentAccount(); } catch {}
  const insts = [];
  try {
    for (const i of store.listInstances().slice(0, 40)) {
      let mods = [];
      try { mods = modsOf(store.instanceGameDir(i.id)); } catch {}
      insts.push({ name: i.name, version: i.version, loader: i.loader, mods });
    }
  } catch {}
  cachedPlayerName = account ? account.name : cachedPlayerName;
  nxSupa.setPlayerName(account ? account.name : '');
  return {
    deviceName: os.hostname().slice(0, 60),
    gameRunning,
    player: account ? { name: account.name, uuid: account.uuid || '', type: account.type === 'msa' ? 'msa' : 'offline' } : null,
    instances: insts,
  };
}

/* ---------------------------------------------------------------- lock enforcement */
async function killMinecraftProcesses() {
  try { const game = require('./game'); const r = game.stopGame(); if (r && r.stopped) return true; } catch {}
  if (process.platform === 'win32') {
    const marker = DIRS.root.toLowerCase();
    const list = await new Promise((resolve) => {
      execFile('wmic', ['process', 'where', "name='java.exe'", 'get', 'processid,commandline'], { windowsHide: true, timeout: 8000, maxBuffer: 8e6 },
        (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    const pids = [];
    for (const line of list.split('\n')) {
      const l = line.trim(); if (!l || /processid/i.test(l)) continue;
      const m = l.match(/(\d+)\s*$/);
      if (m && l.toLowerCase().includes(marker)) pids.push(m[1]);
    }
    for (const pid of pids) {
      try { execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true }, () => {}); } catch {}
    }
    if (pids.length) { logger.nx?.info?.(`lock: force-quit ${pids.length} orphaned Minecraft process(es)`); return true; }
  }
  return false;
}

function persistLockLocal(lock) {
  try {
    if (!lock) { try { fs.unlinkSync(LOCK_FILE); } catch {} return; }
    fs.mkdirSync(DIRS.root, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ ...lock, cachedAt: Date.now() }), 'utf8');
    if (process.platform === 'win32') {
      execFile('attrib', ['+H', '+R', LOCK_FILE], { windowsHide: true }, () => {});
    } else { try { fs.chmodSync(LOCK_FILE, 0o444); } catch {} }
  } catch (e) { logger.nx?.warn?.('lock cache write failed: ' + e.message); }
}

/** Apply a lock state coming from the cloud (or the local mirror at boot). */
async function applyLock(lock) {
  const changed = JSON.stringify(lock || null) !== JSON.stringify(state.locked || null);
  state.locked = lock || null;
  persistLockLocal(lock);
  if (lock) {
    await killMinecraftProcesses(); // requirement: game auto-quits on lock
    logger.nx?.warn?.(`DEVICE LOCKED: ${lock.reason} ${lock.until ? '(until ' + new Date(lock.until).toLocaleString() + ')' : ''}`);
  } else if (changed) {
    logger.nx?.info?.('Device unlocked by administrator.');
  }
  if (changed) emit('nx:lock', { locked: lock || null, uuid: state.uuid || null });
}

/* ================================================================ LEGACY SERVER MODE */
function presenceOf(p) { return p ? { online: p.online, total: p.total } : { online: state.online, total: state.total }; }

async function legacyRegister({ quiet = false } = {}) {
  const id = identity.getIdentity() || await identity.ensureIdentity();
  const b = await request('POST', '/api/register', {
    json: {
      fingerprint: id.fingerprint,
      uuidHint: id.uuid,
      deviceName: os.hostname(),
      platform: process.platform,
      appVersion: require('../../../package.json').version,
    },
  });
  state.deviceToken = b.token;
  state.uuid = b.uuid;
  if (b.recovered || b.uuid !== id.uuid) identity.adoptCloudIdentity(b.uuid);
  state.connected = true;
  state.lastError = null;
  emit('nx:presence', { connected: true, ...presenceOf(b.online) });
  return b;
}

async function legacyHeartbeat() {
  if (!state.deviceToken) return;
  if (inflight.hb) return; inflight.hb = true;
  try {
    const payload = await profilePayload();
    const b = await authed('POST', '/api/heartbeat', { json: payload });
    const skin = await heads.headDataUrl({ uuid: payload.player?.uuid, name: payload.player?.name });
    if (skin) { authed('POST', '/api/heartbeat', { json: { skinHead: skin } }).catch(() => {}); }
    state.connected = true; state.lastError = null;
    if (b.online) { state.online = b.online.online; state.total = b.online.total; emit('nx:presence', { connected: true, ...presenceOf(b.online) }); }
    if (b.serverTime) state.serverTime = b.serverTime;
    await applyLock(b.locked || null);
    if (Array.isArray(b.announcements)) {
      state.announcements = b.announcements;
      emit('nx:announcements', { announcements: state.announcements });
    }
  } catch (e) {
    state.connected = false;
    state.lastError = e.message;
    emit('nx:presence', { connected: false, online: state.online, total: state.total });
    if (!String(e.message).includes('timed out')) { state.deviceToken = null; }
  } finally { inflight.hb = false; }
}

function connectWs() {
  if (wsGiveUp || !state.deviceToken) return;
  const url = baseUrl().replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(state.deviceToken);
  try {
    ws = new (require('ws'))(url, { handshakeTimeout: 8000 });
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === 'presence') { state.online = m.online; state.total = m.total; emit('nx:presence', { connected: true, online: m.online, total: m.total }); }
      else if (m.type === 'lock') { applyLock(m.lock || null).catch(() => {}); legacyHeartbeat().catch(() => {}); }
      else if (m.type === 'announce') {
        if (m.announcement) {
          const list = state.announcements.filter((a) => a.id !== m.announcement.id);
          list.unshift(m.announcement);
          state.announcements = list; emit('nx:announcements', { announcements: state.announcements });
        }
      } else if (m.type === 'announce-deleted') {
        state.announcements = state.announcements.filter((a) => a.id !== m.id);
        emit('nx:announcements', { announcements: state.announcements });
      } else if (m.type === 'chat') { emit('nx:chat', m); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { ws = null; if (!wsGiveUp) setTimeout(connectWs, 15000); });
  } catch { /* ws module unavailable — polling fallback is active */ }
}

function legacyShutdown() {
  wsGiveUp = true;
  try { ws && ws.close(); } catch {}
}

/* ================================================================= LIFECYCLE */
async function init(bcastFn) {
  if (bcastFn) setBroadcast(bcastFn);
  const set = settingsMod.get();
  if (!set.nxEnabled) {
    mode = 'offline';
    logger.nx?.info?.('NX Cloud disabled in settings — running local-only.');
    return publicState();
  }
  // boot-time local lock mirror: a locked device stays locked even offline
  try {
    const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (l && (!l.until || Date.now() < l.until)) {
      state.locked = l;
      emit('nx:lock', { locked: l, uuid: null });
    } else persistLockLocal(null);
  } catch {}

  mode = (set.nxSupabaseUrl || '').trim() ? 'supabase' : 'server';

  if (mode === 'supabase') {
    nxSupa.setIdentityProvider(() => identity.getIdentity() || identity.ensureIdentity());
    try { await profilePayload(); } catch {} // primes cachedPlayerName for queued msgs
    const st = await nxSupa.start({
      broadcast,
      onLock: (lock) => { applyLock(lock).catch(() => {}); },
      appVersion: require('../../../package.json').version,
      profileProvider: () => profilePayload(),
      identity: () => identity.getIdentity() || identity.ensureIdentity(),
    });
    state.uuid = st.uuid;
    return publicState();
  }

  // legacy self-hosted server mode
  try {
    await legacyRegister();
    logger.nx?.info?.(`Registered with NX Cloud (${state.cloudUrl || baseUrl()}) as ${state.uuid}`);
    connectWs();
    await legacyHeartbeat();
  } catch (e) {
    state.lastError = e.message;
    logger.nx?.warn?.(`NX Cloud unreachable (${e.message}) — will retry silently.`);
  }
  clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    if (!state.deviceToken) { legacyRegister({ quiet: true }).then(connectWs).catch(() => {}); return; }
    legacyHeartbeat().catch(() => {});
  }, HEARTBEAT_MS);
  return publicState();
}

function shutdown() {
  clearInterval(hbTimer);
  if (mode === 'supabase') { nxSupa.stop().catch(() => {}); return; }
  legacyShutdown();
}

function setGameRunning(v) {
  if (gameRunning === v) return;
  gameRunning = v;
  if (mode === 'supabase') { nxSupa.api.refresh().catch(() => {}); return; }
  legacyHeartbeat().catch(() => {});
}

/* ================================================================= API (renderer) */
const api = {
  status() { return publicState(); },
  identity() { return identity.getIdentity(); },
  mode() { return mode; },
  async setCloudUrl(url) { // legacy server URL
    settingsMod.set({ nxCloudUrl: String(url || '').trim() || 'http://127.0.0.1:8790' });
    if (mode !== 'supabase') { state.deviceToken = null; shutdown(); wsGiveUp = false; return init(); }
    return publicState();
  },
  async setSupabaseUrl(url) {
    settingsMod.set({ nxSupabaseUrl: String(url || '').trim() });
    shutdown();
    mode = (settingsMod.get().nxSupabaseUrl || '').trim() ? 'supabase' : 'server';
    wsGiveUp = false;
    return init();
  },
  async testSupabase(url) { return nxSupa.api.testConnection(url); },
  async refresh() { return mode === 'supabase' ? nxSupa.api.refresh() : (await legacyHeartbeat(), publicState()); },
  lockState() { return mode === 'supabase' ? nxSupa.publicState().locked : state.locked; },

  /* ---- announcements (admin) ---- */
  annCreate: (p) => supabaseOnly('annCreate', () => nxSupa.api.annCreate(p)),
  annUpdate: (p) => supabaseOnly('annUpdate', () => nxSupa.api.annUpdate(p)),
  annDelete: (p) => supabaseOnly('annDelete', () => nxSupa.api.annDelete(p)),
  adminList: () => supabaseOnly('adminList', () => nxSupa.api.adminList()),
  adminLock: (p) => supabaseOnly('adminLock', () => nxSupa.api.adminLock(p)),
  adminUnlock: (p) => supabaseOnly('adminUnlock', () => nxSupa.api.adminUnlock(p)),
  flushQueue: () => supabaseOnly('flushQueue', () => nxSupa.api.flushQueue()),

  /* ---- player heads (all modes — cached, never throws) ---- */
  async skinHead(p) {
    const uuid = (p && p.uuid) || '';
    const name = (p && p.name) || '';
    if (mode === 'supabase') {
      try { return { url: await nxSupa.api.skinHeadFor({ uuid, name }) }; } catch {}
    }
    try { return { url: await heads.headDataUrl({ uuid, name }) }; } catch {}
    return { url: heads.generatedAvatarDataUrl(uuid || name || 'nx') };
  },

  /* ---- chat ---- */
  chatList() { return mode === 'supabase' ? nxSupa.api.chatList() : authed('GET', '/api/chat/list'); },
  chatCreate(p) { return mode === 'supabase' ? nxSupa.api.chatCreate(p) : authed('POST', '/api/chat/create', { json: { name: p.name } }); },
  chatInvite(p) { return mode === 'supabase' ? nxSupa.api.chatInvite(p) : authed('POST', '/api/chat/invite', { json: { chatId: p.chatId, uuid: p.ref, name: p.ref } }); },
  chatLeave(p) { return mode === 'supabase' ? nxSupa.api.chatLeave(p) : authed('POST', '/api/chat/leave', { json: { chatId: p.chatId } }); },
  chatMessages(p) { return mode === 'supabase' ? nxSupa.api.chatMessages(p) : authed('GET', `/api/chat/messages?chatId=${encodeURIComponent(p.chatId)}&since=${p.since || 0}`); },
  chatSend(p) { return mode === 'supabase' ? nxSupa.api.chatSend(p) : authed('POST', '/api/chat/message', { json: { chatId: p.chatId, type: 'text', text: p.text } }); },
  async chatSendFile(p, onProgress2) {
    const onProgress = p.onProgress || onProgress2;
    if (mode === 'supabase') return nxSupa.api.chatSendFile({ chatId: p.chatId, filePath: p.filePath, kind: p.kind, onProgress });
    const fsstat = fs.statSync(p.filePath);
    if (fsstat.size > 100 * 1024 * 1024) throw new Error('Files are limited to 100MB');
    const name = path.basename(p.filePath);
    const mime = p.kind || (/\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : /\.(mp4|mkv|webm|mov|avi)$/i.test(name) ? 'video' : 'file');
    const up = await authed('POST', '/api/upload', {
      raw: fs.createReadStream(p.filePath),
      headers: { 'X-File-Name': encodeURIComponent(name), 'X-File-Size': String(fsstat.size) },
      timeout: 30 * 60000, onProgress,
    });
    return authed('POST', '/api/chat/message', {
      json: { chatId: p.chatId, type: mime, fileId: up.fileId, fileName: name, fileSize: fsstat.size, text: '' },
    });
  },
  fileUrl(p) { return `${baseUrl()}/files/${p.fileId}/${encodeURIComponent(p.fileName || 'file')}`; },
  /** Small images for inline display in BOTH modes (≤20MB → data URL). */
  async fileDataUrl(p, onProgress) {
    if (mode !== 'supabase') {
      const buf = await authed('GET', `/files/${p.fileId}/${encodeURIComponent(p.fileName || 'file')}`, { timeout: 30 * 60000, onProgress });
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      return { url: 'data:application/octet-stream;base64,' + b.toString('base64'), size: b.length };
    }
    const dest = await nxSupa.api.downloadFile({ fileId: p.fileId, fileName: p.fileName || 'file', destDir: path.join(DIRS.temp, 'chat-media'), onProgress });
    const b = fs.readFileSync(dest);
    return { url: 'data:application/octet-stream;base64,' + b.toString('base64'), size: b.length, file: dest };
  },
  async downloadFile(p, onProgress2) {
    const onProgress = p.onProgress || onProgress2;
    if (mode === 'supabase') return nxSupa.api.downloadFile({ fileId: p.fileId, fileName: p.fileName, destDir: p.destDir, onProgress });
    const dest = path.join(p.destDir || path.join(DIRS.root, 'downloads'), p.fileName || p.fileId);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = await authed('GET', `/files/${p.fileId}/${encodeURIComponent(p.fileName || 'file')}`, { timeout: 30 * 60000, onProgress });
    fs.writeFileSync(dest, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    return dest;
  },
};

function supabaseOnly(name, fn) {
  if (mode === 'supabase') return fn();
  throw new Error(`"${name}" needs the Supabase connection (Settings → NX Cloud). The legacy server does not support this action.`);
}

module.exports = { init, shutdown, setBroadcast, setGameRunning, publicState, api, applyLock, baseUrl };
