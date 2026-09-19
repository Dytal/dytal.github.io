#!/usr/bin/env node
// probe-boot.js — REAL electron boot of the launcher against a local Postgres.
// Verifies: clean boot (no IPC/engine errors), NX Cloud link established,
// the encrypted memory vault (vault.bin) created + read-only in .neurax,
// offline login remembered into the vault, admin passkey check via vault IPC.
// Run: DISPLAY=:99 NEURAX_PG_URL=postgres://nx:nxpass@127.0.0.1:54329/postgres \
//        ./node_modules/.bin/electron --no-sandbox --disable-gpu scripts/probe-boot.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

process.env.NEURAX_PG_URL = process.env.NEURAX_PG_URL || 'postgres://nx:nxpass@127.0.0.1:54329/postgres';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-boot-'));
process.env.NEURAX_HOME = HOME;

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    // engine modules against the isolated home
    const settingsMod = require('../src/main/core/settings');
    settingsMod.load();
    settingsMod.set({ nxSupabaseUrl: process.env.NEURAX_PG_URL, nxEnabled: true });

    const nxCloud = require('../src/main/core/nx-cloud');
    const logger = require('../src/main/core/logger');
    const vaultMod = require('../src/main/core/nx-vault');

    // boot the cloud engine exactly like main.js does
    await nxCloud.init(() => {});

    // wait for the NX link (cached-path fast or full sweep — local PG is instant)
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = nxCloud.publicState();
      if (st.connected) break;
      await sleep(500);
    }
    ok(st.connected === true, 'NX Cloud link established on real boot', JSON.stringify(st).slice(0, 160));

    // offline login → vault remembers it
    const auth = require('../src/main/core/auth');
    const acc = auth.loginOffline('BootProbe');
    ok(acc && acc.name === 'BootProbe', 'offline login works');
    const vmem = vaultMod.launcherVault().get();
    ok((vmem.rememberedLogins || []).some((l) => l.name === 'BootProbe'), 'login REMEMBERED in the encrypted vault');
    ok(vmem.lastAccount && vmem.lastAccount.name === 'BootProbe', 'lastAccount mirror written to the vault');
    ok(vmem.adminKey === require('../src/main/core/nx-admin-keys').ADMIN_KEY, 'vault remembers the fixed admin key');
    ok(vmem.unlockPasskey === require('../src/main/core/nx-admin-keys').UNLOCK_PASSKEY, 'vault remembers the fixed unlock passkey');

    // vault file protections (real files on disk)
    const vfile = path.join(HOME, 'vault.bin');
    ok(fs.existsSync(vfile), 'vault.bin exists in the .neurax root');
    const vst = fs.statSync(vfile);
    ok(!(vst.mode & 0o222), 'vault.bin is READ-ONLY on disk');
    ok(fs.readFileSync(vfile, 'latin1').slice(0, 5) === 'NXVB1', 'vault.bin is encrypted (NX vault header, not JSON)');

    // admin passkey check via the same path IPC uses
    let rejected = false, accepted = false;
    try { require('../src/main/core/nx-vault').launcherVault(); } catch {}
    const ipcCheck = (got) => {
      const want = vaultMod.launcherVault().get().unlockPasskey;
      return got === want;
    };
    rejected = !ipcCheck('wrong-passkey');
    accepted = ipcCheck(require('../src/main/core/nx-admin-keys').UNLOCK_PASSKEY);
    ok(rejected && accepted, 'vault-backed passkey check accepts the owner passkey, rejects wrong ones');

    // logs clean of engine errors
    await sleep(1200);
    const hist = logger.getHistory ? logger.getHistory() : [];
    const bad = hist.filter((l) => /IPC (nx:lockState|nx:adminCheck) failed|Unhandled|TypeError|ReferenceError/.test(l.msg || ''));
    ok(bad.length === 0, 'boot log clean — no engine/IPC errors', JSON.stringify(bad).slice(0, 200));

    console.log(`\n==== BOOT RESULT: ${pass} PASS / ${fail} FAIL ====`);
  } catch (e) {
    console.error('FATAL', e);
    fail++;
  }
  try { require('../src/main/core/nx-cloud').shutdown(); } catch {}
  setTimeout(() => app.exit(fail ? 1 : 0), 300);
});
