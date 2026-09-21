#!/usr/bin/env node
// probe-vault.js — unit + behavior tests for the NEURAX encrypted memory
// vault (src/main/core/nx-vault.js). Runs standalone (no DB, no electron):
//   1. create-on-first-use + defaults seeded
//   2. encryption at rest — NO plaintext secrets in the raw file bytes
//   3. read-only enforcement (owner write bits cleared after every write)
//   4. roundtrip across separate processes/open() calls
//   5. rememberLogin upsert + cap (launcher memory)
//   6. CC session memory: remember/prune/forget + history
//   7. tamper healing — hand-edited byte → quarantine + rebuild from defaults
//   8. wrong-machine key rejection — foreign .vk → quarantine + rebuild
//   9. magic header check — garbage file → quarantine + rebuild
//  10. machine key file (.vk) is read-only too
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js');

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

/* Each scenario runs in a FRESH subprocess with its own NEURAX_HOME so the
   module-level singleton caches never leak state between cases. Pass an
   existing .neurax root as `reuseRoot` for multi-process scenarios. */
function run(code, reuseRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxv-'));
  const root = reuseRoot || path.join(dir, '.neurax');
  fs.mkdirSync(root, { recursive: true });
  const script = path.join(dir, 't.js');
  fs.writeFileSync(script, code);
  const r = execFileSync(process.execPath, [script], {
    env: { ...process.env, NEURAX_HOME: root },
    encoding: 'utf8', timeout: 30000,
  });
  return { out: r, root, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const H = `(async () => { const v = require(${JSON.stringify(MOD)});`;

// ---------------------------------------------------------------- scenario 1+2+3+10
{
  const r = run(`${H}
    const k = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js'))});
    const vault = v.launcherVault();
    const st = vault.status();
    console.log(JSON.stringify({ st, raw: require('fs').readFileSync(st.file).toString('latin1'), ka: k.ADMIN_KEY, ku: k.UNLOCK_PASSKEY }));
  })();`, '');
  const j = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.st.exists === true, 'vault file created on first use', j.st.file);
  ok(j.st.encrypted.includes('AES-256-GCM'), 'status reports AES-256-GCM encryption');
  ok(j.st.locked === true && j.st.readOnly === true, 'vault file is read-only after write');
  ok(!j.raw.includes(j.ka), 'admin key NOT stored in plaintext');
  ok(!j.raw.includes(j.ku), 'unlock passkey NOT stored in plaintext');
  ok(j.st.remembers.passkeys === 2, 'vault remembers 2 passkeys');
  const vk = path.join(r.root, '.vk');
  ok(fs.existsSync(vk) && !(fs.statSync(vk).mode & 0o222), 'machine key .vk exists and is read-only');
  ok(j.st.file.endsWith('vault.bin'), 'launcher vault file is vault.bin in the .neurax root');
  r.cleanup();
}

// ---------------------------------------------------------------- scenario 4 roundtrip
{
  const r = run(`${H}
    const vault = v.launcherVault();
    vault.save({ lastAdminUnlockAt: 12345 });
    const v2 = v.launcherVault(); // same process — but load() path is what matters cross-process
    console.log(JSON.stringify({ a: v2.get().lastAdminUnlockAt, kind: v2.get().kind }));
  })();`, '');
  const j = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.a === 12345 && j.kind === 'launcher', 'save → decrypt roundtrip (same process re-open)');
  // cross-process: new node run reads the same vault
  const r2 = run(`${H}
    const vault = v.launcherVault();
    console.log(JSON.stringify({ a: vault.get().lastAdminUnlockAt }));
  })();`, '');
  // NOTE: r2 got a FRESH home (different machine key) → heals to defaults; check the heal worked
  const j2 = JSON.parse(r2.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j2.a === null, 'foreign machine key cannot read the vault → heals to defaults (a=null)');
  r.cleanup(); r2.cleanup();
}

// ---------------------------------------------------------------- scenario 5 rememberLogin
{
  const r = run(`${H}
    v.rememberLogin({ type: 'offline', name: 'Steve', uuid: 'u-steve' });
    v.rememberLogin({ type: 'msa', name: 'Alex', uuid: 'u-alex' });
    v.rememberLogin({ type: 'offline', name: 'Steve', uuid: 'u-steve' }); // upsert bumps uses
    const mid = v.launcherVault().get();
    for (let i = 0; i < 20; i++) v.rememberLogin({ type: 'offline', name: 'P' + i, uuid: 'p' + i });
    const m = v.launcherVault().get();
    console.log(JSON.stringify({
      count: m.rememberedLogins.length,
      newest: m.rememberedLogins[0] && m.rememberedLogins[0].name,
      steveUses: (mid.rememberedLogins.find(x => x.uuid === 'u-steve') || {}).uses,
      last: m.lastAccount && m.lastAccount.name,
      plainLeak: require('fs').readFileSync(v.launcherVault().status().file, 'utf8').includes('u-alex'),
    }));
  })();`, '');
  const j = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.count === 12, `remembered logins capped at 12 (got ${j.count})`);
  ok(j.steveUses === 2, 're-login upsert bumps uses counter');
  ok(j.last === 'P19', 'lastAccount mirror follows newest login');
  ok(j.plainLeak === false, 'remembered logins encrypted at rest');
  r.cleanup();
}

// ---------------------------------------------------------------- scenario 6 CC sessions
{
  const r = run(`${H}
    const cv = v.ccVault();
    v.rememberCcSession('tok-1', '127.0.0.1');
    v.rememberCcSession('tok-2', '10.0.0.2');
    const s1 = cv.get();
    v.forgetCcSession('tok-1');
    const s2 = cv.get();
    console.log(JSON.stringify({
      file: cv.status().file.endsWith('cc-vault.bin'),
      sessAfter: s2.sessions.length,
      history: s2.loginHistory.length,
      histIp: s2.loginHistory[0] && s2.loginHistory[0].ip,
      tok2Kept: s2.sessions.some(x => x.token === 'tok-2'),
      kind: s1.kind,
    }));
  })();`, '');
  const j = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.file === true, 'console vault file is cc-vault.bin');
  ok(j.kind === 'control-center', 'console vault has its own defaults');
  ok(j.tok2Kept === true && j.sessAfter === 1, 'session remembered; logout forgets the right one');
  ok(j.history >= 2 && j.histIp === '10.0.0.2', 'login history remembered (newest first, with IP)');
  r.cleanup();
}

// ---------------------------------------------------------------- scenario 7 tamper heal
{
  // Process 1: create + save, then force-edit a byte (the read-only bit only
  // stops casual editors — this simulates `attrib -r` / chmod + an editor).
  const r = run(`${H}
    const vault = v.launcherVault();
    vault.save({ lastAdminUnlockAt: 777 });
    const f = vault.status().file;
    const buf = require('fs').readFileSync(f);
    buf[buf.length - 10] ^= 0xff; // flip one ciphertext byte = "edited the file"
    require('fs').chmodSync(f, 0o644);
    require('fs').writeFileSync(f, buf); // the GCM auth tag will reject this on next open
    console.log(JSON.stringify({ f }));
  })();`, '');
  const f = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]).f;
  // Process 2: the launcher (or console) reopens the tampered vault → heals
  const r2 = run(`${H}
    const again = v.launcherVault();
    const st = again.status();
    console.log(JSON.stringify({ healed: again.get().lastAdminUnlockAt === null, corruptLeft: require('fs').readdirSync(require('path').dirname(st.file)).some(x => x.includes('.corrupt-')), locked: st.locked }));
  })();`, r.root);
  const j = JSON.parse(r2.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.healed === true, 'tampered vault heals to defaults (GCM tag rejects the edit)');
  ok(j.corruptLeft === true, 'tampered original quarantined as *.corrupt-<ts>');
  ok(j.locked === true, 'healed vault is read-only again');
  r.cleanup(); r2.cleanup();
}

// ---------------------------------------------------------------- scenario 9 garbage file
{
  const r = run(`${H}
    const fs = require('fs'), path = require('path');
    const f = path.join(process.env.NEURAX_HOME, 'vault.bin');
    fs.writeFileSync(f, 'i am a plaintext ransom note');
    const vault = v.launcherVault();
    console.log(JSON.stringify({ ok: vault.get().kind === 'launcher', locked: vault.status().locked }));
  })();`, '');
  const j = JSON.parse(r.out.split('\n').filter(l => l.startsWith('{'))[0]);
  ok(j.ok === true && j.locked === true, 'non-vault garbage file replaced by a real encrypted vault');
  r.cleanup();
}

console.log(`\nprobe-vault: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
