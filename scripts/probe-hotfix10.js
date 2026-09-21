// probe-hotfix10.js — REAL end-to-end Fabric server install through the engine,
// reproducing the user's exact scenario: "create a fabric server for MC 26.1.2".
// Previously: HTTP 404 (installer version used as loader version + dead /server/jar endpoint).
// Now: fabric installer CLI flow. Asserts the real files land in the server dir.
// Optional real boot: BOOT=1 env → also starts the server and waits for "Done".
'use strict';
const fs = require('fs');
const path = require('path');

const store = require('../src/main/core/store');
const servers = require('../src/main/core/servers');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
};

async function main() {
  console.log('probe-hotfix10 — REAL fabric 26.1.2 server install');
  const events = [];
  servers.setBroadcaster((ch, payload) => { if (ch === 'server:event') events.push(payload); });

  const srv = store.createServer({ name: 'Probe10 Fabric', type: 'fabric', version: '26.1.2', port: 25597, memoryMB: 2048, motd: 'probe' });
  const id = srv.id;
  const dir = store.serverDir(id);
  try {
    // mirror the UI flow exactly: engine start triggers auto-install if needed
    let installFailed = null;
    try {
      await servers.startServer(store.getServer(id)); // startServer auto-installs when no jar
    } catch (e) { installFailed = e; }
    if (installFailed) {
      // some paths throw before auto-install completes — fall back to explicit install
      console.log(`  (start-with-install threw: ${installFailed.message} — running explicit installServer)`);
      await servers.installServer(store.getServer(id));
    }

    const after = store.getServer(id);
    const launchJar = path.join(dir, 'fabric-server-launch.jar');
    const mojangJar = path.join(dir, 'server.jar');
    check('fabric-server-launch.jar exists (launch jar generated)', fs.existsSync(launchJar));
    check('real Mojang server.jar downloaded (~60 MB)', fs.existsSync(mojangJar) && fs.statSync(mojangJar).size > 50 * 1024 * 1024,
      fs.existsSync(mojangJar) ? `${(fs.statSync(mojangJar).size / 1048576).toFixed(1)} MB` : 'missing');
    check('server marked installed with correct jarFile', !!after.installed && after.jarFile === 'fabric-server-launch.jar', JSON.stringify({ installed: after.installed, jarFile: after.jarFile }));
    check('libraries/ downloaded by installer', fs.existsSync(path.join(dir, 'libraries', 'net', 'fabricmc')));
    check('eula accepted', fs.existsSync(path.join(dir, 'eula.txt')) && /eula=true/.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8')));
    check('no installer jar left in the server dir', !fs.existsSync(path.join(dir, 'fabric-installer.jar')));
    const log = servers.getLog(id);
    check('install progress went to the live console',
      log.some(l => /Installing fabric 26\.1\.2/.test(l.line)) && log.some(l => /Installed: fabric-server-launch\.jar/.test(l.line)),
      JSON.stringify(log.slice(0, 3)));
    const marker = path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), '.neurax', 'runtimes', 'java-25', '.neurax-ready.json');
    check('Java 25 auto-installed + ready-marker written (tar.gz fix)', fs.existsSync(marker), marker);

    /* optional real boot — the full user experience */
    if (process.env.BOOT === '1' && fs.existsSync(launchJar)) {
      console.log('  BOOT=1 → starting the server for real (waits up to 6 min for "Done")…');
      const started = await servers.startServer(store.getServer(id));
      check('startServer spawned the fabric server process', !!started.pid, JSON.stringify(started));
      const t0 = Date.now();
      let done = false, errLine = null;
      while (Date.now() - t0 < 6 * 60 * 1000) {
        const lines = servers.getLog(id).map(l => l.line);
        if (lines.some(l => /Done \([\d.]+s\)!/.test(l))) { done = true; break; }
        errLine = lines.find(l => /UnsupportedClassVersionError|Exception in thread "main"|has been compiled from a more recent version/.test(l));
        if (errLine) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      check('fabric server reached "Done" (fully booted)', done, errLine ? `boot error: ${errLine}` : 'timed out after 6 min');
      if (done) {
        const stopped = servers.stopServer(id);
        check('graceful stop accepted', stopped === true);
      }
    } else if (!fs.existsSync(launchJar)) {
      console.log('  (BOOT skipped — no launch jar)');
    } else {
      console.log('  (BOOT=1 not set — boot test skipped)');
    }
  } finally {
    try { servers.stopServer(id); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    try { store.deleteServer(id); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('PROBE CRASH:', e); process.exit(1); });
