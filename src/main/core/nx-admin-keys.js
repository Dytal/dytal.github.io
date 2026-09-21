'use strict';
// nx-admin-keys.js — owner admin credentials, FIXED by the owner (v4.5).
//
//   ADMIN_KEY       → logs into the NEURAX CONTROL CENTER (also accepted as
//                     the X-Admin-Key header for scripts). NOT user-editable in the UI.
//   UNLOCK_PASSKEY  → unlocks the NX Admin panel + the OWNER CONSOLE inside
//                     the launcher. NOT user-editable in the UI.
//
// v4.5 — THE OWNER FIXED THE KEY: both credentials are the single OWNER_KEY
// from nx-canonical.js on EVERY installation, EVERY machine, ALWAYS — even
// after the .neurax folder (or the whole launcher folder) was deleted. The
// key is no longer randomly generated per machine and is NEVER shown in the
// settings tab (the owner already knows it; the display feature was removed
// by request). Sealing is unchanged: the key lives at rest in
// .neurax/keys.vault — NXVB1 AES-256-GCM, machine-bound .vk ⊕ pepper →
// scrypt — pure ciphertext in any editor; only this launcher on this machine
// can decrypt it. A plaintext nx-keys.local.json inside .neurax is still
// imported once, then SHREDDED (multi-pass overwrite + delete).
//
// RESOLUTION ORDER (first hit wins):
//   1. NEURAX_KEYS_FILE  explicit override (tests / power users) — replaces
//                        the whole candidate list.
//   2. environment       NEURAX_ADMIN_KEY / NEURAX_UNLOCK_PASSKEY (one or
//                        both — the Control Center honors NEURAX_ADMIN_KEY
//                        for tests).
//   3. sealed vault      .neurax/keys.vault (per-machine, encrypted at
//                        rest). Files written before the owner fixed the
//                        key carry no seedVersion (or an older one) and are
//                        RE-SEEDED with the canonical OWNER_KEY — one
//                        launch of this version migrates every installation
//                        to the fixed key.
//   4. legacy files      plaintext nx-keys.local.json — the .neurax root
//                        copy is MIGRATED to the sealed vault and shredded;
//                        the project-root copy (dev checkout, git-ignored)
//                        is still read for backwards compatibility and
//                        mirrored into the sealed vault.
//   5. CANONICAL SEED    nothing found (deleted .neurax, fresh machine,
//                        first ever run): the canonical OWNER_KEY is seeded
//                        into the sealed vault — the owner key ALWAYS works.
//   6. vault memory      the encrypted memory vault (vault.bin /
//                        cc-vault.bin) may still adopt remembered keys when
//                        the sealed vault could not be written (read-only
//                        data root) — see adopt().
//
// The memory vaults mirror the resolved keys (self-heal) so the launcher and
// the Control Center always agree.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seal = require('./nx-seal');
const canonical = require('./nx-canonical');

const FILE_NAME = 'nx-keys.local.json';   // legacy plaintext name (migrated away)
const VAULT_NAME = 'keys.vault';          // sealed storage (v4.4+)
const PENDING = 'pending';                // sealed write failed — vault may adopt
const EPHEMERAL = 'vault-ephemeral';      // adopted from vault, sealed file unwritable
const CANONICAL = 'canonical';            // seeded from the owner's fixed key

// Bump when the canonical key changes in a release: every installation
// whose keys.vault carries an older seedVersion is re-seeded to the new
// canonical key on the next start. rotate() persists the CURRENT version,
// so a live rotation is never clobbered by a re-run of the same release.
const SEED_VERSION = 2;

function rootDir() {
  try {
    const { DIRS } = require('./paths'); // stdlib-only module — CC can load it too
    if (DIRS && DIRS.root) return DIRS.root;
  } catch { /* paths unavailable — keep going */ }
  return null;
}

function sealedFile() {
  const root = rootDir();
  return root ? path.join(root, VAULT_NAME) : null;
}

function legacyCandidates() {
  if (process.env.NEURAX_KEYS_FILE) return [process.env.NEURAX_KEYS_FILE]; // explicit override — nothing else
  const list = [];
  const root = rootDir();
  if (root) list.push(path.join(root, FILE_NAME));
  list.push(path.join(__dirname, '..', '..', '..', FILE_NAME)); // project root (dev checkout)
  return list;
}

function parseKeys(obj) {
  const a = obj && typeof obj.adminKey === 'string' ? obj.adminKey.trim() : '';
  const u = obj && typeof obj.unlockPasskey === 'string' ? obj.unlockPasskey.trim() : '';
  if (a.length >= 12 && u.length >= 8) return { ADMIN_KEY: a, UNLOCK_PASSKEY: u };
  return null;
}

/** The owner's fixed credentials (both roles — one key everywhere). */
function canonicalKeys() {
  return { ADMIN_KEY: canonical.OWNER_KEY, UNLOCK_PASSKEY: canonical.OWNER_KEY };
}

/** Read the sealed key vault; returns { keys, seedVersion } or null. */
function readSealedKeys() {
  const f = sealedFile();
  if (!f) return null;
  try {
    const data = seal.readSealed(rootDir(), f);
    const keys = parseKeys(data);
    if (!keys) return null;
    return { keys, seedVersion: Number(data && data.seedVersion) || 1 };
  } catch { return null; }
}

function readKeysFrom(file) {
  try { return parseKeys(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

function persistSealed(keys) {
  const f = sealedFile();
  if (!f) return false;
  try {
    seal.writeSealed(rootDir(), f, {
      _comment: 'PRIVATE owner admin keys for THIS installation — sealed (AES-256-GCM, machine-bound). The key is fixed by the owner (nx-canonical.js) and is never shown in the settings tab.',
      adminKey: keys.ADMIN_KEY,
      unlockPasskey: keys.UNLOCK_PASSKEY,
      seedVersion: SEED_VERSION,
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch { return false; }
}

function generateKeys() {
  const b64 = (n) => crypto.randomBytes(n).toString('base64url');
  return { ADMIN_KEY: b64(24), UNLOCK_PASSKEY: b64(32) };
}

/* ------------------------------------------------------------- resolution */
const KEYS = { ADMIN_KEY: '', UNLOCK_PASSKEY: '' };
let SOURCE = 'none';

(function resolve() {
  const envA = String(process.env.NEURAX_ADMIN_KEY || '').trim();
  const envU = String(process.env.NEURAX_UNLOCK_PASSKEY || '').trim();
  const patchEnv = () => {
    if (envA.length >= 12) KEYS.ADMIN_KEY = envA;
    if (envU.length >= 8) KEYS.UNLOCK_PASSKEY = envU;
  };

  // 1) environment (both keys, or the single one that is set patches over #3/#4)
  if (envA.length >= 12 && envU.length >= 8) {
    KEYS.ADMIN_KEY = envA; KEYS.UNLOCK_PASSKEY = envU;
    SOURCE = 'env';
    return;
  }
  // 2) sealed keys.vault (encrypted at rest, per-machine). A vault written
  //    before the owner fixed the key (no/older seedVersion) is RE-SEEDED to
  //    the canonical OWNER_KEY — one launch migrates every installation.
  const sealed = readSealedKeys();
  if (sealed) {
    if (sealed.seedVersion < SEED_VERSION) {
      Object.assign(KEYS, canonicalKeys());
      patchEnv();
      if (persistSealed(KEYS)) SOURCE = CANONICAL;
      else { Object.assign(KEYS, sealed.keys); patchEnv(); SOURCE = 'sealed'; }
      return;
    }
    Object.assign(KEYS, sealed.keys);
    patchEnv();
    SOURCE = 'sealed';
    return;
  }
  // 3) legacy plaintext files — the .neurax copy is MIGRATED to the sealed
  //    vault and SHREDDED; the dev project-root copy is mirrored (kept — it
  //    is git-ignored and deliberately created by scripts/rotate-nx-keys.js).
  for (const f of legacyCandidates()) {
    const k = readKeysFrom(f);
    if (!k) continue;
    Object.assign(KEYS, k);
    patchEnv();
    const inDataRoot = rootDir() && f.startsWith(rootDir());
    if (persistSealed(KEYS)) {
      SOURCE = 'sealed';
      if (inDataRoot) {
        // the readable key file inside .neurax is exactly what the owner asked
        // to never exist again — destroy it after the sealed copy is verified
        seal.shredPlaintext(f);
      }
    } else {
      SOURCE = 'file'; // read-only data root — legacy file stays as the source
    }
    return;
  }
  // 4) CANONICAL SEED — nothing found (deleted .neurax, new machine, first
  //    ever run): seed the owner's FIXED key into the sealed vault so the
  //    owner key always works everywhere. No more random per-machine keys.
  Object.assign(KEYS, canonicalKeys());
  patchEnv();
  if (persistSealed(KEYS)) { SOURCE = CANONICAL; return; }
  // 5) read-only data root — hold the canonical keys in memory; the vault
  //    may still adopt remembered keys on first open (see nx-vault.js).
  SOURCE = PENDING;
})();

/** Late adoption — called by the encrypted vault when this module started
 *  with 'pending' keys (sealed vault unwritable, read-only data root): take
 *  over the keys remembered from the vault so the installation keeps
 *  working. Returns true when the keys were adopted. */
function adopt(remembered) {
  if (SOURCE !== PENDING) return false; // env/sealed/canonical already authoritative
  const a = String((remembered && remembered.adminKey) || '').trim();
  const u = String((remembered && remembered.unlockPasskey) || '').trim();
  if (a.length < 12 || u.length < 8) return false;
  KEYS.ADMIN_KEY = a; KEYS.UNLOCK_PASSKEY = u;
  SOURCE = persistSealed(KEYS) ? 'sealed' : EPHEMERAL; // ephemeral = read-only fs; the vault is the memory
  return true;
}

/** Owner / script tooling — replace both keys and re-seal the storage
 *  immediately. Persists the CURRENT seedVersion so this release never
 *  re-seeds over a live rotation. The in-session vault mirrors are
 *  refreshed by the caller (IPC layer / smoke battery) afterwards. */
function rotate(next) {
  const k = parseKeys(next);
  if (!k) throw new Error('Keys must be at least 12 (admin) / 8 (passkey) characters.');
  KEYS.ADMIN_KEY = k.ADMIN_KEY;
  KEYS.UNLOCK_PASSKEY = k.UNLOCK_PASSKEY;
  if (!persistSealed(KEYS)) throw new Error('Could not write the sealed key vault (.neurax/keys.vault).');
  SOURCE = 'sealed';
  return { ADMIN_KEY: KEYS.ADMIN_KEY, UNLOCK_PASSKEY: KEYS.UNLOCK_PASSKEY };
}

/** Where the sealed key file lives (for the Owner Console UI). */
function sealedKeysFile() { return sealedFile(); }

module.exports = {
  get ADMIN_KEY() { return KEYS.ADMIN_KEY; },
  get UNLOCK_PASSKEY() { return KEYS.UNLOCK_PASSKEY; },
  get KEYS_SOURCE() { return SOURCE; },
  adopt, rotate, generateKeys,
  canonicalKeys,
  sealedKeysFile,
  FILE_NAME, VAULT_NAME,
  SEED_VERSION,
};
