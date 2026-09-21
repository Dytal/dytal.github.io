#!/usr/bin/env node
// smoke-nx-keys.js — v4.5 owner-keys safety battery (FIXED-KEY era) for
// src/main/core/nx-admin-keys.js + nx-vault.js sync. Runs standalone (no DB,
// no electron). Each scenario runs in a FRESH subprocess with its own
// NEURAX_HOME + NEURAX_KEYS_FILE so nothing leaks between cases (and the
// repo-root private file never interferes):
//   1. fresh machine / deleted .neurax — the owner's FIXED key is seeded
//      into the sealed keys.vault (no more random per-machine keys)
//   2. seed-version RE-SEED — a keys.vault written before the owner fixed
//      the key (seedVersion 1) is re-seeded to the fixed key on next start
//   3. stability         — the next process reads the sealed vault: same keys
//   4. legacy MIGRATION  — a plaintext nx-keys.local.json inside .neurax is
//                          imported into the sealed vault and SHREDDED
//   5. rotation          — rotate() re-seals with the CURRENT seedVersion and
//                          is NOT clobbered by the re-seed on later starts
//   6. env override      — NEURAX_ADMIN_KEY / NEURAX_UNLOCK_PASSKEY win
//   7. encryption sanity — raw vault/keys bytes never contain any key
// Run: node scripts/smoke-nx-keys.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js');
const KEYSMOD = path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js');
const SEALMOD = path.join(ROOT, 'src', 'main', 'core', 'nx-seal.js');
const CANONMOD = path.join(ROOT, 'src', 'main', 'core', 'nx-canonical.js');
const OWNER = require(CANONMOD).OWNER_KEY;
// The parent process only READS sources; require() of the keys module would
// seed a sealed vault into the default data root — point NEURAX_HOME at a
// throwaway dir BEFORE requiring it. Child scenarios always override it.
process.env.NEURAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nxk-parent-'));
const KEYSSURFACE = require(KEYSMOD);

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/* Run `code` in a fresh subprocess bound to an isolated NEURAX_HOME.
   NEURAX_KEYS_FILE pins the private-file candidate so the repo-root file
   (a real artifact of rotate-nx-keys.js) cannot shadow the scenario. */
function run(code, root, envExtra = {}) {
  const script = path.join(os.tmpdir(), `nxk-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return {
      out: execFileSync(process.execPath, [script], {
        env: {
          ...process.env, NEURAX_HOME: root,
          NEURAX_KEYS_FILE: path.join(root, 'nx-keys.local.json'),
          ...envExtra,
        },
        encoding: 'utf8', timeout: 30000,
      }),
      root,
    };
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}
const lastJson = (out) => JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop());

const HEAD = `(() => {
  const v = require(${JSON.stringify(MOD)});
  const k = require(${JSON.stringify(KEYSMOD)});
  const seal = require(${JSON.stringify(SEALMOD)});
  const fs = require('fs');
  const path = require('path');
  const kf = path.join(process.env.NEURAX_HOME, 'nx-keys.local.json');
  const kv = path.join(process.env.NEURAX_HOME, 'keys.vault');
  const vault = v.launcherVault();
  const mem = vault.get();
  let payload = null;
`;
const TAIL = `})();
`;
const emit = (body) => `${HEAD}${body}\n  console.log(JSON.stringify(payload));\n${TAIL}`;

console.log('NX keys smoke — fixed-owner-key battery\n');

// ----------------------------------- 1. fresh machine / deleted .neurax
let home1;
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxk1-'));
  home1 = path.join(dir, '.neurax');
  const r = run(emit(`
    const st = vault.status();
    const sealed = fs.existsSync(kv) ? seal.readSealed(process.env.NEURAX_HOME, kv) : null;
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY,
                va: mem.adminKey, vu: mem.unlockPasskey,
                file: fs.existsSync(kf), exists: st.exists,
                sealedSeed: sealed ? sealed.seedVersion : null };
  `), home1);
  const j = lastJson(r.out);
  ok(j.src === 'canonical', '1. fresh machine: source is CANONICAL (owner fixed key seeded)', j.src);
  ok(j.a === OWNER && j.u === OWNER, '1. fresh machine: BOTH keys are the owner fixed key');
  ok(j.va === OWNER && j.vu === OWNER, '1. fresh machine: vault mirrors the fixed key');
  ok(j.file === false, '1. fresh machine: no plaintext key file is created');
  ok(j.sealedSeed === KEYSSURFACE.SEED_VERSION, '1. fresh machine: sealed vault carries the current seedVersion');
  const rawKv = fs.readFileSync(path.join(home1, 'keys.vault'), 'latin1');
  ok(!rawKv.includes(OWNER), '1. ENCRYPTION: keys.vault bytes do NOT contain the key (AES-256-GCM at rest)');
}

// --------------------------------- 2. seed-version re-seed (pre-fix vault)
{
  const rA = run(emit(`
    seal.writeSealed(process.env.NEURAX_HOME, kv, {
      _comment: 'pre-fix vault (v4.4 era — no seedVersion)',
      adminKey: 'OLD-PRE-FIX-ADMIN-KEY-00001', unlockPasskey: 'OLD-PRE-FIX-PASS-0000001',
      seedVersion: 1, createdAt: new Date().toISOString(),
    });
    payload = { written: fs.existsSync(kv) };
  `), home1);
  ok(lastJson(rA.out).written === true, '2. setup: a pre-fixed-key sealed vault exists (seedVersion 1)');
  const rB = run(emit(`
    const sealed = seal.readSealed(process.env.NEURAX_HOME, kv);
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY,
                va: mem.adminKey, vu: mem.unlockPasskey,
                sealedKey: sealed ? sealed.adminKey : null,
                sealedSeed: sealed ? sealed.seedVersion : null };
  `), home1);
  const j = lastJson(rB.out);
  ok(j.src === 'canonical' && j.a === OWNER && j.u === OWNER, '2. RE-SEED: the old-seed vault is migrated to the owner fixed key');
  ok(j.sealedKey === OWNER && j.sealedSeed === KEYSSURFACE.SEED_VERSION, '2. RE-SEED: keys.vault now carries the fixed key + current seedVersion');
  ok(j.va === OWNER && j.vu === OWNER, '2. RE-SEED: vault mirror synced');
}

// ------------------------------------------- 3. stability across processes
{
  const r = run(emit(`
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY, va: mem.adminKey };
  `), home1);
  const j = lastJson(r.out);
  ok((j.src === 'sealed' || j.src === 'canonical') && j.a === OWNER && j.u === OWNER,
    '3. STABILITY: next process keeps the fixed key (sealed vault, current seed)');
  ok(j.va === OWNER, '3. STABILITY: vault mirrors the fixed key');
  fs.rmSync(home1, { recursive: true, force: true });
}

// ------------------------------- 4. legacy plaintext migration (+ shred)
{
  const LEG = { adminKey: 'LEGACY-PLAINTEXT-ADMIN-000001', unlockPasskey: 'LEGACY-PLAINTEXT-PASS-0000000002' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxk4-'));
  const home4 = path.join(dir, '.neurax');
  fs.mkdirSync(home4, { recursive: true });
  fs.writeFileSync(path.join(home4, 'nx-keys.local.json'), JSON.stringify({
    _comment: 'old readable key file', adminKey: LEG.adminKey, unlockPasskey: LEG.unlockPasskey,
  }));
  const r = run(emit(`
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY,
                plainGone: !fs.existsSync(kf), sealed: fs.existsSync(kv),
                sealedKeys: fs.existsSync(kv) ? seal.readSealed(process.env.NEURAX_HOME, kv) : null };
  `), home4);
  const j = lastJson(r.out);
  ok(j.a === LEG.adminKey && j.u === LEG.unlockPasskey, '4. MIGRATION: plaintext keys imported (explicit file wins over the seed)');
  ok(j.src === 'sealed', '4. MIGRATION: storage upgraded to the sealed vault', j.src);
  ok(j.plainGone === true, '4. MIGRATION: the readable nx-keys.local.json inside .neurax is SHREDDED');
  ok(j.sealed === true && j.sealedKeys && j.sealedKeys.adminKey === LEG.adminKey,
    '4. MIGRATION: keys.vault now carries the keys (ciphertext at rest)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------- 5. rotation (re-seal + sync, re-seed-safe)
{
  const NEW = { adminKey: 'NEW-ROTATED-ADMIN-KEY-0001', unlockPasskey: 'NEW-ROTATED-PASS-000000000002' };
  const r = run(emit(`
    k.rotate({ adminKey: ${JSON.stringify(NEW.adminKey)}, unlockPasskey: ${JSON.stringify(NEW.unlockPasskey)} });
    // the IPC layer mirrors the new keys into the in-session vaults immediately
    vault.save({ adminKey: k.ADMIN_KEY, unlockPasskey: k.UNLOCK_PASSKEY });
    const after = seal.readSealed(process.env.NEURAX_HOME, kv);
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY,
                va: vault.get().adminKey, vu: vault.get().unlockPasskey,
                sealedKeys: after };
  `), home1);
  const j = lastJson(r.out);
  ok(j.a === NEW.adminKey && j.u === NEW.unlockPasskey, '5. ROTATION: rotate() re-seals the key vault with the new keys');
  ok(j.src === 'sealed', '5. ROTATION: source stays sealed');
  ok(j.va === NEW.adminKey && j.vu === NEW.unlockPasskey, '5. ROTATION: encrypted vault mirror synced to the new keys');
  ok(j.sealedKeys && j.sealedKeys.adminKey === NEW.adminKey && j.sealedKeys.seedVersion === KEYSSURFACE.SEED_VERSION,
    '5. ROTATION: keys.vault decrypts to the new keys at the CURRENT seedVersion');
  const raw = fs.readFileSync(path.join(home1, 'vault.bin'), 'latin1');
  const rawKv = fs.readFileSync(path.join(home1, 'keys.vault'), 'latin1');
  ok(!raw.includes(NEW.adminKey) && !raw.includes(NEW.unlockPasskey) && !raw.includes(OWNER),
    '5. ENCRYPTION: vault bytes contain none of the keys (AES-256-GCM at rest)');
  ok(!rawKv.includes(NEW.adminKey) && !rawKv.includes(NEW.unlockPasskey) && !rawKv.includes(OWNER),
    '5. ENCRYPTION: keys.vault bytes contain none of the keys (AES-256-GCM at rest)');
  // a LATER start must NOT re-seed over the live rotation (same release)
  const r2 = run(emit(`
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY };
  `), home1);
  const j2 = lastJson(r2.out);
  ok(j2.a === NEW.adminKey && j2.u === NEW.unlockPasskey, '5. ROTATION: later starts keep the rotated keys (not clobbered by the re-seed)');
}

// ------------------------------------------------- 6. env override wins
{
  const E = { NEURAX_ADMIN_KEY: 'ENV-OVERRIDE-ADMIN-KEY-00001', NEURAX_UNLOCK_PASSKEY: 'ENV-OVERRIDE-PASS-00000000001' };
  const r = run(emit(`
    payload = { src: k.KEYS_SOURCE, a: k.ADMIN_KEY, u: k.UNLOCK_PASSKEY, va: mem.adminKey, vu: mem.unlockPasskey };
  `), home1, E);
  const j = lastJson(r.out);
  ok(j.src === 'env' && j.a === E.NEURAX_ADMIN_KEY && j.u === E.NEURAX_UNLOCK_PASSKEY,
    '6. ENV: NEURAX_ADMIN_KEY / NEURAX_UNLOCK_PASSKEY override the sealed vault');
  ok(j.va === E.NEURAX_ADMIN_KEY && j.vu === E.NEURAX_UNLOCK_PASSKEY, '6. ENV: vault self-syncs to the override');
}

// -------------------------------- 7. module surface (fixed-key era)
{
  ok(typeof KEYSSURFACE.canonicalKeys === 'function', '7. SURFACE: canonicalKeys() exported');
  ok(KEYSSURFACE.SEED_VERSION >= 2, '7. SURFACE: SEED_VERSION bumped for the fixed-key era');
  ok(KEYSSURFACE.canonicalKeys().ADMIN_KEY === OWNER, '7. SURFACE: canonicalKeys() returns the owner fixed key');
  fs.rmSync(process.env.NEURAX_HOME, { recursive: true, force: true });
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
