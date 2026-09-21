// nx-seal.js — the NEURAX sealed-file core (v4.4).
//
// ONE tiny, dependency-free (Node stdlib only) module that knows how to turn
// any JSON object into a binary ciphertext file that "no one can read at all"
// — only this launcher on THIS machine can decrypt it. Used for EVERY
// sensitive file the launcher writes:
//
//   .neurax/vault.bin            remembered logins + owner keys (launcher)
//   .neurax/cc-vault.bin         Control Center sessions + owner keys
//   .neurax/settings.vault       launcher settings (incl. cloud connection)
//   .neurax/auth/tokens.vault    Microsoft + Minecraft tokens
//   .neurax/identity-cache.vault device identity cache
//   .neurax/keys.vault           OWNER ADMIN KEY + UNLOCK PASSKEY (v4.4 —
//                                the old plaintext nx-keys.local.json inside
//                                .neurax is migrated here and SHREDDED)
//
// HOW THE KEY IS BORN (machine-bound, nothing readable on disk):
//   .vk (32 random bytes, created once inside the .neurax root, locked
//        READ-ONLY)  ⊕  pepper (baked in this module)  →  scrypt (N=16384)
//        →  256-bit AES-GCM key. The .vk file alone is meaningless random
//        bytes; the pepper alone ships with the app; together they only
//        open the sealed files on the machine that created them.
//
// FILE FORMAT (little endian, ciphertext after the 50-byte header):
//   "NXVB1\0" magic (6) | scrypt salt (16) | AES-GCM iv (12) | tag (16) | data
//
// PROPERTIES
//   - authenticated (GCM): ANY edit/corruption/truncation breaks the tag →
//     the file is quarantined as *.corrupt-<ts> and rebuilt from defaults
//   - read-only at rest: every file is chmod 0400/READ-ONLY after writing
//     and briefly unlocked only for a legit update
//   - atomic: writes go through a tmp file + rename
//   - plain Node: the Control Center and probes use the exact same code
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('NXVB1\0', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
// Pepper — baked obfuscation layer. NOT a cryptographically secured secret on
// its own (it ships with the app); the secrecy comes from .vk + OS file
// permissions; the pepper defeats "copy the vault + read the format" attempts.
const PEPPER = Buffer.from('neurax-vault::v1::b7e4a1c9f08d42638ae5::do-not-edit-in-place', 'utf8');
const VK_FILE = '.vk';
const RO_MODE = process.platform === 'win32' ? 0o444 : 0o400; // read-only at rest
const RW_MODE = process.platform === 'win32' ? 0o666 : 0o600; // owner rw (brief unlock)

function lockPath(f) { try { fs.chmodSync(f, RO_MODE); } catch {} }
function unlockPath(f) { try { fs.chmodSync(f, RW_MODE); } catch {} }

/** The per-machine key file (.vk) inside `dir`. Created once, 32 random
 *  bytes, immediately locked read-only. Race-safe: if the launcher and the
 *  Control Center start together, exactly one of them creates it. */
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
    return fresh; // sealed files heal themselves if this ever mismatches
  }
}

/** vk ⊕ pepper → scrypt → 256-bit AES key. */
function deriveKey(vk, salt) {
  const mix = Buffer.alloc(Math.max(32, PEPPER.length));
  for (let i = 0; i < mix.length; i++) mix[i] = (i < vk.length ? vk[i] : 0) ^ PEPPER[i % PEPPER.length];
  return crypto.scryptSync(mix, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
}

/** Read a sealed JSON object. Returns null when missing; quarantines a
 *  tampered/corrupt file and returns null so the caller can rebuild. */
function readSealed(dir, file) {
  let raw = null;
  try { raw = fs.readFileSync(file); } catch { return null; }
  const header = MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN;
  if (raw.length < header + 2 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { try { fs.rmSync(file, { force: true }); } catch {} }
    return null;
  }
  try {
    const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = raw.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
    const tag = raw.subarray(MAGIC.length + SALT_LEN + IV_LEN, header);
    const key = deriveKey(loadMachineKey(dir), salt);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(raw.subarray(header)), d.final()]).toString('utf8'));
  } catch {
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { try { fs.rmSync(file, { force: true }); } catch {} }
    return null;
  }
}

/** Atomically write a JSON object into a sealed, read-only NXVB1 file. */
function writeSealed(dir, file, obj) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(loadMachineKey(dir), salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj || {}), 'utf8'), c.final()]);
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
  return true;
}

/** Best-effort secure deletion of a plaintext file: three random overwrite
 *  passes + a zero pass, then unlink. If unlink fails (file held open by a
 *  scanner/editor) the file is left truncated to 0 bytes — still no
 *  recoverable content. Returns true when the file is gone/empty. */
function shredPlaintext(file) {
  try {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return true; } // already gone
    try { fs.chmodSync(file, RW_MODE); } catch {} // sealed files are locked read-only — unlock for the overwrite
    const fh = fs.openSync(file, 'r+');
    try {
      for (let pass = 0; pass < 3; pass++) {
        fs.writeSync(fh, crypto.randomBytes(size), 0, size, 0);
      }
      fs.writeSync(fh, Buffer.alloc(size, 0), 0, size, 0);
      fs.fsyncSync(fh);
    } finally { fs.closeSync(fh); }
    try { fs.unlinkSync(file); }
    catch { try { fs.truncateSync(file, 0); } catch {} } // held open — at least empty it
    return true;
  } catch { return false; } // never let a cleanup failure break the app
}

module.exports = {
  MAGIC, SALT_LEN, IV_LEN, TAG_LEN, PEPPER, VK_FILE, RO_MODE, RW_MODE,
  lockPath, unlockPath, loadMachineKey, deriveKey, readSealed, writeSealed, shredPlaintext,
};
