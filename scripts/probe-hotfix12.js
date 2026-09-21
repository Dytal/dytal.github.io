// probe-hotfix12.js — engine checks for the boot-unblocking fix.
// Boots NO electron app — just the auth core with a FAKE network layer
// (patched before auth.js loads, so its destructured `request` is ours):
//   1. currentAccount() (display) resolves INSTANTLY with a provisional
//      account while a "slow" restore is still in flight  ← THE 15s BUG
//   2. restoreSessionShared() called 3× concurrently hits the network ONCE
//      (parallel refreshes used to race + could invalidate rotated tokens)
//   3. currentAccountForLaunch() WAITS for the (failing) restore → null,
//      so launches can never run on a provisional no-token account
//   4. no tokens → offline 'Player' instantly
//   5. explicit offline login still remembers + returns offline account
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const CORE = path.join(__dirname, '..', 'src', 'main', 'core');

/* ---- fake network BEFORE auth.js is required ---------------------------- */
const calls = [];
let netDelay = 2500;
const net = require(path.join(CORE, 'net.js'));
net.request = async (url, opts = {}) => {
  calls.push(url);
  await new Promise(r => setTimeout(r, netDelay));
  throw new Error('probe fake network down: ' + url);
};

const auth = require(path.join(CORE, 'auth.js'));
const settingsMod = require(path.join(CORE, 'settings.js'));
const paths = require(path.join(CORE, 'paths.js'));
const TOKENS_FILE = path.join(paths.DIRS.auth, 'tokens.json');

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  /* saved MSA login: plain-enc blobs decrypt without safeStorage */
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify({
    flow: 'live',
    msRefresh: { enc: 'plain', v: b64('fake-refresh-token') },
    clientId: { enc: 'plain', v: b64('fake-client-id') },
    profile: { name: 'ProvUser', uuid: 'uuid-prov-0001' },
  }));
  settingsMod.set({ lastAccount: { type: 'msa', name: 'ProvUser', uuid: 'uuid-prov-0001' } });

  /* 1. display account resolves INSTANTLY (restore runs in background) */
  const t0 = Date.now();
  const acc = await auth.currentAccount();
  const dt = Date.now() - t0;
  check('display currentAccount() is INSTANT (<400ms) despite slow net', dt < 400, `took ${dt}ms`);
  check('display account is provisional with saved name, no token',
    acc && acc.provisional === true && acc.name === 'ProvUser' && acc.accessToken === null,
    JSON.stringify(acc && { name: acc.name, prov: acc.provisional, tok: acc.accessToken }));

  /* 2. concurrent restores share ONE network chain.
     (Test 1's background restore may still be in flight — wait for it to
     clear, then 3 fresh concurrent calls must hit the network exactly once.) */
  await sleep(3000); // let the fake 2500ms chain from test 1 finish
  const before = calls.length;
  const [a, b, c] = await Promise.all([
    auth.restoreSessionShared(), auth.restoreSessionShared(), auth.restoreSessionShared(),
  ]);
  const netCalls = calls.length - before;
  check('3 concurrent restoreSessionShared() → exactly 1 network call', netCalls === 1, `made ${netCalls} calls`);
  check('all three get the same (null — fake net) result', a === null && b === null && c === null);

  /* 3. launch path WAITS for the real chain (never provisional) */
  netDelay = 700;
  const t1 = Date.now();
  const launchAcc = await auth.currentAccountForLaunch();
  const dt1 = Date.now() - t1;
  check('currentAccountForLaunch() awaited the failing restore', launchAcc === null && dt1 >= 500, `took ${dt1}ms, acc=${JSON.stringify(launchAcc)}`);

  /* 4. no tokens → offline 'Player' instantly */
  fs.rmSync(TOKENS_FILE, { force: true });
  const t2 = Date.now();
  const offline = await auth.currentAccount();
  check('no tokens → offline Player instantly', offline && offline.type === 'offline' && offline.name === 'Player' && Date.now() - t2 < 300);

  /* 5. explicit offline login still remembered */
  settingsMod.set({ lastAccount: null });
  const named = auth.loginOffline('Steve');
  const cur = await auth.currentAccount();
  check('offline login remembered (named offline account)', named.type === 'offline' && cur.type === 'offline' && cur.name === 'Steve');

  /* cleanup: leave a clean offline state for real boots on this machine */
  settingsMod.set({ lastAccount: { type: 'offline', name: 'Player', uuid: offline.uuid } });

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('PROBE_FAIL', e); process.exit(1); });
