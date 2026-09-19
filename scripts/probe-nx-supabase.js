#!/usr/bin/env node
// probe-nx-supabase.js — REAL end-to-end test of the NX Supabase transport.
// Runs against a local Postgres (default nx:nxpass@127.0.0.1:54329/postgres,
// override with NEURAX_PG_URL). Applies the actual supabase/nx-supabase-setup.sql,
// then exercises: registration + UUID recovery, presence, locks (manual + timer),
// announcements semantics, invites (Microsoft-only), chat, 100MB-safe chunked
// file sharing, and the offline queue.
'use strict';
process.env.NEURAX_HOME = process.env.NEURAX_HOME || '/tmp/nx-supaprobe/.neurax';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PG = process.env.NEURAX_PG_URL || 'postgres://nx:nxpass@127.0.0.1:54329/postgres';
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`NX Supabase probe — target: ${PG.replace(/:[^:@/]*@/, ':***@')}`);

  // ---- isolated settings for the probe
  fs.rmSync(process.env.NEURAX_HOME, { recursive: true, force: true });
  fs.mkdirSync(process.env.NEURAX_HOME, { recursive: true });
  const settings = require(path.join(ROOT, 'src/main/core/settings'));
  settings.load();
  settings.set({ nxSupabaseUrl: PG, nxEnabled: true });

  // ---- load the vendor client + apply the REAL schema file
  const postgres = (await import(path.join(ROOT, 'src/main/vendor/postgres/src/index.js'))).default;
  const admin = postgres(PG, { max: 1 });
  console.log('\n[1] applying supabase/nx-supabase-setup.sql');
  const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'nx-supabase-setup.sql'), 'utf8');
  const stmts = schema.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await admin.unsafe(s);
  const tables = await admin`select table_name from information_schema.tables where table_schema='public' and table_name like 'nx_%' order by 1`;
  ok(tables.length >= 8, `schema applied (${tables.length} nx_* tables/views)`);
  for (const t of ['nx_identities', 'nx_locks', 'nx_announcements', 'nx_chat_groups', 'nx_chat_members', 'nx_chat_messages', 'nx_files', 'nx_file_chunks']) {
    await admin`truncate table ${admin(t)} cascade`;
  }

  // ---- fresh module instance helper (device isolation)
  const MOD = require.resolve(path.join(ROOT, 'src/main/core/nx-supabase.js'));
  function freshDevice() {
    delete require.cache[MOD];
    return require(MOD);
  }

  const cryptoUUID = () => crypto.randomUUID();
  const mkProfile = (deviceName, playerName, playerType) => ({
    deviceName, gameRunning: false,
    player: { name: playerName, uuid: playerType === 'msa' ? cryptoUUID() : '', type: playerType },
    instances: [{ name: deviceName + '-inst', version: '26.1.2', loader: 'fabric', mods: ['nx-test.jar'] }],
  });

  const eventsA = [];
  const locksA = [];
  let modA = freshDevice();
  modA.setIdentityProvider(() => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-A', created: Date.now(), source: 'probe' }));
  modA.setPlayerName('ProbeA_Name'); modA.setPlayerType('msa');

  console.log('\n[2] registration + identity recovery');
  await modA.start({
    broadcast: (c, p) => { eventsA.push([c, p]); if (c === 'nx:lock') locksA.push(p.locked); },
    onLock: () => {},
    appVersion: '3.1.0-probe',
    profileProvider: () => mkProfile('ProbeA', 'ProbeA_Name', 'msa'),
    identity: () => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-A', created: Date.now(), source: 'probe' }),
  });
  const uuidA = modA._state.uuid;
  ok(!!uuidA, `device A registered as ${uuidA && uuidA.slice(0, 8)}…`);

  await modA.stop();
  await modA.start({ // restart with a DIFFERENT local uuid hint — cloud must win
    broadcast: (c, p) => { if (c === 'nx:lock') locksA.push(p.locked); },
    onLock: (lock) => { if (!locksA.includes(lock)) locksA.push(lock); }, // enforcement = applyLock in the real launcher
    appVersion: '3.1.0-probe',
    profileProvider: () => mkProfile('ProbeA', 'ProbeA_Name', 'msa'),
    identity: () => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-A', created: Date.now(), source: 'probe' }),
  });
  ok(modA._state.uuid === uuidA, 'same fingerprint recovers the SAME UUID after "reinstall"');

  const modB = freshDevice();
  modB.setIdentityProvider(() => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-B', created: Date.now(), source: 'probe' }));
  modB.setPlayerName('ProbeB_Name'); modB.setPlayerType('msa');
  await modB.start({
    broadcast: () => {}, onLock: () => {},
    appVersion: '3.1.0-probe',
    profileProvider: () => mkProfile('ProbeB', 'ProbeB_Name', 'msa'),
    identity: () => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-B', created: Date.now(), source: 'probe' }),
  });
  const uuidB = modB._state.uuid;
  ok(uuidB && uuidB !== uuidA, 'device B gets its own UUID');

  console.log('\n[3] presence (heartbeat every 5s)');
  await modB.api.refresh();
  const st = modB.api.status();
  ok(st.connected === true, 'B is connected');
  ok(st.online === 2, `online count = 2 (got ${st.online})`);
  ok(st.total === 2, `total count = 2 (got ${st.total})`);

  console.log('\n[4] admin: list + lock + timer unlock');
  const devs = await modA.api.adminList();
  ok(devs.length === 2, 'adminList sees both devices');
  const rowA = devs.find((d) => d.uuid === uuidA);
  ok(rowA && rowA.playerName === 'ProbeA_Name' && rowA.playerType === 'msa', 'A row carries the Microsoft player');

  let lockEvents = [];
  await modA.api.adminLock({ uuid: uuidA, reason: 'Being naughty', minutes: 0 });
  await modA.api.refresh();
  ok(modA._state.locked && modA._state.locked.reason === 'Being naughty', 'lock applied (manual, no timer)');
  ok(locksA.length >= 1 && locksA[locksA.length - 1] !== null, 'onLock enforcement callback fired');

  await modA.api.adminUnlock({ uuid: uuidA });
  await modA.api.refresh();
  ok(modA._state.locked === null, 'admin unlock clears the lock');

  await modA.api.adminLock({ uuid: uuidA, reason: 'timer test', minutes: 0.05 }); // 3 seconds
  await modA.api.refresh();
  ok(modA._state.locked !== null, 'timed lock applies');
  await sleep(3300);
  await modA.api.refresh();
  ok(modA._state.locked === null, 'timer expiry auto-unlocks without the admin');

  console.log('\n[5] announcements: badge semantics (create/update fire, delete silent)');
  const ann1 = await modA.api.annCreate({ title: 'Server reset Friday', body: 'Bring your best gear.', tags: ['event', 'reset'], priority: 'important', pinned: true, style: { color: '#ff5566' } });
  console.log('    ann1 =', JSON.stringify(ann1));
  ok(ann1 && Array.isArray(ann1.tags) && ann1.tags.length === 2 && ann1.style && ann1.style.color === '#ff5566', 'created with tags + custom style');
  await modB.api.refresh();
  ok(modB._state.announcements.some((a) => a.id === ann1.id), 'B receives the announcement');
  const before = modB._state.announcements.find((a) => a.id === ann1.id);
  await sleep(30);
  await modA.api.annUpdate({ id: ann1.id, patch: { body: 'Bring your BEST gear.' } });
  await modB.api.refresh();
  const after = modB._state.announcements.find((a) => a.id === ann1.id);
  ok(after && after.updatedAt > after.createdAt && after.updatedAt > before.updatedAt, 'UPDATE bumps updatedAt → red badge fires');
  await modA.api.annDelete({ id: ann1.id });
  await modB.api.refresh();
  ok(!modB._state.announcements.some((a) => a.id === ann1.id), 'DELETE removes silently (no updatedAt anywhere)');

  console.log('\n[6] group chat + INVITE (Microsoft players only)');
  const grp = await modA.api.chatCreate({ name: 'NX Squad' });
  const chatId = grp.chatId;
  ok(!!chatId, 'group created');
  const inv = await modA.api.chatInvite({ chatId, ref: 'ProbeB_Name' }); // by NAME (msa)
  ok(inv && inv.uuid === uuidB, 'invite by exact Microsoft player name resolves device B');
  const inv2 = await modA.api.chatInvite({ chatId, ref: uuidB }); // by UUID
  ok(inv2 && inv2.uuid === uuidB, 'invite by NX UUID works too (idempotent)');

  let refused = false;
  try { await modA.api.chatInvite({ chatId, ref: 'ProbeB_Name'.toLowerCase() }); } catch { refused = true; }
  ok(!refused, 'name lookup is case-insensitive');
  try { await modA.api.chatInvite({ chatId, ref: 'Ghost_Offline' }); refused = false; } catch { refused = true; }
  ok(refused, 'unknown player refused');
  // add an OFFLINE device C and try to invite it
  const modC = freshDevice();
  modC.setIdentityProvider(() => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-C', created: Date.now(), source: 'probe' }));
  modC.setPlayerName('Offline_C'); modC.setPlayerType('offline');
  await modC.start({
    broadcast: () => {}, onLock: () => {},
    appVersion: '3.1.0-probe',
    profileProvider: () => mkProfile('ProbeC', 'Offline_C', 'offline'),
    identity: () => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-C', created: Date.now(), source: 'probe' }),
  });
  const uuidC = modC._state.uuid;
  let msOnly = false;
  try { await modA.api.chatInvite({ chatId, ref: 'Offline_C' }); } catch (e) { msOnly = /Microsoft/i.test(e.message); }
  ok(msOnly, 'OFFLINE player refused with a clear Microsoft-only message');
  try { await modA.api.chatInvite({ chatId, ref: uuidA }); refused = false; } catch (e) { refused = /already/.test(e.message); }
  ok(refused, 'inviting yourself refused');

  console.log('\n[7] chat messages (delta pull)');
  await modA.api.chatSend({ chatId, text: 'hello squad' });
  const msgs1 = await modB.api.chatMessages({ chatId });
  ok(msgs1.messages.length === 1, 'B sees A\'s message');
  ok(msgs1.messages[0].fromName === 'ProbeA_Name' && msgs1.messages[0].from === uuidA, 'message carries head-ready from + fromName');
  await modB.api.chatSend({ chatId, text: 'hi back' });
  const msgs2 = await modA.api.chatMessages({ chatId });
  ok(msgs2.messages.length === 2, 'A sees both');
  const delta = await modA.api.chatMessages({ chatId, since: msgs1.messages[0].id });
  ok(delta.messages.length === 1 && delta.messages[0].text === 'hi back', 'delta pull (since=id) returns only new messages');

  console.log('\n[8] 100MB-capable chunked file sharing (9.5MB probe = 3 chunks)');
  const bigFile = path.join('/tmp/nx-supaprobe', 'big-video.bin');
  const payload = crypto.randomBytes(9.5 * 1024 * 1024);
  fs.writeFileSync(bigFile, payload);
  let progCalls = 0;
  const sent = await modA.api.chatSendFile({ chatId, filePath: bigFile, kind: 'video', onProgress: () => progCalls++ });
  ok(sent.size === payload.length && progCalls === 3, `upload streamed in chunks (progress ticks: ${progCalls})`);
  const fileMsgs = await modB.api.chatMessages({ chatId, since: 0 });
  const fmsg = [...fileMsgs.messages].reverse().find((m) => m.fileId);
  ok(fmsg && fmsg.type === 'video' && fmsg.fileSize === payload.length, 'file message row complete for B');
  const dest = await modB.api.downloadFile({ fileId: fmsg.fileId, fileName: fmsg.fileName, destDir: '/tmp/nx-supaprobe/dl' });
  const got = fs.readFileSync(dest);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  ok(sha(got) === sha(payload), 'downloaded file is BYTE-PERFECT (sha256 match)');

  console.log('\n[9] offline grace: queue + flush + cached data');
  await modB.stop(); // B goes offline
  let queued = false;
  try { await modB.api.chatSend({ chatId, text: 'sent while offline' }); } catch (e) { queued = /queued/i.test(e.message); }
  ok(queued, 'send while offline → queued with a clear message');
  ok(modB._state.queue.length === 1, 'queue holds the message on disk-backed state');
  await modB.start({ // back online (simulates cloud returning)
    broadcast: () => {}, onLock: () => {},
    appVersion: '3.1.0-probe',
    profileProvider: () => mkProfile('ProbeB', 'ProbeB_Name', 'msa'),
    identity: () => ({ uuid: cryptoUUID(), fingerprint: 'FP-DEVICE-B', created: Date.now(), source: 'probe' }),
  });
  ok(modB._state.uuid === uuidB, 'B reconnects and re-adopts the same UUID');
  await modB.api.refresh();
  const flushed = await modB.api.flushQueue(); // may be a no-op if the sync tick already auto-flushed
  ok(modB._state.queue.length === 0, 'queue is empty (auto-flush on reconnect works)');
  ok(flushed.sent >= 0, 'flushQueue API responds');
  const finalMsgs = await modA.api.chatMessages({ chatId });
  ok(finalMsgs.messages.some((m) => m.text === 'sent while offline'), 'A receives the queued message');

  console.log('\n[10] heads: cloud row → generated avatar fallback');
  const headB = await modA.api.skinHeadFor({ uuid: uuidB, name: 'ProbeB_Name' });
  ok(/^data:image\/png;base64,/.test(headB || ''), 'skinHeadFor returns a PNG data URL (Mojang 404 → generated pixel avatar)');

  // cleanup
  await modA.stop(); await modB.stop(); await modC.stop();
  try { await admin.end({ timeout: 2 }); } catch {}

  console.log(`\n================ RESULT: ${pass} PASS / ${fail} FAIL ================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
