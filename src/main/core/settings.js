// settings.js — persisted launcher settings, ENCRYPTED at rest (v4.3).
//
// The settings used to live in .neurax/settings.json as readable JSON — which
// also exposed the owner admin key (nxAdminPass) and the NX Cloud database
// connection string to anyone who opened the folder. Since v4.3 the settings
// are stored in .neurax/settings.vault: the same AES-256-GCM envelope as the
// memory vault (machine-bound .vk ⊕ pepper → scrypt → AES-256-GCM), opened in
// an editor it is pure binary ciphertext, and any edit breaks the auth tag
// (the file is quarantined and rebuilt from defaults).
//
// Migration: a legacy plaintext settings.json is imported once, its values
// kept, then the plaintext file is SHREDDED (multi-pass overwrite + delete).
//
// v4.5 — SUPABASE OUT OF THE BOX: the default nxSupabaseUrl is the owner's
// NX Cloud database (nx-canonical.js), so EVERY installation connects to NX
// Cloud directly — the Control Center / local relay never needs to have run.
// Installations whose stored URL is empty (v4.4 shipped an empty default)
// are seeded with it once at load.
//
// NEVER PERSISTED (kept out of the file entirely):
//   nxAdminPass    — the owner admin key is fixed in nx-canonical.js and
//                    resolved at RUNTIME (see nx-admin-keys.js); it only ever
//                    lives in memory + the encrypted vaults.
//   msRefreshToken — dead legacy field; old builds stored a Microsoft refresh
//                    token here in PLAINTEXT. Dropped from storage; any value
//                    found in the legacy file is destroyed with the migration.
'use strict';
const path = require('path');
const { DIRS, readJSON } = require('./paths');
const logger = require('./logger');
const nxKeys = require('./nx-admin-keys');
const canonical = require('./nx-canonical');
const vault = require('./nx-vault');

const os = require('os');

const DEFAULTS = {
  version: 4,
  theme: 'emerald',            // emerald | orange | purple | cyan
  memoryMB: Math.min(4096, Math.floor(os.totalmem() / 1024 / 1024 / 4 / 256) * 256 || 2048),
  javaPathOverride: '',
  closeLauncherOnLaunch: false,     // v4.4 — quit Neurax when the game starts (ZERO cpu/gpu/ram) and auto-reopen it when Minecraft exits (tiny watchdog)
                                     // v1.0-R2 — the old keepLauncherOpen toggle was REMOVED (redundant with this one; stripped from stored settings at load)
  windowWidth: 1000,
  windowHeight: 800,
  rememberWindowSize: true,
  concurrency: 8,
  msClientId: '',
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
  nxSupabaseUrl: canonical.OWNER_SUPABASE_URL, // v4.5 — the owner's NX Cloud database: EVERY launcher connects to it out of the box (no NX Cloud console run needed). Change it in nx-canonical.js only.
  nxSupabasePooler: '',                // cached IPv4 session-pooler host (auto-discovered when IPv6 is unavailable)
  nxAdminPass: nxKeys.ADMIN_KEY,       // owner admin key for the NEURAX CONTROL CENTER — fixed in nx-canonical.js, resolved at runtime (v4.5), not user-editable in the UI. Runtime-only: NEVER written to disk (v4.3).
  nxEnabled: true,                     // NX Cloud sync / chat / announcements
  nxLegacyServer: false,               // v4.4 — opt-in legacy self-hosted relay (only used when the Supabase URL is cleared)
  memoryAuto: true,                    // v1.0 — pick the heap FOR THIS PC at every launch (RAM × GPU class); untick to use the slider
  smartInstall: true,                  // v1.0 — Modrinth one-click Smart Install can be switched off
  neuraxClient: true,                  // v1.0 — the NX core mod is injected into Fabric/Quilt launches (adaptive FPS engine)
  clientThirdPartyMods: false,         // v1.0-R2 — owner request: Sodium & friends are OPT-IN (default OFF — only Neurax's own mods inject automatically). When enabled, VulkanMod still blocks the Sodium family and already-installed mods are never duplicated.
  clientFpsMode: 'ultra',              // v1.0 — 'balanced' (proven classics) | 'ultra' (everything + parallel chunk loading) — only applies to the opt-in third-party stack
  nxIdentity: null,                    // cached {uuid, fingerprint, created}
  keysAcknowledgedAt: null,            // v4.4 legacy — key display was removed in v4.5 (field kept so stored settings merge cleanly)
};

const SETTINGS_FILE = path.join(DIRS.root, 'settings.vault');   // encrypted (v4.3)
const LEGACY_FILE = path.join(DIRS.root, 'settings.json');      // pre-4.3 plaintext

// Fields that exist in memory (so .get() consumers keep working) but must
// NEVER be written to the settings file.
const RUNTIME_ONLY = new Set(['nxAdminPass', 'msRefreshToken']);

// v1.0 — settings removed with their features. An old stored value is
// deleted once at load so it never comes back:
//   nxUiInject        resource-pack injection (removed by the owner's request)
//   clientGuiTheme    themed GUI resource pack injection (same removal)
//   keepLauncherOpen  superseded by closeLauncherOnLaunch (owner request R2:
//                     two overlapping launch-behaviour toggles confused the
//                     settings page — only "Close launcher on launch" remains)
const REMOVED_KEYS = new Set(['nxUiInject', 'clientGuiTheme', 'keepLauncherOpen']);

let settings = null;

function stripRuntimeOnly(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (!RUNTIME_ONLY.has(k)) out[k] = obj[k];
  return out;
}

function persist() {
  vault.writeSealed(DIRS.root, SETTINGS_FILE, stripRuntimeOnly(settings));
}

function load() {
  let stored = vault.readSealed(DIRS.root, SETTINGS_FILE);
  if (!stored) {
    // First run of v4.3+ — or the one-time migration from the legacy
    // plaintext settings.json. Import the old values, drop the forbidden
    // fields, seal the result, then SHRED the plaintext file.
    const legacy = readJSON(LEGACY_FILE, null);
    stored = { ...DEFAULTS, ...(legacy || {}), version: DEFAULTS.version };
    delete stored.nxAdminPass;
    delete stored.msRefreshToken; // legacy plaintext refresh token — destroyed
    if (legacy) {
      if (vault.shredPlaintext(LEGACY_FILE)) {
        logger.core.info('Settings migrated to encrypted settings.vault — plaintext settings.json shredded.');
      } else {
        logger.core.warn('Settings migrated, but the plaintext settings.json could not be fully shredded — delete it manually.');
      }
    }
    vault.writeSealed(DIRS.root, SETTINGS_FILE, stored);
    logger.core.info('Settings created/migrated (encrypted).');
  }
  // keep the version field current without spamming writes
  if (stored.version !== DEFAULTS.version) {
    stored = { ...stored, version: DEFAULTS.version };
    vault.writeSealed(DIRS.root, SETTINGS_FILE, stripRuntimeOnly(stored));
  }
  // v4.5 — seed the owner's NX Cloud database into installations that have
  // no URL stored (v4.4 shipped an empty default; the owner's Supabase is
  // now the out-of-the-box cloud for every launcher).
  if (!String(stored.nxSupabaseUrl || '').trim()) {
    stored.nxSupabaseUrl = DEFAULTS.nxSupabaseUrl;
    vault.writeSealed(DIRS.root, SETTINGS_FILE, stripRuntimeOnly(stored));
    logger.core.info('NX Cloud database seeded from the owner configuration (nx-canonical.js).');
  }
  settings = { ...DEFAULTS, ...stored, nxAdminPass: nxKeys.ADMIN_KEY };
  // v1.0 — strip settings whose features no longer exist (one-time rewrite)
  const removed = Object.keys(stored).filter((k) => REMOVED_KEYS.has(k));
  if (removed.length) {
    for (const k of removed) delete settings[k];
    vault.writeSealed(DIRS.root, SETTINGS_FILE, stripRuntimeOnly(settings));
    logger.core.info(`Removed obsolete settings: ${removed.join(', ')} (features removed in v1.0).`);
  }
  return settings;
}

function get() {
  if (!settings) load();
  return settings;
}

function save() { persist(); }

function set(patch) {
  if (!settings) load();
  const allowed = {};
  for (const k of Object.keys(patch)) {
    if (RUNTIME_ONLY.has(k)) continue; // nxAdminPass fixed / msRefreshToken gone — never overridable via settings writes
    if (k in DEFAULTS) allowed[k] = patch[k];
  }
  Object.assign(settings, allowed);
  persist();
  return settings;
}

function resetCachePathsOnly() { /* settings survive cache resets */ }

module.exports = { load, get, set, save, DEFAULTS };
