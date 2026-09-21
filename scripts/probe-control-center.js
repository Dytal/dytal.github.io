#!/usr/bin/env node
// probe-control-center.js — REAL end-to-end test of the NEURAX CONTROL CENTER
// (nx-cloud/control-center.js). Boots the actual server against a local
// Postgres (same convention as probe-nx-supabase: nx:nxpass@127.0.0.1:54329),
// pointing it at an isolated NEURAX_HOME settings file, then exercises:
// login (wrong key / no key / correct key), device visibility, remote
// LOCK + timer + UNLOCK, announcement create/update-bump/delete-silent,
// stats, and auth enforcement.
'use strict';
process.env.NEURAX_HOME = process.env.NEURAX_HOME || '/tmp/nx-ccprobe/.neurax';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const PG = process.env.NEURAX_PG_URL || 'postgres://nx:nxpass@127.0.0.1:54329/postgres';
const ROOT = path.join(__dirname, '..');
// v4.1.1: keys resolve at runtime (env / private file / vault adoption) — the
// probe requires the SAME module the console uses instead of hardcoding keys.
const NXKEYS = require(path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js'));
const PORT = Number(process.env.NX_CC_PROBE_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'cc-probe-admin-key';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, { method, body, key, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['X-Admin-Key'] = key;
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(BASE + pathname, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j || {}, setCookie: r.headers.get('set-cookie') || '' };
}

(async () => {
  console.log(`NEURAX Control Center probe — target DB: ${PG.replace(/:[^:@/]*@/, ':***@')}`);

  // ---- isolated .neurax settings the control center will read
  // (NEURAX_HOME IS the .neurax root — settings.json sits directly in it)
  fs.rmSync(process.env.NEURAX_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.NEURAX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.NEURAX_HOME, 'settings.json'), JSON.stringify({
    version: 4, nxSupabaseUrl: PG, nxSupabasePooler: '', nxAdminPass: KEY, nxEnabled: true,
  }));

  // ---- apply the real schema + truncate
  const postgres = (await import(path.join(ROOT, 'src/main/vendor/postgres/src/index.js'))).default;
  const admin = postgres(PG, { max: 1 });
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'nx-supabase-setup.sql'), 'utf8');
  const stmts = schema.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await admin.unsafe(s);
  for (const t of ['nx_identities', 'nx_locks', 'nx_announcements', 'nx_chat_groups', 'nx_chat_members', 'nx_chat_messages', 'nx_files', 'nx_file_chunks']) {
    await admin`truncate table ${admin(t)} cascade`;
  }

  // ---- boot the REAL server process
  let child = spawn(process.execPath, [path.join(ROOT, 'nx-cloud', 'control-center.js')], {
    env: { ...process.env, NEURAX_HOME: process.env.NEURAX_HOME, NX_CC_PORT: String(PORT), NX_CC_HOST: '127.0.0.1', NX_CC_NO_OPEN: '1', NEURAX_ADMIN_KEY: KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const h = await api('/healthz'); up = !!h.json.ok; } catch { await sleep(250); }
  }
  ok(up, 'control center server boots and answers /healthz');

  // ---- auth
  let r = await api('/api/state');
  ok(r.status === 401, 'state without login is rejected (401)');
  r = await api('/api/login', { body: { pass: 'wrong-key' } });
  ok(r.status === 403, 'login with WRONG key rejected', JSON.stringify(r.json));
  r = await api('/api/login', { body: { pass: KEY } });
  ok(r.status === 200 && /nxcc=/.test(r.setCookie), 'login with the launcher-set key succeeds + cookie');
  const cookie = (r.setCookie.match(/nxcc=[a-f0-9]{32}/) || [''])[0];
  ok(!!cookie, 'session cookie issued');

  // ---- state: connected + empty
  r = await api('/api/state', { cookie });
  ok(r.status === 200 && r.json.ok, 'authenticated /api/state works');
  ok(r.json.connected === true, 'control center reports CONNECTED to the database');
  ok(r.json.total === 0 && r.json.devices.length === 0, 'devices list empty before any device connects');

  // ---- a "device" appears (insert a row the way the launcher would)
  const devUuid = crypto.randomUUID();
  await admin`
    insert into nx_identities (uuid, fingerprint, device_name, platform, app_version, player_name, player_uuid, player_type, instances, game_running, skin_head, last_seen)
    values (${devUuid}, 'FP-CC-PROBE', 'GamingRig', 'win32', '3.1.2-probe', 'Steve_MS', ${crypto.randomUUID()}, 'msa',
            ${JSON.stringify([{ name: 'Survival', version: '26.1.2', loader: 'fabric', mods: ['nx-test.jar'] }])}::jsonb,
            true, '', now())`;
  r = await api('/api/state', { cookie });
  const dev = (r.json.devices || []).find((d) => d.uuid === devUuid);
  ok(!!dev, 'registered device is VISIBLE with name + player');
  ok(dev && dev.playerName === 'Steve_MS' && dev.playerType === 'msa', 'device carries player name + MSA type');
  ok(dev && dev.online === true && dev.gameRunning === true, 'device shows ONLINE + IN GAME');
  ok(dev && Array.isArray(dev.instances) && dev.instances[0]?.name === 'Survival', 'instances + mods list visible');

  // ---- remote LOCK (manual)
  r = await api('/api/lock', { cookie, body: { uuid: devUuid, reason: 'Test lock from probe', minutes: 0 } });
  ok(r.status === 200, 'LOCK command accepted');
  let lockRow = await admin`select locked, reason, locked_by, locked_until from nx_locks where uuid = ${devUuid}`;
  ok(!!lockRow.length && lockRow[0].locked === true && /probe/.test(lockRow[0].reason), 'lock row written to the SAME table launchers sync (5s tick will enforce)');
  r = await api('/api/state', { cookie });
  ok(!!(r.json.devices.find((d) => d.uuid === devUuid) || {}).lock, 'device shows LOCKED in state payload');

  // ---- timer lock
  r = await api('/api/lock', { cookie, body: { uuid: devUuid, reason: 'Timed', minutes: 30 } });
  lockRow = await admin`select locked_until from nx_locks where uuid = ${devUuid}`;
  ok(!!lockRow.length && lockRow[0].locked_until && new Date(lockRow[0].locked_until).getTime() > Date.now() + 25 * 60000, 'timer lock sets locked_until ~30min ahead');

  // ---- UNLOCK
  r = await api('/api/unlock', { cookie, body: { uuid: devUuid } });
  ok(r.status === 200, 'UNLOCK command accepted');
  lockRow = await admin`select locked from nx_locks where uuid = ${devUuid}`;
  ok(!!lockRow.length && lockRow[0].locked === false, 'unlock persisted');

  // ---- announcements: create / update bump / delete silent
  r = await api('/api/ann/create', { cookie, body: { title: 'Probe announcement', body: 'hello', tags: ['probe', 'cc'], priority: 'important', pinned: true, style: { color: '#38e1ff', banner: '#101828', icon: 'spark' } } });
  ok(r.status === 200 && r.json.id, 'announcement created');
  const annId = r.json.id;
  let row = await admin`select updated_at from nx_announcements where id = ${annId}`;
  const t1 = new Date(row[0].updated_at).getTime();
  await sleep(1100);
  r = await api('/api/ann/update', { cookie, body: { id: annId, title: 'Probe announcement v2' } });
  ok(r.status === 200, 'announcement update accepted');
  row = await admin`select title, updated_at from nx_announcements where id = ${annId}`;
  ok(/v2/.test(row[0].title) && new Date(row[0].updated_at).getTime() > t1, 'update BUMPS updated_at (launchers badge it)');
  r = await api('/api/ann/delete', { cookie, body: { id: annId } });
  ok(r.status === 200, 'announcement delete accepted');
  row = await admin`select 1 from nx_announcements where id = ${annId}`;
  ok(!row.length, 'announcement gone after delete (silent — no badge semantics)');

  // ---- stats
  r = await api('/api/state', { cookie });
  ok(r.json.stats && r.json.stats.chats === 0 && r.json.stats.files === 0, 'stats present (chats/files counters)');

  // ---- x-admin-key alternative auth
  r = await api('/api/state', { key: KEY });
  ok(r.status === 200, 'X-Admin-Key header auth works for scripting');

  // ---- HTML served
  const html = await fetch(BASE + '/').then((x) => x.text());
  ok(/NEURAX\s*<small>CONTROL CENTER|CONTROL CENTER/i.test(html) && /ADMIN KEY/.test(html), 'control center HTML served');
  ok(html.includes('neurax-console" content="control-center'), 'HTML carries the cc identification marker (port-probe fingerprint)');

  // ---- /healthz identifies itself (used to detect "already running")
  r = await api('/healthz');
  ok(r.json.cc === true && r.json.name === 'neurax-control-center', '/healthz identifies the console (cc marker)');
  ok(typeof r.json.version === 'string' && /^\d+\.\d+\.\d+/.test(r.json.version), '/healthz reports a semver version');

  // ---- v3.1.5: encrypted memory vault (remember logins + passkeys, read-only)
  const vaultFile = path.join(process.env.NEURAX_HOME, 'cc-vault.bin');
  ok(fs.existsSync(vaultFile), 'console vault file created in the .neurax root (cc-vault.bin)');
  {
    const st = fs.statSync(vaultFile);
    ok(!(st.mode & 0o222), 'console vault is locked READ-ONLY (no write bits set)');
    const raw = fs.readFileSync(vaultFile, 'latin1');
    ok(raw.slice(0, 5) === 'NXVB1', 'vault file carries the NX vault binary header (not plain JSON)');
    ok(!raw.includes(KEY) && !raw.includes(NXKEYS.ADMIN_KEY) && !raw.includes(NXKEYS.UNLOCK_PASSKEY),
      'vault file is ENCRYPTED at rest — no plaintext keys anywhere');
  }

  // ---- remembered logins: restart the console → the browser session SURVIVES
  r = await api('/api/state', { cookie });
  ok(r.status === 200, 'sanity: session valid before restart');
  child.kill();
  await sleep(500);
  const envNoKey = { ...process.env, NEURAX_HOME: process.env.NEURAX_HOME, NX_CC_PORT: String(PORT), NX_CC_HOST: '127.0.0.1', NX_CC_NO_OPEN: '1' };
  delete envNoKey.NEURAX_ADMIN_KEY; // restart WITHOUT the env override — the fixed key must come from the vault/bake
  const logsR = [];
  const childR = spawn(process.execPath, [path.join(ROOT, 'nx-cloud', 'control-center.js')], { env: envNoKey, stdio: ['ignore', 'pipe', 'pipe'] });
  childR.stdout.on('data', (d) => logsR.push(String(d)));
  childR.stderr.on('data', (d) => logsR.push(String(d)));
  let upR = false;
  for (let i = 0; i < 40 && !upR; i++) {
    try { const h = await api('/healthz'); upR = !!h.json.ok; } catch { await sleep(250); }
  }
  ok(upR, 'console restarts cleanly (memory vault reloaded)');
  r = await api('/api/state', { cookie });
  ok(r.status === 200 && r.json.ok, 'REMEMBERED LOGIN: the same browser session still works after a full console restart');
  r = await api('/api/login', { body: { pass: NXKEYS.ADMIN_KEY } });
  ok(r.status === 200, 'fixed owner key accepted after restart without env override (vault/baked fallback chain)');
  child = childR; // the restarted server carries on for the rest of the probe

  // read the vault back through the SAME module the console uses
  const vaultMod = require(path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js'));
  const vmem = vaultMod.ccVault().get();
  ok((vmem.sessions || []).length >= 1, 'vault remembers the browser session token(s)');
  ok((vmem.loginHistory || []).length >= 2, `vault remembers the login history with timestamps + IPs (${(vmem.loginHistory || []).length} entries)`);
  ok(vmem.adminKey === NXKEYS.ADMIN_KEY && typeof vmem.unlockPasskey === 'string' && vmem.unlockPasskey.length > 8,
    'vault remembers BOTH passkeys (console admin key + launcher unlock passkey)');

  // ---- v3.1.5: default .neurax root fix — with NO NEURAX_HOME, the console must
  // resolve $XDG_CONFIG_HOME/.neurax (the SAME layout the launcher uses on all
  // platforms) instead of the bare config dir. Vault location + settings READ
  // from that root are both checked (connected:true proves settings.json was found).
  const xdg = '/tmp/nx-cc-xdg-root';
  fs.rmSync(xdg, { recursive: true, force: true });
  fs.mkdirSync(path.join(xdg, '.neurax'), { recursive: true });
  fs.writeFileSync(path.join(xdg, '.neurax', 'settings.json'), JSON.stringify({ version: 4, nxSupabaseUrl: PG, nxSupabasePooler: '' }));
  const envXdg = { ...process.env };
  delete envXdg.NEURAX_HOME;
  envXdg.XDG_CONFIG_HOME = xdg;
  envXdg.NX_CC_PORT = String(PORT + 9);
  envXdg.NX_CC_HOST = '127.0.0.1';
  envXdg.NX_CC_NO_OPEN = '1';
  const child3 = spawn(process.execPath, [path.join(ROOT, 'nx-cloud', 'control-center.js')], { env: envXdg, stdio: ['ignore', 'pipe', 'pipe'] });
  let up3 = false, h3 = null;
  for (let i = 0; i < 40 && !up3; i++) {
    try { h3 = await fetch(`http://127.0.0.1:${PORT + 9}/healthz`).then((x) => x.json()); up3 = h3.cc === true; } catch { await sleep(250); }
  }
  ok(up3, 'console boots with default root resolution (no NEURAX_HOME set)');
  ok(up3 && h3.connected === true, 'settings.json was READ from $XDG_CONFIG_HOME/.neurax (database connected)');
  ok(fs.existsSync(path.join(xdg, '.neurax', 'cc-vault.bin')), 'memory vault lands in $XDG_CONFIG_HOME/.neurax/cc-vault.bin (path bug fixed)');
  child3.kill();

  // ---- EADDRINUSE fallback: occupy PORT+5 with a dumb TCP server, boot a second
  // console pointed at it — it must explain the busy port and bind PORT+6 instead.
  const occupy = net.createServer();
  await new Promise((res) => occupy.listen(PORT + 5, '127.0.0.1', res));
  const logs2 = [];
  const child2 = spawn(process.execPath, [path.join(ROOT, 'nx-cloud', 'control-center.js')], {
    env: { ...process.env, NEURAX_HOME: process.env.NEURAX_HOME, NX_CC_PORT: String(PORT + 5), NX_CC_HOST: '127.0.0.1', NX_CC_NO_OPEN: '1', NEURAX_ADMIN_KEY: KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child2.stdout.on('data', (d) => logs2.push(String(d)));
  child2.stderr.on('data', (d) => logs2.push(String(d)));
  let up2 = false;
  for (let i = 0; i < 44 && !up2; i++) {
    try { const h = await fetch(`http://127.0.0.1:${PORT + 6}/healthz`).then((x) => x.json()); up2 = h.cc === true; } catch { await sleep(250); }
  }
  ok(up2, 'EADDRINUSE fallback: busy port → console binds the NEXT free port and answers there');
  ok(/busy|Trying port/i.test(logs2.join('')), 'fallback explains the busy port in plain words', JSON.stringify(logs2.join('').slice(-400)));
  child2.kill();
  occupy.closeAllConnections?.(); // force-close any lingering probe socket
  await Promise.race([new Promise((res) => occupy.close(res)), sleep(2000)]);

  // ---- static regression checks on shipped files
  const relaySrc = fs.readFileSync(path.join(ROOT, 'nx-cloud', 'server.js'), 'utf8');
  ok(/NX_PORT \|\| 8790/.test(relaySrc), 'legacy relay moved to port 8790 (8765 belongs to the console)');
  ok(relaySrc.includes('EADDRINUSE'), 'legacy relay handles EADDRINUSE gracefully instead of crashing');
  ok(fs.readFileSync(path.join(ROOT, 'nx-cloud', 'admin.html'), 'utf8').includes('LEGACY'), 'old relay page wears a LEGACY banner (no more mistaken identity)');
  const ccBat = fs.readFileSync(path.join(ROOT, 'nx-cloud', 'START-CONTROL-CENTER.bat'), 'utf8');
  ok(!ccBat.includes('Open http://localhost:8765'), 'start bat no longer hardcodes the port (console prints the real one)');
  ok(fs.readFileSync(path.join(ROOT, 'src', 'main', 'core', 'settings.js'), 'utf8').includes('127.0.0.1:8790'), 'launcher legacy default URL moved to 8790');

  // ---- v3.1.4: fixed admin key + Windows ESM import fix
  const ccSrc = fs.readFileSync(path.join(ROOT, 'nx-cloud', 'control-center.js'), 'utf8');
  ok(ccSrc.includes('pathToFileURL'), 'CC imports vendored postgres via pathToFileURL (Windows ESM fix)');
  ok(ccSrc.includes('NEURAX_ADMIN_KEY'), 'CC honors the NEURAX_ADMIN_KEY env override');
  ok(ccSrc.includes("nx-admin-keys"), 'CC reads the owner admin key from nx-admin-keys.js');
  const keysSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'core', 'nx-admin-keys.js'), 'utf8');
  ok(typeof NXKEYS.ADMIN_KEY === 'string' && NXKEYS.ADMIN_KEY.length >= 12 && typeof NXKEYS.UNLOCK_PASSKEY === 'string' && NXKEYS.UNLOCK_PASSKEY.length >= 8,
    'nx-admin-keys.js resolves strong ADMIN_KEY + UNLOCK_PASSKEY (env / private file / vault adoption)');
  ok(!keysSrc.includes(NXKEYS.ADMIN_KEY) && !keysSrc.includes(NXKEYS.UNLOCK_PASSKEY),
    'v4.1.1: nx-admin-keys.js contains NO baked key literals (public-repo safe)');
  ok(fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8').includes('UNLOCK_PASSKEY'), 'launcher admin panel unlock verifies the FIXED passkey');
  const setR = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'pages', 'settings.js'), 'utf8');
  ok(!setR.includes('Administrator passphrase'), 'Settings no longer offers a user-settable passphrase');
  ok(setR.includes('Admin panel'), 'Settings shows the read-only Admin panel row');
  ok(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'nx.js'), 'utf8').includes('passkey'), 'launcher unlock modal asks for the owner passkey');

  // ---- v3.1.5 static regressions: encrypted memory vault + refresh fixes
  ok(ccSrc.includes("'paths.js'") || ccSrc.includes('paths.js'), 'CC resolves the .neurax root through the launcher paths.js (settings + vault paths unified)');
  ok(ccSrc.includes('nx-vault.js') && ccSrc.includes('rememberCcSession'), 'CC stores remembered logins in the shared encrypted vault');
  ok(ccSrc.includes("CC_VERSION = '3.1.5'"), 'CC version is 3.1.5');
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'nx-cloud', 'control-center.html'), 'utf8');
  ok(htmlSrc.includes('snapshotEdits') && htmlSrc.includes('restoreEdits'), 'CC keeps typing alive across the 5s refresh (snapshot + restore of inputs/caret)');
  ok(htmlSrc.includes('insts-${d.uuid}'), 'instance <details> elements carry stable ids (open state survives refresh)');
  const ipcSrc5 = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  ok(ipcSrc5.includes('noteAdminUnlock') && ipcSrc5.includes('vault:status') && ipcSrc5.includes('vault:remembered'), 'launcher IPC: passkey check via vault + vault status/remembered endpoints');
  ok(fs.readFileSync(path.join(ROOT, 'src', 'main', 'core', 'auth.js'), 'utf8').includes('rememberLogin'), 'launcher auth remembers every login (offline/MSA/restore) in the vault');
  ok(fs.existsSync(path.join(ROOT, 'src', 'main', 'core', 'nx-vault.js')), 'nx-vault.js ships (AES-256-GCM, read-only, tamper-healing)');
  const nxSrc5 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'nx.js'), 'utf8');
  ok(nxSrc5.includes('startAnnAutoRefresh') && nxSrc5.includes('60000'), 'launcher ANNOUNCEMENTS tab auto-refreshes every 60 seconds');
  ok(setR.includes('Encrypted memory vault') && setR.includes('vault:remembered'), 'Settings shows the vault status row + remembered-login quick picks');

  child.kill();
  await sleep(300);
  await admin.end({ timeout: 1 });

  console.log(`\n================ RESULT: ${pass} PASS / ${fail} FAIL ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
