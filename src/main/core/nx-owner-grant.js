// nx-owner-grant.js — v1.0 OWNER DEVICE GRANT.
//
// THE BUG THIS FIXES: entering the correct owner key in Settings reported
// success (toast) and then failed the very next gated call with "Wrong owner
// passkey", because every gated IPC call re-compared the pass independently
// and the renderer did not resend it. On top of that, the unlock was lost on
// every restart.
//
// WHAT THE OWNER ASKED FOR (and what this module does):
//   1. Enter the key in Settings (Owner Console) OR on the ANNOUNCEMENTS tab
//      → if it is correct, the access is GRANTED immediately (no follow-up
//      call can ever disagree with the first verdict).
//   2. The grant is SAVED to the .neurax folder — sealed (AES-256-GCM,
//      machine-bound) as device-grant.vault. Only a SHA-256 hash of the key
//      is stored — never the key itself.
//   3. On the next launch the saved grant is fetched, checked against the
//      resolved key (unchanged?) and access to that device is granted
//      AUTOMATICALLY — no re-entry, ever, until the key itself changes.
//   4. If the key ever changes, the stored hash no longer matches: the grant
//      is invalidated silently and the owner simply enters the new key once.
//   5. The grant is mirrored to the owner's Supabase (device uuid + hash +
//      timestamp) so the cloud sees every granted device as it goes.
'use strict';
const crypto = require('crypto');
const path = require('path');
const nxKeys = require('./nx-admin-keys');

const GRANT_NAME = 'device-grant.vault';
const SESSION = { granted: false, at: null, autoGranted: false, source: null };

function file() {
  try {
    const { DIRS } = require('./paths');
    return path.join(DIRS.root, GRANT_NAME);
  } catch { return null; }
}

/** sha256 of the CURRENT resolved key — the only key shape ever stored. */
function hashOf(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
function currentKeyHash() { return hashOf(nxKeys.UNLOCK_PASSKEY); }

function readPersisted() {
  const f = file();
  if (!f) return null;
  try {
    const seal = require('./nx-seal');
    const data = seal.readSealed(require('./paths').DIRS.root, f);
    if (!data || data.kind !== 'device-grant' || !data.keyHash) return null;
    return data;
  } catch { return null; }
}

function persistGrant() {
  const f = file();
  if (!f) return false;
  try {
    const seal = require('./nx-seal');
    const { DIRS } = require('./paths');
    seal.writeSealed(DIRS.root, f, {
      kind: 'device-grant',
      keyHash: currentKeyHash(),
      grantedAt: new Date().toISOString(),
      note: 'Sealed owner access grant for THIS device. Stores a SHA-256 hash only — never the key. Delete this file (or change the owner key in nx-canonical.js) to require the key again.',
    });
    return true;
  } catch { return false; }
}

function removeGrant() {
  const f = file();
  if (!f) return;
  try { require('fs').rmSync(f, { force: true }); } catch { /* already gone */ }
}

/** Best-effort cloud mirror — the launcher + the cloud stay in sync as it goes. */
function mirrorToCloud(info) {
  try { require('./nx-cloud').api.syncDeviceGrant(info); } catch { /* offline / not ready — fine */ }
}

/** Validate a key the owner typed. On success: grant the session, persist the
 *  sealed grant, mirror it to Supabase. Returns a status object. */
function verify(pass) {
  const got = String(pass || '');
  const want = nxKeys.UNLOCK_PASSKEY;
  if (!got || got !== want) throw new Error('Wrong owner key.');
  SESSION.granted = true;
  SESSION.at = Date.now();
  SESSION.autoGranted = false;
  SESSION.source = 'typed';
  const persisted = persistGrant();
  const info = { grantedAt: SESSION.at, keyHash: currentKeyHash(), persisted, deviceUuid: deviceUuidSafe() };
  mirrorToCloud(info);
  try { require('./nx-vault').noteAdminUnlock(); } catch { /* vault optional */ }
  return { ok: true, persisted, grantedAt: SESSION.at, ...info };
}

function deviceUuidSafe() {
  try { return require('./device-identity').getIdentity().uuid || ''; } catch { return ''; }
}

/** Called once at startup: load the saved grant and, if the key did not
 *  change, grant this device automatically (the owner asked for exactly
 *  this). Returns the status for logging/UI. */
function autoRestore() {
  const g = readPersisted();
  if (!g) return { granted: false, persisted: false };
  if (g.keyHash !== currentKeyHash()) {
    // the owner key changed → the old grant is meaningless; drop it
    removeGrant();
    SESSION.granted = false;
    SESSION.source = null;
    return { granted: false, persisted: false, invalidated: true };
  }
  SESSION.granted = true;
  SESSION.autoGranted = true;
  SESSION.source = 'saved-grant';
  SESSION.at = Date.now();
  try { const ts = Date.parse(g.grantedAt); if (!Number.isNaN(ts)) SESSION.at = ts; } catch { /* keep now */ }
  return { granted: true, persisted: true, autoGranted: true, grantedAt: SESSION.at };
}

/** Is owner access active on this device right now? (typed this session or
 *  auto-restored from the sealed grant). */
function isGranted() { return !!SESSION.granted; }

function status() {
  const persisted = readPersisted();
  return {
    granted: !!SESSION.granted,
    autoGranted: !!SESSION.autoGranted,
    source: SESSION.source,
    grantedAt: SESSION.at,
    persisted: !!persisted,
    persistedAt: persisted ? Date.parse(persisted.grantedAt) || null : null,
    keyMatches: persisted ? persisted.keyHash === currentKeyHash() : null,
    grantFile: file(),
  };
}

/** Revoke everything (logout of owner mode). The sealed file is kept unless
 *  `forget` — the owner can re-enter the key any time. */
function revoke({ forget = false } = {}) {
  SESSION.granted = false;
  SESSION.autoGranted = false;
  SESSION.source = null;
  SESSION.at = null;
  if (forget) removeGrant();
  return true;
}

module.exports = { verify, autoRestore, isGranted, status, revoke, hashOf, currentKeyHash, GRANT_NAME, _SESSION: SESSION };
