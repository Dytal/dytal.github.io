// device-identity.js — the hidden, device-bound NX identity.
//
// Requirements implemented here:
//  1. On FIRST launch, generate a UUID and save it to a hidden, system, READ-ONLY
//     file OUTSIDE the launcher folder (ProgramData on Windows). Even a normal
//     Administrator cannot silently edit it: the file is marked Read-Only+Hidden
//    +System and ACLs deny Write/Delete for Administrators/Users/Everyone.
//     (Windows truth: an admin who explicitly takes ownership can defeat ANY
//     local protection — that is why requirement #3 exists below.)
//  2. The UUID is bound to the DEVICE via a hardware fingerprint (Windows
//     MachineGuid + motherboard), so the same machine always maps to it.
//  3. The UUID + fingerprint are registered on the NX Cloud database. If the
//     user deletes every launcher file and reinstalls, the launcher asks the
//     cloud "who is this hardware?" and gets the SAME UUID back.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { DIRS } = require('./paths');
const logger = require('./logger');

const FILE_NAME = 'device-identity.json';

// v4.3 — the .neurax identity cache is SEALED (AES-256-GCM, machine-bound).
// The old plaintext identity-cache.json is imported once, then shredded.
const CACHE_FILE = () => path.join(DIRS.root, 'identity-cache.vault');
const LEGACY_CACHE = () => path.join(DIRS.root, 'identity-cache.json');

function readCache() {
  const vault = require('./nx-vault');
  const sealed = vault.readSealed(DIRS.root, CACHE_FILE());
  if (sealed) return sealed;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_CACHE(), 'utf8'));
    if (legacy && legacy.uuid) {
      vault.writeSealed(DIRS.root, CACHE_FILE(), legacy);
      vault.shredPlaintext(LEGACY_CACHE());
      logger.core.info('Identity cache migrated to the encrypted vault file — plaintext copy shredded.');
      return legacy;
    }
  } catch { /* no legacy cache — first run */ }
  return null;
}

function writeCache(identity) {
  try {
    require('./nx-vault').writeSealed(DIRS.root, CACHE_FILE(), identity);
  } catch { /* cache is best-effort; the protected file + cloud remain the anchors */ }
}

let cached = null; // { uuid, fingerprint, created, source }

// ---------------------------------------------------------------- fingerprint
function win(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function hardwareFingerprint() {
  const parts = [];
  if (process.platform === 'win32') {
    // MachineGuid — stable per Windows install, survives launcher reinstalls
    const g = await win('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    const m = g.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    if (m) parts.push('mg:' + m[1]);
    // motherboard serial (may be blank/OEM) — extra binding, best effort
    const bb = await win('wmic', ['baseboard', 'get', 'serialnumber']);
    const s = bb.split('\n').map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'serialnumber')[0];
    if (s && !/none|default/i.test(s)) parts.push('bb:' + s);
  } else if (process.platform === 'darwin') {
    const io = await win('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const m = io.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (m) parts.push('pu:' + m[1]);
  } else {
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) { parts.push('mid:' + v); break; } } catch {}
    }
  }
  if (!parts.length) {
    // last-resort fingerprint: username + cpu model + total mem (still far better than nothing;
    // the cloud database is the real anchor for identity recovery)
    const cpus = os.cpus();
    parts.push('lr:' + os.hostname() + '|' + (cpus[0] ? cpus[0].model : '') + '|' + Math.floor(os.totalmem() / 1048576));
  }
  return crypto.createHash('sha256').update(parts.join('~')).update('neurax-nx-v1').digest('hex');
}

// ---------------------------------------------------------------- protected file
function protectedDir() {
  if (process.platform === 'win32' && (process.env.ProgramData || process.env['ProgramData'])) {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Neurax');
  }
  if (process.platform === 'darwin') return '/Library/Application Support/Neurax';
  return '/var/lib/neurax';
}

function protectFileWin(file) {
  return new Promise((resolve) => {
    // attrib: +R read-only, +H hidden, +S system
    execFile('attrib', ['+R', '+H', '+S', file], { windowsHide: true }, () => {
      // icacls: stop inheritance, then explicitly DENY write/delete to admins,
      // users and everyone (SYSTEM keeps full control so the OS stays happy).
      execFile('icacls', [file, '/inheritance:r',
        '/grant:r', 'SYSTEM:(F)',
        '/grant:r', '*S-1-5-32-544:(R)',   // Administrators: read
        '/grant:r', '*S-1-5-18:(F)',       // LOCAL SYSTEM
        '/deny', '*S-1-5-32-544:(W,D,DC)', // Administrators: deny write/delete
        '/deny', '*S-1-5-32-545:(W,D,DC)', // Users
        '/deny', '*S-1-1-0:(W,D,DC)',      // Everyone
      ], { windowsHide: true }, () => resolve());
    });
  });
}

/* v4.4 DELETE-SAFE PROTECTION for files INSIDE the .neurax data root.
   The hardened ACLs above used to be applied to the .neurax fallback copy
   too — DENY Delete/Write for Everyone made that file (and therefore the
   whole .neurax folder) impossible to delete, which the owner explicitly
   reported. Inside .neurax we now only set the HIDDEN attribute: the file
   stays out of casual sight, but the folder can always be deleted. */
function softProtectWin(file) {
  return new Promise((resolve) => {
    execFile('attrib', ['-R', '-S', '+H', file], { windowsHide: true }, () => resolve());
  });
}

function softProtectNix(file) {
  try { fs.chmodSync(file, 0o644); } catch {} // NOT read-only — the folder must stay deletable
}

/** Hard protection (ProgramData) vs soft protection (inside .neurax)? */
function isInsideNeuraxRoot(file) {
  try { return file.startsWith(DIRS.root); } catch { return false; }
}

function protectFileNix(file) {
  try { fs.chmodSync(file, 0o444); } catch {}
}

async function writeProtectedIdentity(payload) {
  const dir = protectedDir();
  const file = path.join(dir, FILE_NAME);
  const softHere = (f) => isInsideNeuraxRoot(f);
  const applyWin = async (f) => { if (softHere(f)) await softProtectWin(f); else await protectFileWin(f); };
  const applyNix = (f) => { if (softHere(f)) softProtectNix(f); else { try { fs.chmodSync(f, 0o444); } catch {} } };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    if (process.platform === 'win32') await applyWin(file); else applyNix(file);
    return file;
  } catch (e) {
    // no permission for the protected location — fall back to the .neurax root
    try {
      const dir2 = path.join(DIRS.root, 'identity');
      fs.mkdirSync(dir2, { recursive: true });
      const file2 = path.join(dir2, FILE_NAME);
      fs.writeFileSync(file2, JSON.stringify(payload, null, 2), 'utf8');
      if (process.platform === 'win32') await applyWin(file2); else applyNix(file2);
      return file2;
    } catch (e2) {
      logger.core.warn(`device-identity: could not write protected file (${e.message}) — identity kept in memory/cloud only`);
      return null;
    }
  }
}

function readIdentityFile() {
  // v4.1: pick the MOST RECENTLY WRITTEN identity file (protected dir first in
  // spirit, but if the owner edited the identity and the protected copy could
  // not be rewritten, the newer fallback file must win — mtime decides).
  let best = null;
  let bestM = -1;
  for (const dir of [protectedDir(), path.join(DIRS.root, 'identity')]) {
    try {
      const f = path.join(dir, FILE_NAME);
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(j.uuid)) {
        let m = 0;
        try { m = fs.statSync(f).mtimeMs; } catch {}
        if (m > bestM) { best = j; bestM = m; }
      }
    } catch { /* try next / first-run */ }
  }
  return best;
}

// ---------------------------------------------------------------- public api
/** Fast, synchronous identity read (cached). Null before ensureIdentity(). */
function getIdentity() { return cached; }

/**
 * Ensure an identity exists (call once at app start).
 * Order: protected file -> cache file -> generate new.
 * Cloud recovery happens in nx-cloud.js (async, network) and may override.
 */
async function ensureIdentity() {
  if (cached) return cached;
  const fingerprint = await hardwareFingerprint();
  let identity = readIdentityFile();
  if (!identity) {
    // regenerate the SAME uuid this machine already registered with, if the
    // encrypted cache survived while the protected file did not
    try {
      const cache = readCache();
      if (cache && cache.uuid && cache.fingerprint === fingerprint) identity = cache;
    } catch {}
  }
  if (!identity) {
    identity = { uuid: crypto.randomUUID(), fingerprint, created: Date.now() };
    logger.core.info(`device-identity: new NX identity generated ${identity.uuid}`);
  }
  if (identity.fingerprint !== fingerprint) {
    // file copied from another machine — the UUID belongs to the file's machine.
    // Keep the uuid only if the cloud confirms it later; for now trust the file.
    identity.fingerprint = fingerprint;
  }
  identity.source = identity.source || 'file';
  cached = identity;
  // persist encrypted cache + protected file (refresh protection attributes)
  try { fs.mkdirSync(DIRS.root, { recursive: true }); } catch {}
  writeCache(identity);
  // v4.4 self-heal: if an OLD build left a deny-ACL copy inside .neurax, strip
  // that protection back off before refreshing — the folder must stay deletable
  try { await unprotectFallbackIfHardened(); } catch {}
  const saved = await writeProtectedIdentity(identity);
  if (saved) identity.file = saved;
  return cached;
}

/** Adopt a uuid recovered from the NX Cloud database (fingerprint match). */
function adoptCloudIdentity(uuid, fingerprintMatch) {
  if (!uuid || !/^[0-9a-f]{8}-/i.test(uuid)) return cached;
  if (cached && cached.uuid === uuid) return cached;
  cached = { uuid, fingerprint: cached ? cached.fingerprint : fingerprintMatch, created: cached ? cached.created : Date.now(), source: 'cloud' };
  writeCache(cached);
  writeProtectedIdentity(cached); // best effort, fire & forget
  logger.core.info(`device-identity: identity recovered from NX Cloud → ${uuid}`);
  return cached;
}

/* ================================================================== v4.1
   OWNER EDIT — the NX admin (passkey-gated) can rewrite this device's
   LAUNCHER ID (uuid) and DEVICE ID (fingerprint). Windows protection is
   cleared first (attrib/icacls), the file is rewritten and re-protected; if
   the protected location still refuses, the .neurax identity folder is used
   (readIdentityFile now prefers the newer file, so the edit survives reboots). */
async function clearProtectionWin(file) {
  await new Promise((resolve) => execFile('attrib', ['-R', '-H', '-S', file], { windowsHide: true }, () => resolve()));
  await new Promise((resolve) => execFile('icacls', [file, '/reset'], { windowsHide: true }, () => resolve()));
}

/** Self-heal: if an OLD build left a HARDENED (deny-ACL) identity copy inside
 *  .neurax, strip the hard protection so the folder stays deletable. */
async function unprotectFallbackIfHardened() {
  const f = path.join(DIRS.root, 'identity', FILE_NAME);
  if (!fs.existsSync(f)) return;
  if (process.platform === 'win32') {
    // cheap + idempotent: always clear attributes AND reset inherited ACLs
    await clearProtectionWin(f);
    await softProtectWin(f);
  } else {
    softProtectNix(f);
  }
}

/**
 * v4.4 OWNER TOOLS — strip EVERY protection this launcher ever applied, so
 * the .neurax folder (and the ProgramData identity anchor) can be deleted,
 * moved or backed up. Self-heals the old deny-ACL fallback file on every
 * call; safe to run on files that were never protected.
 * Returns the list of files that were released.
 */
async function unprotectAll() {
  const targets = [path.join(protectedDir(), FILE_NAME), path.join(DIRS.root, 'identity', FILE_NAME)];
  const released = [];
  for (const f of targets) {
    if (!fs.existsSync(f)) continue;
    if (process.platform === 'win32') await clearProtectionWin(f);
    else { try { fs.chmodSync(f, 0o644); } catch {} }
    released.push(f);
  }
  if (released.length) logger.core.info(`device-identity: protection released on ${released.length} file(s) (owner unlock)`);
  return released;
}

/** Rewrite the local identity. Validated upstream (ipc) — uuid + 64-hex fp. */
async function overrideIdentity({ uuid, fingerprint }) {
  const next = {
    uuid: String(uuid).toLowerCase(),
    fingerprint: String(fingerprint).toLowerCase(),
    created: (cached && cached.created) || Date.now(),
    source: 'owner-edit',
  };
  const prevUuid = cached ? cached.uuid : null;
  cached = next;
  let saved = null;
  const attempt = async (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE_NAME);
    if (process.platform === 'win32' && fs.existsSync(file)) await clearProtectionWin(file);
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    if (process.platform === 'win32') await protectFileWin(file); else protectFileNix(file);
    return file;
  };
  try { saved = await attempt(protectedDir()); } catch {
    try { saved = await attempt(path.join(DIRS.root, 'identity')); } catch {}
  }
  if (saved) next.file = saved;
  writeCache(next);
  logger.core.info(`device-identity: OWNER EDIT applied → uuid=${next.uuid}${prevUuid && prevUuid !== next.uuid ? ` (was ${prevUuid})` : ''} file=${saved || 'memory/cache only'}`);
  return { file: saved, uuid: next.uuid, fingerprint: next.fingerprint, previousUuid: prevUuid };
}

module.exports = { ensureIdentity, getIdentity, adoptCloudIdentity, hardwareFingerprint, overrideIdentity, unprotectAll, protectedDir, FILE_NAME };
