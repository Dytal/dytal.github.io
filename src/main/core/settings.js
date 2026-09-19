// settings.js — persisted launcher settings in .neurax/settings.json
'use strict';
const os = require('os');
const { DIRS, writeJSON, readJSON } = require('./paths');
const logger = require('./logger');
const nxKeys = require('./nx-admin-keys');

const DEFAULTS = {
  version: 4,
  theme: 'emerald',            // emerald | orange | purple | cyan
  memoryMB: Math.min(4096, Math.floor(os.totalmem() / 1024 / 1024 / 4 / 256) * 256 || 2048),
  javaPathOverride: '',
  keepLauncherOpen: true,
  windowWidth: 1000,
  windowHeight: 800,
  rememberWindowSize: true,
  concurrency: 8,
  msClientId: '',
  msRefreshToken: '',
  lastAccount: null,           // { type: 'msa'|'offline', name, uuid }
  selectedInstanceId: null,
  selectedVersion: null,
  eulaAcceptedServers: true,
  showSnapshots: true,
  showOldVersions: true,
  playFullscreen: false,
  gameWidth: 1280,
  gameHeight: 720,
  // --- NX (v3.1) ---
  nxCloudUrl: 'http://127.0.0.1:8790', // legacy self-hosted relay (optional; 8765 = Supabase Control Center)
  nxSupabaseUrl: 'postgresql://postgres:AnishWorrior001@db.invoqcismjgwbropdqvs.supabase.co:5432/postgres', // direct NX Cloud database (default = owner's Supabase)
  nxSupabasePooler: '',                // cached IPv4 session-pooler host (auto-discovered when IPv6 is unavailable)
  nxAdminPass: nxKeys.ADMIN_KEY,       // FIXED owner admin key for the NEURAX CONTROL CENTER (baked in, not user-editable)
  nxEnabled: true,                     // NX Cloud sync / chat / announcements
  nxUiInject: true,                    // auto-inject the NX-UI 64x resource pack
  nxIdentity: null,                    // cached {uuid, fingerprint, created}
};

let settings = null;

function load() {
  settings = readJSON(DIRS.root + '/settings.json', null);
  if (!settings || settings.version !== DEFAULTS.version) {
    const old = settings || {};
    settings = { ...DEFAULTS, ...old, version: DEFAULTS.version };
    save();
    logger.core.info('Settings created/migrated.');
  }
  // The admin key is FIXED (owner-baked) — overwrite anything stale stored in the
  // file so the Control Center always reads the same key, no matter what.
  settings.nxAdminPass = nxKeys.ADMIN_KEY;
  return settings;
}

function get() {
  if (!settings) load();
  return settings;
}

function save() {
  writeJSON(DIRS.root + '/settings.json', settings);
}

function set(patch) {
  if (!settings) load();
  const allowed = {};
  for (const k of Object.keys(patch)) {
    if (k === 'nxAdminPass') continue; // FIXED owner key — never overridable via settings writes
    if (k in DEFAULTS || k === 'msRefreshToken') allowed[k] = patch[k];
  }
  Object.assign(settings, allowed);
  save();
  return settings;
}

function resetCachePathsOnly() { /* settings survive cache resets */ }

module.exports = { load, get, set, save, DEFAULTS };
