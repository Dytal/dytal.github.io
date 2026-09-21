#!/usr/bin/env node
// probe-v46.js — headless probes for the v4.6.0 patch (plain Node, no Electron).
//
// Covers the headline changes:
//   1. CRASH DOCTOR — Windows exit codes mapped (0xC0000005 / 0xC0000409 …),
//      crash reports parsed, crash history recorded, auto safe-mode decision.
//   2. AUTO SAFE MODE — packs quarantined + options.txt forced vanilla,
//      persisted arm flag (survives restarts), reversible restore.
//   3. MEMORY CLAMP — integrated-GPU-aware safe heap caps + JVM compat flags.
//   4. HONEST LAUNCH ARGS — real xuid/clientId claims instead of the JWT.
//   5. CLEAN RESOURCEPACKS — injection marker moved out of resourcepacks/.
//
// Functional tests run in isolated temp homes; static checks read sources.

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  PASS ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${e.message}`); }
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v46-'));
}

/** Run code in a subprocess bound to an isolated NEURAX_HOME. */
function run(code, home) {
  const script = path.join(os.tmpdir(), `nx46-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return execFileSync(process.execPath, [script], {
      env: { ...process.env, NEURAX_HOME: home },
      encoding: 'utf8', timeout: 30000,
    });
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}

(async () => {
  console.log('== v4.6.0 probe suite ==\n');

  /* ---- 1. versions consistent (era-independent) ---- */
  await ok('package.json version matches the top PATCH-NOTES heading', async () => {
    const pkg = require('../package.json');
    assert.ok(read('PATCH-NOTES.md').startsWith('# Neurax Launcher — v' + pkg.version), 'patch notes head matches ' + pkg.version);
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes(`'${pkg.version}-preview'`), 'mock-bridge preview label bumped');
  });

  /* ---- 2. exit code mapping ---- */
  await ok('describeExit: 0xC0000005 access violation → graphics-driver diagnosis', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const d = cd.describeExit(3221225477);
    assert.equal(d.hex, '0xC0000005', 'hex form');
    assert.equal(d.kind, 'access-violation', 'kind');
    assert.equal(d.crashed, true, 'flagged as crash');
    assert.equal(d.driverLikely, true, 'driver-likely flagged');
    assert.ok(d.title.toLowerCase().includes('graphics driver'), 'title names the driver');
    assert.ok(d.detail.toLowerCase().includes('driver'), 'detail names the driver');
  });

  await ok('describeExit: 0xC0000409 fail-fast + signed-code normalisation', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const d = cd.describeExit(3221226505);
    assert.equal(d.hex, '0xC0000409', 'hex form');
    assert.equal(d.kind, 'fail-fast', 'kind');
    assert.equal(d.driverLikely, true, 'driver-likely flagged');
    const signed = cd.describeExit(-1073741819); // 0xC0000005 as int32
    assert.equal(signed.hex, '0xC0000005', 'signed → unsigned');
    const dll = cd.describeExit(3221225794); // 0xC0000142
    assert.equal(dll.kind, 'dll-init-failed', 'DLL init failure mapped');
  });

  await ok('describeExit: clean exits + user stops are NOT crashes', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    assert.equal(cd.describeExit(0).crashed, false, 'code 0');
    assert.equal(cd.describeExit(143).crashed, false, 'SIGTERM');
    assert.equal(cd.describeExit(null).crashed, false, 'null code');
    assert.equal(cd.describeExit('nope').crashed, false, 'garbage code');
  });

  /* ---- 3. crash report parsing ---- */
  await ok('summarizeCrashReport: description + top exception extracted', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const body = [
      '---- Minecraft Crash Report ----',
      '// I let you down. Sorry :(',
      '',
      'Time: 2026-09-21 16:45:26',
      'Description: Rendering overlay',
      '',
      'java.lang.IllegalStateException: Failed to create texture atlas',
      '\tat net.minecraft.client.renderer.TextureAtlas.<init>(TextureAtlas.java:99)',
      '\tat net.minecraft.client.renderer.GameRenderer.m_109099_(GameRenderer.java:123)',
      '',
      'Screen Name: net.minecraft.client.gui.screens.TitleScreen',
    ].join('\n');
    const s = cd.summarizeCrashReport(body);
    assert.ok(s, 'summary produced');
    assert.equal(s.description, 'Rendering overlay', 'description line');
    assert.ok(s.error && s.error.startsWith('java.lang.IllegalStateException'), 'top exception');
    assert.ok(String(s.error).includes('texture atlas'), 'exception text kept');
    assert.equal(s.screen, 'net.minecraft.client.gui.screens.TitleScreen', 'screen name');
    assert.equal(cd.summarizeCrashReport(''), null, 'empty report → null');
  });

  /* ---- 4. memory clamp math ---- */
  await ok('classifyMemoryCap: integrated-GPU machines get the tightest cap', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const igpu = [{ type: 'integrated', name: 'AMD Radeon (TM) Graphics' }];
    const dgpu = [{ type: 'dedicated', name: 'NVIDIA GeForce RTX 4060' }];
    const both = [...igpu, ...dgpu];
    assert.equal(cd.classifyMemoryCap({ totalMB: 16384, gpus: igpu }), 9830, '16 GB integrated-only → 60 % / 4 GB reserve');
    assert.equal(cd.classifyMemoryCap({ totalMB: 16384, gpus: dgpu }), 12288, '16 GB dedicated-only → 75 %');
    assert.equal(cd.classifyMemoryCap({ totalMB: 16384, gpus: both }), 11468, '16 GB hybrid → 70 %');
    assert.equal(cd.classifyMemoryCap({ totalMB: 16384, gpus: [] }), 11468, '16 GB unknown → 70 %');
    assert.equal(cd.classifyMemoryCap({ totalMB: 8192, gpus: igpu }), 4096, '8 GB integrated → reserve dominates');
    assert.equal(cd.classifyMemoryCap({ totalMB: 8192, gpus: dgpu }), 6144, '8 GB dedicated → 75 %');
  });

  await ok('clampMemory + memoryClampReason: 14592 MB → the safe cap, with a human reason', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    assert.equal(cd.clampMemory(14592, 9830), 9830, 'huge request clamped');
    assert.equal(cd.clampMemory(2048, 9830), 2048, 'small request untouched');
    assert.equal(cd.clampMemory(0, 9830), 512, 'floor honoured (0 falls back to 512)');
    assert.ok(cd.memoryClampReason([{ type: 'integrated' }]).includes('share'), 'iGPU reason mentions sharing');
  });

  /* ---- 5. JVM compat flags ---- */
  await ok('compatJvmFlags: native-access for Java 21+, unsafe-access for Java 23+', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    assert.deepEqual(cd.compatJvmFlags(25), ['--enable-native-access=ALL-UNNAMED', '--sun-misc-unsafe-memory-access=allow'], 'Java 25');
    assert.deepEqual(cd.compatJvmFlags(23), ['--enable-native-access=ALL-UNNAMED', '--sun-misc-unsafe-memory-access=allow'], 'Java 23');
    assert.deepEqual(cd.compatJvmFlags(21), ['--enable-native-access=ALL-UNNAMED'], 'Java 21');
    assert.deepEqual(cd.compatJvmFlags(17), [], 'Java 17');
    assert.deepEqual(cd.compatJvmFlags(8), [], 'Java 8');
    assert.deepEqual(cd.compatJvmFlags(undefined), [], 'unknown');
  });

  /* ---- 6. GPU classification ---- */
  await ok('GPU classification: AMD iGPU, NVIDIA dGPU, Intel UHD/Arc handled', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    assert.equal(cd.classifyGpu('AMD Radeon (TM) Graphics'), 'integrated', 'AMD APU');
    assert.equal(cd.classifyGpu('AMD Radeon(TM) 610M'), 'integrated', 'AMD 610M');
    assert.equal(cd.classifyGpu('AMD Radeon RX 7600'), 'dedicated', 'RX dGPU');
    assert.equal(cd.classifyGpu('NVIDIA GeForce RTX 4060 Laptop GPU'), 'dedicated', 'GeForce');
    assert.equal(cd.classifyGpu('Intel(R) UHD Graphics 620'), 'integrated', 'Intel UHD');
    assert.equal(cd.classifyGpu('Intel(R) Iris(R) Xe Graphics'), 'integrated', 'Iris Xe');
    assert.equal(cd.classifyGpu('Intel(R) Arc(TM) A750 Graphics'), 'dedicated', 'Arc dGPU');
    assert.equal(cd.classifyGpu('Intel(R) Arc Graphics'), 'integrated', 'Arc iGPU (no TM)');
  });

  await ok('parseGpuJson / parseWmicCsv: both Windows probe formats parse', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const single = JSON.stringify({ Name: 'AMD Radeon (TM) Graphics', DriverVersion: '23.19.260413' });
    let g = cd.parseGpuJson(single);
    assert.equal(g.length, 1, 'single-object JSON');
    assert.equal(g[0].type, 'integrated', 'classified');
    const multi = JSON.stringify([
      { Name: 'AMD Radeon (TM) Graphics', DriverVersion: '23.19.260413' },
      { Name: 'NVIDIA GeForce RTX 3060', DriverVersion: '566.14' },
    ]);
    g = cd.parseGpuJson(multi);
    assert.equal(g.length, 2, 'array JSON');
    assert.equal(g[1].type, 'dedicated', 'second GPU classified');
    const csv = ['Node,DriverVersion,Name', 'DESKTOP,23.19.260413,AMD Radeon (TM) Graphics', 'DESKTOP,566.14,NVIDIA GeForce RTX 3060'].join('\r\n');
    g = cd.parseWmicCsv(csv);
    assert.equal(g.length, 2, 'wmic csv rows');
    assert.ok(g.some((x) => x.type === 'integrated') && g.some((x) => x.type === 'dedicated'), 'wmic csv classified');
    assert.deepEqual(cd.parseGpuJson('garbage'), [], 'garbage → empty');
  });

  /* ---- 7. crash history + auto safe-mode decision (isolated home) ---- */
  await ok('recordCrash + history + shouldAutoSafeMode: 2 startup crashes arm safe mode', async () => {
    const home = freshHome();
    const out = run(`
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      const histFile = require('fs').existsSync(require('path').join(process.env.NEURAX_HOME, 'cache', 'crash-history.json'));
      assert.ok(!histFile, 'no history yet');
      assert.equal(cd.recordCrash({ code: 0, uptimeSec: 50 }), null, 'clean exit never recorded');
      assert.equal(cd.recordCrash({ code: 3221225477, uptimeSec: null }), null, 'never-started not recorded');
      const e1 = cd.recordCrash({ code: 3221225477, uptimeSec: 20, version: '26.3', summary: { description: 'Rendering overlay' } });
      const e2 = cd.recordCrash({ code: 3221226505, uptimeSec: 33, version: '26.3' });
      assert.ok(e1 && e2, 'both crashes recorded');
      const h = cd.history();
      assert.equal(h.length, 2, 'history has 2 entries');
      assert.equal(h[0].hex, '0xC0000005', 'first entry hex');
      assert.ok(cd.shouldAutoSafeMode(h), '2 startup crashes → arm');
      assert.ok(!cd.shouldAutoSafeMode([h[0]]), '1 crash → no arm');
      const old = Date.now() - 16 * 60 * 1000;
      assert.ok(!cd.shouldAutoSafeMode([{ ts: old, uptimeSec: 10 }, { ts: old, uptimeSec: 12 }]), 'older than 15 min → no arm');
      console.log('SUBOK');
    `, home);
    assert.ok(out.includes('SUBOK'), 'subprocess assertions passed');
  });

  await ok('shouldAutoSafeMode: 3 crashes of any kind within 15 min also arm', async () => {
    const cd = require('../src/main/core/crash-doctor.js');
    const now = Date.now();
    const late = [
      { ts: now - 9 * 60 * 1000, uptimeSec: 600 },
      { ts: now - 6 * 60 * 1000, uptimeSec: 800 },
      { ts: now - 3 * 60 * 1000, uptimeSec: 700 },
    ];
    assert.ok(cd.shouldAutoSafeMode(late, now), '3 late crashes → arm');
    assert.ok(!cd.shouldAutoSafeMode(late.slice(0, 2), now), '2 late crashes → no arm');
  });

  /* ---- 8. safe-mode persistence + pack quarantine/restore ---- */
  await ok('safe-mode arm flag persists across processes (survives relaunches)', async () => {
    const home = freshHome();
    run(`
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      assert.equal(cd.isSafeModeArmed(), false, 'starts disarmed');
      assert.ok(cd.armSafeMode('repeated Minecraft crashes'), 'armed');
      assert.equal(cd.isSafeModeArmed(), true, 'armed visible');
      console.log('ARMED');
    `, home);
    const out2 = run(`
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      assert.equal(cd.isSafeModeArmed(), true, 'still armed in a NEW process');
      const st = cd.consumeSafeMode();
      assert.ok(st && st.armed, 'consume returns the flag');
      assert.equal(cd.isSafeModeArmed(), false, 'disarmed after consume');
      assert.equal(cd.consumeSafeMode(), null, 'second consume → null');
      console.log('CONSUMED');
    `, home);
    assert.ok(out2.includes('CONSUMED'), 'second-process assertions passed');
  });

  await ok('prepareSafeMode/restoreSafeModeBackups: packs quarantined, options.txt forced vanilla, fully reversible', async () => {
    const home = freshHome();
    const out = run(`
      const fs = require('fs');
      const path = require('path');
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      const gameDir = path.join(process.env.NEURAX_HOME, 'global', '.minecraft');
      const rp = path.join(gameDir, 'resourcepacks');
      fs.mkdirSync(rp, { recursive: true });
      fs.writeFileSync(path.join(rp, 'NX-UI-64x.zip'), 'fake-pack');
      fs.writeFileSync(path.join(rp, 'MyPack'), 'fake-dir-pack');
      fs.writeFileSync(path.join(gameDir, 'options.txt'), 'musicCategory:music:0.2\\nresourcePacks:["vanilla","file/NX-UI-64x.zip"]\\nincompatibleResourcePacks:[]\\n');
      const prep = cd.prepareSafeMode(gameDir);
      assert.equal(prep.moved.length, 2, 'both packs quarantined');
      assert.equal(fs.readdirSync(rp).length, 0, 'resourcepacks empty');
      const opts = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
      assert.ok(opts.includes('resourcePacks:["vanilla"]'), 'resourcePacks forced vanilla');
      assert.ok(opts.includes('incompatibleResourcePacks:["vanilla"]'), 'incompatible list forced too');
      assert.ok(fs.existsSync(path.join(gameDir, cd.SAFE_MODE_DIRNAME)), 'backup root exists');
      const res = cd.restoreSafeModeBackups(gameDir);
      assert.equal(res.restored, 2, 'both packs restored');
      assert.ok(fs.existsSync(path.join(rp, 'NX-UI-64x.zip')), 'pack file back');
      assert.ok(!fs.existsSync(path.join(gameDir, cd.SAFE_MODE_DIRNAME)), 'backup root cleaned');
      // second prepare with nothing to move must not leave an empty backup tree
      const prep2 = cd.prepareSafeMode(gameDir);
      assert.equal(prep2.moved.length, 2, 're-quarantine works (packs back in rp)');
      cd.restoreSafeModeBackups(gameDir);
      console.log('SAFEOK');
    `, home);
    assert.ok(out.includes('SAFEOK'), 'subprocess assertions passed');
  });

  await ok('restoreSafeModeBackups: duplicates are dropped, real packs never overwritten', async () => {
    const home = freshHome();
    const out = run(`
      const fs = require('fs');
      const path = require('path');
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      const gameDir = path.join(process.env.NEURAX_HOME, 'global', '.minecraft');
      const rp = path.join(gameDir, 'resourcepacks');
      fs.mkdirSync(rp, { recursive: true });
      fs.writeFileSync(path.join(rp, 'PackA.zip'), 'new');
      fs.mkdirSync(path.join(gameDir, cd.SAFE_MODE_DIRNAME, 't'), { recursive: true });
      fs.writeFileSync(path.join(gameDir, cd.SAFE_MODE_DIRNAME, 't', 'PackA.zip'), 'old');
      fs.writeFileSync(path.join(gameDir, cd.SAFE_MODE_DIRNAME, 't', 'PackB.zip'), 'old');
      const res = cd.restoreSafeModeBackups(gameDir);
      assert.equal(res.restored, 1, 'only the missing pack restored');
      assert.deepEqual(res.removed, ['PackA.zip'], 'duplicate dropped');
      assert.equal(fs.readFileSync(path.join(rp, 'PackA.zip'), 'utf8'), 'new', 'existing pack untouched');
      console.log('DUP-OK');
    `, home);
    assert.ok(out.includes('DUP-OK'), 'subprocess assertions passed');
  });

  /* ---- 9. honest launch arguments ---- */
  await ok('authForMCLC: real xuid/clientId claims instead of the access-token JWT', async () => {
    const out = run(`
      const game = require('${ROOT}/src/main/core/game.js');
      const assert = require('assert');
      const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      const jwt = [b64u({ alg: 'RS256' }), b64u({ xuid: '2535450905914543', aid: '00000000-0000-0000-0000-0000402b5328', sub: 'abc' }), 'sig'].join('.');
      const auth = game.authForMCLC({ accessToken: jwt, uuid: 'u', name: 'Dytalmc', type: 'msa' });
      assert.equal(auth.meta.type, 'msa', 'meta type kept');
      assert.equal(auth.meta.xuid, '2535450905914543', 'numeric xuid parsed');
      assert.equal(auth.meta.clientId, '00000000402b5328', 'dashes stripped from aid');
      assert.equal(auth.access_token, jwt, 'access token untouched');
      const noTok = game.authForMCLC({ accessToken: '0', uuid: 'u', name: 'Off', type: 'offline' });
      assert.ok(!noTok.meta.xuid && !noTok.meta.clientId, 'offline accounts carry no fake ids');
      assert.equal(game.decodeJwtPayload('garbage'), null, 'garbage JWT → null');
      console.log('JWT-OK');
    `, freshHome());
    assert.ok(out.includes('JWT-OK'), 'subprocess assertions passed');
  });

  /* ---- 10. v1.0: injection REMOVED — purge semantics ---- */
  await ok('nx-inject: injection gone; purge removes pack + markers + options entry, keeps user packs', async () => {
    const home = freshHome();
    const out = run(`
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const nxInject = require('${ROOT}/src/main/core/nx-inject.js');
      const assert = require('assert');
      assert.ok(typeof nxInject.injectGameDir !== 'function', 'injectGameDir removed');
      assert.ok(typeof nxInject.purgeInjectedPack === 'function', 'purge exists');
      const gameDir = path.join(process.env.NEURAX_HOME, 'global', '.minecraft');
      fs.mkdirSync(path.join(gameDir, 'resourcepacks'), { recursive: true });
      fs.writeFileSync(path.join(gameDir, 'resourcepacks', 'NX-UI-64x.zip'), 'old injected pack');
      fs.writeFileSync(path.join(gameDir, 'resourcepacks', 'my-own-pack.zip'), 'user pack');
      fs.writeFileSync(path.join(gameDir, '.nx-injected-v3'), 'marker');
      fs.writeFileSync(path.join(gameDir, 'resourcepacks', '.nx-injected-v2'), 'legacy marker');
      fs.writeFileSync(path.join(gameDir, 'options.txt'), 'resourcePacks:["vanilla","file/NX-UI-64x.zip","file/my-own-pack.zip"]');
      const r = nxInject.purgeInjectedPack(gameDir);
      assert.ok(r.removedPack && r.removedMarker && r.cleanedOptions, 'pack + markers + options cleaned');
      assert.ok(!fs.existsSync(path.join(gameDir, 'resourcepacks', 'NX-UI-64x.zip')), 'injected pack gone');
      assert.ok(!fs.existsSync(path.join(gameDir, '.nx-injected-v3')), 'marker gone');
      assert.ok(!fs.existsSync(path.join(gameDir, 'resourcepacks', '.nx-injected-v2')), 'legacy marker gone');
      assert.ok(fs.existsSync(path.join(gameDir, 'resourcepacks', 'my-own-pack.zip')), 'user pack untouched');
      const opts = fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8');
      assert.ok(opts.includes('file/my-own-pack.zip') && !opts.includes('NX-UI-64x'), 'options keeps user pack only');
      const r2 = nxInject.purgeInjectedPack(gameDir); // idempotent
      assert.ok(!r2.removedPack && !r2.cleanedOptions, 'second purge is a no-op');
      console.log('PURGE-OK');
    `, home);
    assert.ok(out.includes('PURGE-OK'), 'subprocess assertions passed');
  });

  /* ---- 11. static wiring ---- */
  await ok('game.js launch path: clamp + JVM flags + safe-mode consume + crash bookkeeping wired', async () => {
    const src = read('src/main/core/game.js');
    assert.ok(src.includes("require('./crash-doctor')"), 'crash doctor required');
    assert.ok(src.includes('crashDoctor.detectGpus()'), 'GPU detect at launch');
    assert.ok(src.includes('crashDoctor.classifyMemoryCap'), 'memory clamp used');
    assert.ok(src.includes('clientPrep && clientPrep.addModsArg'), 'customArgs include Neurax Client addMods');
    assert.ok(src.includes('watchStabilityAndHandoff'), 'close-on-launch stability window wired');
    assert.ok(src.includes('crashDoctor.consumeSafeMode()'), 'safe mode consumed per launch');
    assert.ok(src.includes('crashDoctor.prepareSafeMode(gameDir)'), 'safe mode applies to the game dir');
    assert.ok(src.includes('crashDoctor.armAutoRestore(gameDir)'), 'auto-restore armed after a safe launch');
    assert.ok(src.includes('crashDoctor.recordCrash('), 'crashes recorded');
    assert.ok(src.includes('crashDoctor.shouldAutoSafeMode'), 'auto-arm decision wired');
    assert.ok(src.includes("emitState('exited', { code, crash: crashInfo })"), 'renderer gets the crash payload');
    assert.ok(src.includes('userStopRequested = true'), 'STOP never counts as a crash');
  });

  await ok('UI wiring: preload channel, IPC handlers, Settings Diagnostics, dashboard SAFE RELAUNCH', async () => {
    assert.ok(read('src/main/preload.js').includes("'launch:notice'"), 'launch:notice whitelisted');
    const ipc = read('src/main/ipc.js');
    assert.ok(ipc.includes("handle('diag:summary'"), 'diag:summary handler');
    assert.ok(ipc.includes("handle('diag:armSafeMode'"), 'diag:armSafeMode handler');
    assert.ok(ipc.includes("handle('diag:restorePacks'"), 'diag:restorePacks handler');
    assert.ok(ipc.includes("handle('app:showFile'"), 'app:showFile handler');
    const settings = read('src/renderer/js/pages/settings.js');
    assert.ok(settings.includes('diag:summary'), 'settings fetches the diagnostics summary');
    assert.ok(settings.includes('Diagnostics'), 'Diagnostics card present');
    assert.ok(settings.includes('diag:restorePacks'), 'Restore packs button');
    assert.ok(settings.includes('safeMemoryCapMB'), 'memory slider uses the safe cap');
    const home = read('src/renderer/js/pages/home.js');
    assert.ok(home.includes('SAFE RELAUNCH'), 'dashboard safe relaunch button');
    assert.ok(home.includes('CRASH REPORT'), 'dashboard crash-report button');
    assert.ok(home.includes('state.game.lastLaunch'), 'last launch remembered for safe relaunch');
    const main = read('src/renderer/js/main.js');
    assert.ok(main.includes('launch:notice'), 'notice toasts wired');
    assert.ok(main.includes('crash: p.crash || null'), 'crash payload stored in state');
    const mock = read('src/renderer/js/mock-bridge.js');
    assert.ok(mock.includes("case 'diag:summary'"), 'mock diag:summary');
    assert.ok(mock.includes("case 'diag:armSafeMode'"), 'mock diag:armSafeMode');
  });

  await ok('diagSummary: shape + safe cap present (isolated home)', async () => {
    const home = freshHome();
    const out = run(`
      const cd = require('${ROOT}/src/main/core/crash-doctor.js');
      const assert = require('assert');
      cd.diagSummary().then((s) => {
        assert.equal(s.platform, process.platform, 'platform');
        assert.ok(Array.isArray(s.gpus), 'gpus array');
        assert.equal(s.hasIntegratedGPU, false, 'no iGPU off-Windows');
        assert.ok(s.safeMemoryCapMB >= 1024, 'safe cap computed');
        assert.equal(s.lastCrash, null, 'no crashes');
        assert.equal(s.crashesRecent, 0, 'zero recent');
        assert.equal(s.safeModeArmed, false, 'not armed');
        console.log('SUMMARY-OK');
      }).catch((e) => { console.error(e); process.exit(1); });
    `, home);
    assert.ok(out.includes('SUMMARY-OK'), 'summary assertions passed');
  });

  console.log(`\\n== v4.6.0 probe: ${pass} PASS, ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
})();
