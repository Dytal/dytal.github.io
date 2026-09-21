#!/usr/bin/env node
// rotate-nx-keys.js — owner key writer (v4.5 FIXED-KEY era).
//
// v4.5 DEFAULT: the owner FIXED the key (nx-canonical.js) — running this
// script with NO arguments writes that SAME key everywhere, which is what
// "the same admin and owner key everywhere" means in practice:
//   1. <project root>/nx-keys.local.json — the git-ignored legacy private
//      key file. On the next launcher start the key module auto-MIGRATES it
//      into the SEALED .neurax/keys.vault (AES-256-GCM, machine-bound) and
//      shreds the plaintext copy inside .neurax. Kept for env-less dev
//      checkouts.
//   2. <data root>/keys.vault (when a .neurax folder already exists — pass
//      NEURAX_SEAL_HOME=<dir> to target another data root): the SEALED key
//      vault written directly via the launcher's own nx-seal crypto.
//   3. a private backup .txt (pass OUT as argv[2]).
//
// Pass --random to go back to the OLD behaviour (a fresh random pair).
// The script itself contains no secrets when --random is used.
// Run:  node scripts/rotate-nx-keys.js [/path/to/private/backup.txt] [--random]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT_BACKUP = process.argv[2] || path.join(ROOT, '..', 'download', 'NX-PRIVATE-KEYS.txt');
const SEAL_HOME = process.env.NEURAX_SEAL_HOME || '';
const RANDOM = process.argv.includes('--random');

let keys;
if (RANDOM) {
  const b64 = (n) => crypto.randomBytes(n).toString('base64url');
  keys = {
    ADMIN_KEY: b64(24),        // Control Center login / X-Admin-Key header
    UNLOCK_PASSKEY: b64(32),   // NX Admin panel unlock (ANNOUNCEMENTS tab)
  };
} else {
  // v4.5 — the owner's FIXED key: one key for admin + passkey, every machine.
  const canonical = require('../src/main/core/nx-canonical');
  keys = { ADMIN_KEY: canonical.OWNER_KEY, UNLOCK_PASSKEY: canonical.OWNER_KEY };
}

const localFile = path.join(ROOT, 'nx-keys.local.json');
fs.writeFileSync(localFile, JSON.stringify({
  _comment: 'PRIVATE owner admin keys — never commit, never publish. The launcher seals these into .neurax/keys.vault and shreds this file\'s .neurax copy on next start. Rotate from Settings → Owner Console.',
  adminKey: keys.ADMIN_KEY,
  unlockPasskey: keys.UNLOCK_PASSKEY,
  createdAt: new Date().toISOString(),
}, null, 2));
try { fs.chmodSync(localFile, 0o600); } catch {}

// v4.4 — when a data root exists, ALSO write the SEALED key vault directly
let sealedFile = null;
const sealHome = SEAL_HOME || (fs.existsSync(path.join(ROOT, '.neurax')) ? path.join(ROOT, '.neurax') : null);
if (sealHome) {
  try {
    const seal = require('../src/main/core/nx-seal');
    sealedFile = path.join(sealHome, 'keys.vault');
    seal.writeSealed(sealHome, sealedFile, {
      _comment: 'PRIVATE owner admin keys for THIS installation — sealed (AES-256-GCM, machine-bound). Rotate from Settings → Owner Console.',
      adminKey: keys.ADMIN_KEY,
      unlockPasskey: keys.UNLOCK_PASSKEY,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('sealed key vault not written:', e.message);
    sealedFile = null;
  }
}

const backup = [
  '==============================================================',
  ' NEURAX LAUNCHER — PRIVATE OWNER KEYS (keep this file SAFE)',
  ' Written by scripts/rotate-nx-keys.js — DO NOT PUBLISH.',
  '==============================================================',
  '',
  '  CONTROL CENTER ADMIN KEY  (ADMIN_KEY / NEURAX_ADMIN_KEY):',
  `    ${keys.ADMIN_KEY}`,
  '',
  '  NX ADMIN PANEL UNLOCK PASSKEY  (UNLOCK_PASSKEY / NEURAX_UNLOCK_PASSKEY):',
  `    ${keys.UNLOCK_PASSKEY}`,
  '',
  '--------------------------------------------------------------',
  ' HOW IT WORKS (v4.5)',
  '--------------------------------------------------------------',
  ' 1. This is the OWNER FIXED key (nx-canonical.js in the source).',
  '    It is baked into the launcher ON PURPOSE — every installation',
  '    accepts it, even after .neurax was deleted and re-created.',
  '    The key is never displayed in the settings tab (v4.5).',
  ' 2. The sealed key vault (.neurax/keys.vault, AES-256-GCM,',
  '    machine-bound) is seeded with this key automatically on',
  '    first run; nx-keys.local.json inside .neurax is shredded.',
  ' 3. To change the key later: edit OWNER_KEY in',
  '    src/main/core/nx-canonical.js (or run this script with',
  '    --random) and rebuild — the next release re-seeds every',
  '    installation to the new key on first launch.',
  ' 4. DATABASE password: the NX Cloud connection string lives in',
  '    ONE place — OWNER_SUPABASE_URL in',
  '    src/main/core/nx-canonical.js. After resetting the password',
  '    in the Supabase dashboard, paste the new connection string',
  '    there and rebuild.',
  ' 5. Rebuild any release (.exe) you publish — old builds embed',
  '    the old credentials.',
  '==============================================================',
  '',
].join('\n');
fs.mkdirSync(path.dirname(OUT_BACKUP), { recursive: true });
fs.writeFileSync(OUT_BACKUP, backup);
try { fs.chmodSync(OUT_BACKUP, 0o600); } catch {}

console.log(RANDOM ? 'RANDOM keys generated.' : 'OWNER FIXED key (nx-canonical.js) written.');
console.log('ADMIN_KEY      :', keys.ADMIN_KEY);
console.log('UNLOCK_PASSKEY :', keys.UNLOCK_PASSKEY);
console.log('private key file   :', localFile);
if (sealedFile) console.log('sealed key vault   :', sealedFile, '(AES-256-GCM, machine-bound)');
console.log('private backup     :', OUT_BACKUP);
console.log('OK — every installation accepts this key. Keep the backup private.');
