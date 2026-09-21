// probe-hotfix9.js — engine-level checks for the server console history engine.
// Plain node (no Electron): exercises pushConsoleLine / getLog / clearLog /
// getRuntime against the real store, including the disk-hydration path that
// makes console history survive navigation AND launcher restarts.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const store = require('../src/main/core/store');
const servers = require('../src/main/core/servers');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

async function main() {
  console.log('probe-hotfix9 — server console history + run-state engine');

  // capture engine broadcasts
  const events = [];
  servers.setBroadcaster((ch, payload) => { if (ch === 'server:event') events.push(payload); });

  const srv = store.createServer({ name: 'Probe9 Hist', type: 'vanilla', version: '1.21.4', port: 25599, memoryMB: 1024, motd: 'probe' });
  const id = srv.id;
  const dir = store.serverDir(id);
  try {
    // 1. fresh runtime snapshot
    let rt = servers.getRuntime();
    check('getRuntime returns {running:[], startedAt:{}} for a quiet engine',
      Array.isArray(rt.running) && !rt.running.includes(id) && rt.startedAt instanceof Object);

    // 2. fresh log = empty (no throw)
    check('getLog on a brand-new server returns []', servers.getLog(id).length === 0);

    // 3. DISK HYDRATION — simulate lines written by a PREVIOUS launcher session
    //    (this is exactly what a restart looks like to the engine)
    const logFile = path.join(dir, 'logs', 'neurax-console.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const old = [
      { line: '[Old session] Starting minecraft server version 1.21.4', level: 'info', t: Date.now() - 8e6 },
      { line: '[Old session] Done (2.817s)! For help, type "help"', level: 'game', t: Date.now() - 8e6 + 3000 },
    ];
    fs.writeFileSync(logFile, old.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
    // simulate a fresh engine: drop the in-memory buffer, force re-hydration
    servers.clearLog(id); // clears buffer AND deletes the file... so re-create AFTER clear
    fs.writeFileSync(logFile, old.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
    // hydrate through a REAL fresh path: a second server id whose buffer was never touched
    const srv2 = store.createServer({ name: 'Probe9 Hydrate', type: 'vanilla', version: '1.21.4', port: 25598, memoryMB: 1024, motd: 'probe' });
    const logFile2 = path.join(store.serverDir(srv2.id), 'logs', 'neurax-console.log');
    fs.mkdirSync(path.dirname(logFile2), { recursive: true });
    fs.writeFileSync(logFile2, old.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
    const hydrated = servers.getLog(srv2.id);
    check('getLog hydrates history from disk on first access (restart scenario)',
      hydrated.length === 2 && hydrated[0].line.includes('Old session'),
      `got ${hydrated.length} lines`);
    store.deleteServer(srv2.id);

    // 4. live line: buffer + disk + broadcast
    const before = events.length;
    servers.pushConsoleLine(id, '[Server thread/INFO]: Done (3.214s)! For help, type "help"', 'game');
    const buf = servers.getLog(id);
    check('pushConsoleLine appends to the in-memory buffer',
      buf.some(l => l.line.includes('Done (3.214s)')));
    const diskRaw = fs.readFileSync(logFileFor(id), 'utf8');
    check('pushConsoleLine appends to the on-disk console log', diskRaw.includes('Done (3.214s)'));
    const lastEvt = events[events.length - 1];
    check('pushConsoleLine broadcasts a server:event log line',
      events.length > before && lastEvt.event === 'log' && lastEvt.serverId === id && lastEvt.payload.line.includes('Done'),
      JSON.stringify(lastEvt || {}));

    // 5. ring buffer cap (push 1200 more, expect cap 1000)
    for (let i = 0; i < 1200; i++) servers.pushConsoleLine(id, 'spam ' + i, 'game');
    check('ring buffer caps at 1000 lines', servers.getLog(id).length <= 1000, `got ${servers.getLog(id).length}`);

    // 6. clear: memory + disk + log-cleared broadcast
    servers.clearLog(id);
    check('clearLog empties the buffer', servers.getLog(id).length === 0);
    check('clearLog deletes the on-disk log file', !fs.existsSync(logFileFor(id)));
    check('clearLog broadcasts log-cleared', events.some(e => e.event === 'log-cleared' && e.serverId === id));

    // 7. stopServer on a non-running server is a safe false (no throw)
    check('stopServer on a stopped server returns false safely', servers.stopServer(id) === false);

    // 8. getRuntime still sane after all the churn
    rt = servers.getRuntime();
    check('getRuntime stays consistent after churn', !rt.running.includes(id));

    function logFileFor(serverId) { return path.join(store.serverDir(serverId), 'logs', 'neurax-console.log'); }
  } finally {
    try { store.deleteServer(id); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
