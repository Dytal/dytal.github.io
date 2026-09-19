// nx-vault.js — the NEURAX encrypted memory vault.
//
// WHAT IT IS
//   A small, dependency-free credential store shared by the launcher (main
//   process) and the standalone NEURAX CONTROL CENTER (plain node). It
//   "remembers logins and passkeys" exactly as the owner asked:
//     - launcher : remembered player logins (offline + Microsoft), the owner
//                  admin key and the owner unlock passkey, last admin unlock.
//     - console  : remembered browser sessions (a logged-in browser STAYS
//                  logged in across console restarts), the owner admin key,
//                  the owner unlock passkey and a login history.
//
// PROTECTION (the owner's hard requirements: "not readable and editable,
// read only and encrypted"):
//   1. ENCRYPTED      — AES-256-GCM (authenticated). The key is scrypt-
//                       stretched from a random per-machine key file (.vk,
//                       written once, 32 bytes) XOR-mixed with a pepper baked
//                       into this module. The vault file alone is useless on
//                       another PC or without this build; .vk alone is
//                       meaningless random bytes.
//   2. READ-ONLY      — the file is chmod'd 0400 (POSIX) / set READ-ONLY
//                       (Windows) after every write. It is briefly unlocked
//                       by this module for a legit update, then re-locked.
//                       Opening it in a text editor shows only ciphertext,
//                       and editors refuse to save changes back.
//   3. TAMPER-HEALING — any edit/corruption breaks the GCM auth tag: the
//                       file is quarantined as *.corrupt-<ts> and rebuilt
//                       from defaults on the next load. Silent edits are
//                       impossible.
//
// FILE FORMAT (little endian, ciphertext after the 50-byte header):
//   "NXVB1\0" magic (6) | scrypt salt (16) | AES-GCM iv (12) | tag (16) | data
//
// The keys themselves are FIXED (baked in nx-admin-keys.js at the owner's
// request) — the vault remembers/mirrors them and self-heals to the baked
// values, so a rebuilt vault never locks the owner out.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nxKeys = require('./nx-admin-keys');

const MAGIC = Buffer.from('NXVB1\0', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
// Pepper — baked obfuscation layer. NOT a cryptographically secured secret on
// its own (it ships with the app); the secrecy comes from .vk + the OS file
// permissions, the pepper defeats "copy vault.bin + read the format" attempts.
const PEPPER = Buffer.from('neurax-vault::v1::b7e4a1c9f08d42638ae5::do-not-edit-in-place', 'utf8');
const VK_FILE = '.vk';
const RO_MODE = process.platform === 'win32' ? 0o444 : 0o400; // read-only
const RW_MODE = process.platform === 'win32' ? 0o666 : 0o600; // owner rw

const MAX_LOGINS = 12;                 // remembered player logins (launcher)
const MAX_SESSIONS = 200;              // remembered browser sessions (console)
const SESSION_TTL = 30 * 24 * 3600e3;  // sessions older than 30 days are dropped
const MAX_HISTORY = 20;                // console login history entries

/* ------------------------------------------------------------ machine key */
function lockPath(f) { try { fs.chmodSync(f, RO_MODE); } catch {} }
function unlockPath(f) { try { fs.chmodSync(f, RW_MODE); } catch {} }

/** The per-machine key file (.vk) inside the .neurax root. Created once,
 *  32 random bytes, immediately locked read-only. Race-safe: if the launcher
 *  and the Control Center start together, exactly one of them creates it. */
function loadMachineKey(dir) {
  const f = path.join(dir, VK_FILE);
  try {
    const b = fs.readFileSync(f);
    if (b.length >= 32) return b.subarray(0, 32);
  } catch { /* first run on this machine */ }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, fresh, { flag: 'wx' }); // never overwrite an existing key
    lockPath(f);
    return fresh;
  } catch {
    try { const b = fs.readFileSync(f); if (b.length >= 32) return b.subarray(0, 32); } catch {}
    return fresh; // vault heals itself if this ever mismatches
  }
}

/** vk ⊕ pepper → scrypt → 256-bit AES key. */
function deriveKey(vk, salt) {
  const mix = Buffer.alloc(Math.max(32, PEPPER.length));
  for (let i = 0; i < mix.length; i++) mix[i] = (i < vk.length ? vk[i] : 0) ^ PEPPER[i % PEPPER.length];
  return crypto.scryptSync(mix, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

/* ---------------------------------------------------------------- defaults */
function launcherDefaults() {
  return {
    kind: 'launcher',
    createdAt: Date.now(), updatedAt: null,
    adminKey: nxKeys.ADMIN_KEY,          // remembered CONTROL CENTER login key
    unlockPasskey: nxKeys.UNLOCK_PASSKEY,// remembered launcher admin passkey
    rememberedLogins: [],                // [{type,name,uuid,lastUsed,uses}]
    lastAccount: null,                   // {type,name,uuid}
    lastAdminUnlockAt: null,
  };
}
function ccDefaults() {
  return {
    kind: 'control-center',
    createdAt: Date.now(), updatedAt: null,
    adminKey: nxKeys.ADMIN_KEY,
    unlockPasskey: nxKeys.UNLOCK_PASSKEY,
    sessions: [],                        // [{token,at}] — survive restarts
    loginHistory: [],                    // [{at,ip}] newest first
  };
}

/* ------------------------------------------------------------------ open() */
/** Opens (or creates) an encrypted, read-only vault file inside `dir`. */
function open(dir, file, defaults) {
  let mem = null;

  function quarantine() {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); }
    catch { try { fs.rmSync(file, { force: true }); } catch {} }
  }

  function persist(patch) {
    if (patch) Object.assign(mem, patch);
    mem.updatedAt = Date.now();
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = deriveKey(loadMachineKey(dir), salt);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(mem), 'utf8'), c.final()]);
    const out = Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
    unlockPath(file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, out);
      try { fs.renameSync(tmp, file); }
      catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
    } finally {
      lockPath(file);
      lockPath(path.join(dir, VK_FILE));
    }
    return { ...mem };
  }

  function load() {
    let raw = null;
    try { raw = fs.readFileSync(file); } catch { /* first run */ }
    const header = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
    if (!raw || raw.length < header + 2 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      if (raw) quarantine();
      mem = defaults();
      persist();
      return { ...mem };
    }
    let plain = null;
    try {
      const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
      const iv = raw.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
      const tag = raw.subarray(MAGIC.length + SALT_LEN + IV_LEN, header);
      const key = deriveKey(loadMachineKey(dir), salt);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(raw.subarray(header)), d.final()]).toString('utf8');
    } catch { /* tampered, corrupted, or a different machine's file */ }
    if (plain === null) {
      quarantine();
      mem = defaults();
      persist();
      return { ...mem };
    }
    try {
      mem = { ...defaults(), ...JSON.parse(plain) };
    } catch {
      quarantine();
      mem = defaults();
      persist();
      return { ...mem };
    }
    return { ...mem };
  }

  function status() {
    let bytes = 0, locked = false, exists = false;
    try { const st = fs.statSync(file); bytes = st.size; locked = !(st.mode & 0o222); exists = true; } catch {}
    return {
      file, bytes, exists, locked,
      encrypted: 'AES-256-GCM + scrypt (bound to this machine)',
      readOnly: locked,
      updatedAt: mem ? mem.updatedAt : null,
      remembers: {
        logins: mem ? (mem.rememberedLogins || []).length : 0,
        passkeys: 2,
        sessions: mem && mem.sessions ? mem.sessions.length : 0,
        history: mem && mem.loginHistory ? mem.loginHistory.length : 0,
      },
    };
  }

  mem = null;
  load();
  return { load, save: persist, get: () => ({ ...mem }), status };
}

/* ------------------------------------------------------- singleton handles */
let launcherH = null;
let ccH = null;

function launcherVault() {
  if (!launcherH) {
    const { DIRS } = require('./paths'); // stdlib-only module — CC can load it too
    launcherH = open(DIRS.root, path.join(DIRS.root, 'vault.bin'), launcherDefaults);
  }
  return launcherH;
}
function ccVault() {
  if (!ccH) {
    const { DIRS } = require('./paths');
    ccH = open(DIRS.root, path.join(DIRS.root, 'cc-vault.bin'), ccDefaults);
  }
  return ccH;
}

/* --------------------------------------------------- launcher: remember logins */
/** Upsert a successful login (offline or Microsoft) into the encrypted
 *  memory. Keeps the newest MAX_LOGINS entries, most recent first. */
function rememberLogin(account) {
  const type = account && account.type === 'msa' ? 'msa' : 'offline';
  const name = String((account && account.name) || '').trim().slice(0, 32);
  const uuid = String((account && account.uuid) || '').slice(0, 40);
  if (!name) return launcherVault().get();
  const v = launcherVault();
  const prev = (v.get().rememberedLogins || []).find((r) => r.uuid === uuid && r.type === type);
  const entry = { type, name, uuid, lastUsed: Date.now(), uses: ((prev && prev.uses) || 0) + 1 };
  const list = [entry, ...(v.get().rememberedLogins || []).filter((r) => !(r.uuid === uuid && r.type === type))].slice(0, MAX_LOGINS);
  v.save({ rememberedLogins: list, lastAccount: { type, name, uuid } });
  return v.get();
}
/** Logout clears only the active-account mirror — the memory of past logins
 *  is kept (that is the whole point of the vault). */
function forgetAccount() { launcherVault().save({ lastAccount: null }); }
function rememberedLogins() { return launcherVault().get().rememberedLogins || []; }
/** Called after a successful owner-passkey unlock in the launcher. */
function noteAdminUnlock() {
  const v = launcherVault();
  v.save({ lastAdminUnlockAt: Date.now(), adminKey: nxKeys.ADMIN_KEY, unlockPasskey: nxKeys.UNLOCK_PASSKEY });
  return v.get();
}

/* ----------------------------------------------------- console: session memory */
function pruneSessions(list) {
  const cut = Date.now() - SESSION_TTL;
  return list.filter((s) => s && typeof s.token === 'string' && s.token && s.at > cut).slice(0, MAX_SESSIONS);
}
/** Remember a console login (browser session + history entry). */
function rememberCcSession(token, ip) {
  const v = ccVault();
  const sessions = pruneSessions([...(v.get().sessions || []), { token, at: Date.now() }]);
  const loginHistory = [{ at: Date.now(), ip: String(ip || '').slice(0, 64) }, ...(v.get().loginHistory || [])].slice(0, MAX_HISTORY);
  v.save({ sessions, loginHistory });
  return sessions;
}
/** Log out → drop the session token (history stays). */
function forgetCcSession(token) {
  const v = ccVault();
  v.save({ sessions: (v.get().sessions || []).filter((s) => s.token !== token) });
}

module.exports = {
  open, launcherVault, ccVault,
  rememberLogin, forgetAccount, rememberedLogins, noteAdminUnlock,
  rememberCcSession, forgetCcSession,
  launcherDefaults, ccDefaults,
  MAX_LOGINS,
};
