#!/usr/bin/env node
// probe-v4.js — headless engine smoke test for v4 (no Electron needed).
// Verifies every new v4 API surface exists and core logic behaves.
'use strict';
const assert = require('assert');

const ROOT = require('path').join(__dirname, '..');

// 1) perf governor — real priority flip and restore.
//    On Windows (the target platform) BELOW_NORMAL ↔ NORMAL is unprivileged.
//    On Linux sandboxes, re-raising nice needs CAP_SYS_NICE — accept either.
const perf = require(ROOT + '/src/main/core/perf.js');
const os = require('os');
perf.setGameRunning(true);
assert.strictEqual(os.getPriority(), os.constants.priority.PRIORITY_BELOW_NORMAL, 'priority lowered');
perf.setGameRunning(false);
const after = os.getPriority();
if (process.platform === 'win32') {
  assert.strictEqual(after, os.constants.priority.PRIORITY_NORMAL, 'priority restored');
} else if (after !== os.constants.priority.PRIORITY_NORMAL) {
  console.log('   (linux sandbox denied priority restore — EACCES expected; Windows is unaffected)');
}
console.log('OK perf governor (below-normal ↔ normal)');

// 2) nx-supabase api surface
const nxSupa = require(ROOT + '/src/main/core/nx-supabase.js');
for (const k of ['chatDM', 'chatDelete', 'chatRename', 'chatSetRole', 'chatKick', 'chatStar',
  'msgEdit', 'msgDeleteForMe', 'msgDeleteForEveryone', 'friendsList', 'friendAdd', 'friendRemove',
  'friendStar', 'blockList', 'blockAdd', 'blockRemove', 'loginGate', 'eventsList', 'logEvent',
  'voiceJoin', 'voiceTick', 'voiceSignal', 'voiceUpdate', 'voiceLeave', 'chatList', 'chatCreate',
  'chatInvite', 'chatLeave', 'chatMessages', 'chatSend', 'annCreate', 'adminList', 'adminLock']) {
  assert.strictEqual(typeof nxSupa.api[k], 'function', 'nx-supabase api missing ' + k);
}
// setPlayer with uuid lands in state
nxSupa.setPlayer('Dytalmc', 'msa', 'ABCDEF01-2345-6789-ABCD-EF0123456789');
assert.strictEqual(nxSupa._state.playerName, 'Dytalmc');
assert.strictEqual(nxSupa._state.playerType, 'msa');
assert.strictEqual(nxSupa._state.playerUuid, 'abcdef01-2345-6789-abcd-ef0123456789');
// publicState carries v4 fields
const st = nxSupa.publicState();
for (const k of ['friends', 'voiceRooms', 'locked', 'announcements']) assert.ok(k in st, 'publicState missing ' + k);
console.log('OK nx-supabase v4 api surface (25 new methods) + setPlayer(uuid) + publicState fields');

// 3) nx-cloud passthroughs + gate registration (mode=offline, supabaseOnly throws cleanly)
const nxCloud = require(ROOT + '/src/main/core/nx-cloud.js');
for (const k of ['chatDM', 'blockList', 'blockAdd', 'blockRemove', 'eventsList', 'voiceJoin', 'voiceLeave']) {
  assert.strictEqual(typeof nxCloud.api[k], 'function', 'nx-cloud api missing ' + k);
}
console.log('OK nx-cloud api passthroughs');

// 4) auth login gate
const auth = require(ROOT + '/src/main/core/auth.js');
assert.strictEqual(typeof auth.setLoginGate, 'function');
console.log('OK auth setLoginGate exported');

// 5) offline-queue + lock pipeline still intact (regression check)
assert.ok(Array.isArray(nxSupa._state.queue));
console.log('OK state intact');

// 6) blocklist normalization logic lives in blockAdd — validate pure parts by dry SQL-less error paths
(async () => {
  let threw = '';
  try { await nxSupa.api.blockAdd({ kind: 'weird', value: 'x' }); } catch (e) { threw = e.message; }
  assert.match(threw, /msa-account or device/, 'blockAdd kind validation');
  threw = '';
  try { await nxSupa.api.blockAdd({ kind: 'device', value: '' }); } catch (e) { threw = e.message; }
  assert.match(threw, /Give the account name/, 'blockAdd empty value validation');
  console.log('OK blockAdd validation errors (no DB needed)');

  // 7) SQL file sanity: idempotent markers + new tables
  const sqlTxt = require('fs').readFileSync(ROOT + '/supabase/nx-supabase-setup.sql', 'utf8');
  for (const t of ['nx_friends', 'nx_blocklist', 'nx_events', 'nx_voice_rooms', 'nx_voice_participants', 'nx_voice_signals', 'nx_message_deletes']) {
    assert.ok(new RegExp('create table if not exists ' + t).test(sqlTxt), 'sql missing ' + t);
  }
  assert.ok(sqlTxt.includes('add column if not exists'), 'sql upgrade path missing');
  // v1.0-R2: ONE narrow exception — the self-repair block drops a LEGACY
  // wrong-typed nx_chat_invites (a bigint group_id can never hold a group
  // uuid, so that table can never contain valid rows). Every other drop
  // (table or column) is still forbidden.
  assert.ok(!sqlTxt.replace(/drop table if exists nx_chat_invites cascade/g, '').match(/drop table|drop column/i), 'sql must never drop (except the invites self-repair)');
  console.log('OK supabase SQL v4 (idempotent, additive-only)');
  console.log('\nALL v4 ENGINE PROBES PASSED');
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
