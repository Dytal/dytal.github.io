// game.js — real Minecraft launch engine.
// Vanilla/old versions: Mojang JSON via MCLC. Fabric/Quilt: profile JSONs from meta APIs.
// Forge/NeoForge: official installers run headless (--installClient), then MCLC launch with a
// fully-merged (inheritsFrom-resolved) version JSON.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DIRS } = require('./paths');
const store = require('./store');
const settingsMod = require('./settings');
const versions = require('./versions');
const javaEngine = require('./java');
const auth = require('./auth');
const logger = require('./logger');
const nxInject = require('./nx-inject'); // v1.0: PURGES any pack the launcher ever injected — injection is gone
const nxCloud = require('./nx-cloud');
const crashDoctor = require('./crash-doctor');

let userStopRequested = false; // set by stopGame() so a STOP never counts as a crash

let broadcast = () => {}; // set by main: (channel, payload) => void
function setBroadcaster(fn) { broadcast = fn; }

function emitProgress(type, task, total) { broadcast('launch:progress', { type, task, total }); }
function emitState(state, extra = {}) { broadcast('launch:state', { state, ...extra }); }

/** Deep-merge a child version JSON (inheritsFrom) with its Mojang parent. */
function mergeVersionJson(child, parent) {
  const merged = JSON.parse(JSON.stringify(parent));
  for (const [k, v] of Object.entries(child)) {
    if (k === 'inheritsFrom') continue;
    if (k === 'libraries') {
      merged.libraries = [...(parent.libraries || []), ...(v || [])];
    } else if (k === 'arguments') {
      merged.arguments = {
        game: [...((parent.arguments || {}).game || []), ...((v || {}).game || [])],
        jvm: [...((parent.arguments || {}).jvm || []), ...((v || {}).jvm || [])],
      };
    } else if (k === 'minecraftArguments') {
      merged.minecraftArguments = v; // child overrides
    } else {
      merged[k] = v;
    }
  }
  delete merged.inheritsFrom;
  return merged;
}

/** If a version JSON declares inheritsFrom, bake it into a self-contained JSON. */
async function flattenVersion(root, versionId) {
  const dir = path.join(root, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (!fs.existsSync(file)) return null;
  let json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.inheritsFrom) {
    const parent = await versions.getVersionJson(json.inheritsFrom);
    json = mergeVersionJson(json, parent);
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
    logger.game.info(`Flattened ${versionId} (inheritsFrom ${parent.id})`);
  }
  return json;
}

/**
 * Prepare loader metadata + merged JSON in the shared global root.
 * Returns { customId, forgeInstallerPath|null } ready for MCLC.
 */
async function prepareLoader({ loader, mcVersion, loaderVersion }) {
  const root = DIRS.minecraft; // shared versions root
  if (loader === 'vanilla' || !loader) return { customId: mcVersion, forgeInstallerPath: null };

  if (loader === 'fabric') {
    const lv = loaderVersion || (await versions.getFabricLoaderVersions(mcVersion))[0]?.loader;
    if (!lv) throw new Error(`No Fabric loader found for ${mcVersion}`);
    const id = await versions.installFabricClient(root, mcVersion, lv);
    return { customId: id, forgeInstallerPath: null };
  }

  if (loader === 'quilt') {
    const lv = loaderVersion || (await versions.getQuiltLoaderVersions(mcVersion))[0]?.loader;
    if (!lv) throw new Error(`No Quilt loader found for ${mcVersion}`);
    const id = await versions.installQuiltClient(root, mcVersion, lv);
    return { customId: id, forgeInstallerPath: null };
  }

  if (loader === 'forge' || loader === 'neoforge') {
    const id = loader === 'forge' ? `${mcVersion}-forge-${loaderVersion}` : `neoforge-${loaderVersion}`;
    const already = fs.existsSync(path.join(root, 'versions', id, `${id}.json`));
    let installerPath = null;
    if (!already) {
      let dl;
      if (loader === 'forge') {
        dl = await versions.downloadForgeInstaller(root, mcVersion, loaderVersion, (r, t) => emitProgress('forge-installer', r, t));
      } else {
        dl = await versions.downloadNeoForgeInstaller(root, mcVersion, loaderVersion, (r, t) => emitProgress('neoforge-installer', r, t));
      }
      installerPath = dl.installerPath;
      const major = Math.max(17, javaEngine.javaMajorFor(mcVersion));
      emitState('installing-loader', { loader, version: loaderVersion });
      logger.game.info(`Running ${loader} installer (${mcVersion}) with Java ${major}...`);
      const { path: jPath } = await javaEngine.ensureJava(major);
      const outDir = DIRS.minecraft;
      await new Promise((resolve, reject) => {
        execFile(jPath, ['-jar', installerPath, '--installClient', outDir], {
          windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, cwd: path.dirname(installerPath),
        }, (err, stdout, stderr) => {
          if (err) {
            logger.game.error(`${loader} installer failed: ${err.message}\n${String(stderr).slice(-2000)}`);
            return reject(new Error(`${loader} installer failed — see launcher logs.`));
          }
          logger.game.info(`${loader} installer finished.`);
          resolve();
        });
      });
    }
    await flattenVersion(DIRS.minecraft, id);
    return { customId: id, forgeInstallerPath: null };
  }

  throw new Error(`Unsupported loader: ${loader}`);
}

/** Decode a JWT payload (base64url) without verifying — for claim extraction. */
function decodeJwtPayload(jwt) {
  try {
    if (typeof jwt !== 'string' || jwt.split('.').length !== 3) return null;
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

/** Authorisation object for MCLC.
 *  v4.6: modern version JSONs carry --clientId ${clientid} / --xuid ${auth_xuid}.
 *  MCLC replaces unknown meta fields with the ACCESS TOKEN itself, which used
 *  to leak the whole account JWT into those two flags. Parse the real claims
 *  from the token instead (xuid = decimal Xbox id, aid = the MSA app id). */
function authForMCLC(account) {
  const meta = { type: account.type === 'msa' ? 'msa' : 'offline' };
  const claims = decodeJwtPayload(account.accessToken);
  if (claims && claims.xuid) meta.xuid = String(claims.xuid);
  if (claims && claims.aid) {
    // aid is a GUID ("00000000-…-0000402b5328") → the well-known compact form
    meta.clientId = String(claims.aid).replace(/-/g, '').slice(-16);
  }
  return {
    access_token: account.accessToken || '0',
    uuid: account.uuid,
    name: account.name,
    meta,
    user_properties: '{}',
  };
}

/* ============================================================ v4.4 CLOSE-ON-LAUNCH
   "Close launcher on launch" — when the checkbox is on, Neurax QUITS the
   moment Minecraft is running (the window, Electron, Chromium, the GPU
   context — EVERYTHING is freed for the game) and a tiny watchdog reopens
   the launcher when Minecraft exits.

   Zero-footprint watchdog: a hidden cmd.exe (~4 MB RAM, ~0% CPU, no window,
   no GPU) polls the game PID with `tasklist` every 3 s and `start`s the
   launcher exe as soon as the PID disappears. It lives in %TEMP%, touches
   nothing inside .neurax and deletes itself afterwards. The Minecraft
   process is independent of the launcher, so the game is never disturbed. */

/** Pure script builder (exported for probes). Locale-safe: tasklist sets
 *  errorlevel 1 when the PID is gone; `ping -n 4 127.0.0.1` is the delay
 *  that works even with stdin closed (timeout.exe would abort). */
function buildWatchdogScript({ pid, exe, args = [] }) {
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  const startCmd = ['start', '"Neurax Launcher"', q(exe), ...args.map(q)].join(' ');
  return [
    '@echo off',
    'rem Neurax Launcher watchdog — waits for Minecraft to exit, then reopens the launcher.',
    'rem This file self-deletes. It uses ~4 MB of RAM and no CPU/GPU while waiting.',
    ':wait',
    `tasklist /FI "PID eq ${pid}" >nul 2>&1`,
    'if not errorlevel 1 (',
    '  ping -n 4 127.0.0.1 >nul',
    '  goto wait',
    ')',
    startCmd,
    `del "%~f0"`,
    '',
  ].join('\r\n');
}

/** Spawn the detached watchdog for a running game PID (Windows; other
 *  platforms get a sh loop with the same behaviour). */
function armWatchdog(pid) {
  try {
    const { app } = require('electron');
    const exe = process.execPath;
    let args = [];
    if (!app.isPackaged) args = [app.getAppPath()]; // dev: relaunch electron with the project path
    const { spawn } = require('child_process');
    if (process.platform === 'win32') {
      const script = path.join(os.tmpdir(), `neurax-watchdog-${Date.now()}.cmd`);
      fs.writeFileSync(script, buildWatchdogScript({ pid, exe, args }), 'utf8');
      const child = spawn('cmd.exe', ['/c', script], { detached: true, windowsHide: true, stdio: 'ignore' });
      child.unref();
    } else {
      const script = path.join(os.tmpdir(), `neurax-watchdog-${Date.now()}.sh`);
      const start = process.platform === 'darwin' ? `open -a "${exe}"` : `"${exe}" ${args.map((a) => `"${a}"`).join(' ')}`;
      fs.writeFileSync(script, `#!/bin/sh\nwhile kill -0 ${pid} 2>/dev/null; do sleep 3; done\n${start} >/dev/null 2>&1 &\nrm -f "$0"\n`, 'utf8');
      try { fs.chmodSync(script, 0o755); } catch {}
      const child = spawn('sh', [script], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    logger.game.info(`Watchdog armed — the launcher reopens automatically when Minecraft (pid ${pid}) exits.`);
    return true;
  } catch (e) {
    logger.game.warn('Watchdog could not be armed: ' + e.message);
    return false;
  }
}

/** Quit the launcher once the game is confirmed stable (see STABILITY WINDOW).
 *  The renderer gets the 'handoff' state first so it can show the success copy. */
function scheduleLauncherExit(reason) {
  logger.game.info(`Closing the launcher (${reason}) — Minecraft keeps running with every resource to itself.`);
  emitState('handoff', { reason });
  setTimeout(() => {
    try {
      const { app } = require('electron');
      app.quit();
    } catch { /* non-Electron context (probes) — nothing to close */ }
  }, 2200);
}

/* ============================================================ v1.0 STABILITY WINDOW
   THE close-on-launch FIX. The old flow quit the launcher 2.2 s after the Java
   process was SPAWNED — long before the Minecraft window was actually up. On
   machines where the game then died during startup (old GPU drivers), the
   player saw exactly one thing: the launcher closed and no game ever appeared.

   New flow — the game MUST prove itself first:
     spawn → STABILIZE_MS alive continuously → arm the watchdog → quit launcher
     died during the window → launcher NEVER closes, the normal crash banner
     (crash doctor, safe relaunch) appears instead.
   Pure parts are exported for probes. */

const STABILIZE_MS = 12000;   // the game must stay alive this long before the launcher quits
const STABILIZE_POLL_MS = 500;

/** Pure decision helper (probes): should the launcher quit now?
 *  aliveMs — how long the process has been alive continuously. */
function closeOnLaunchReady(aliveMs) { return aliveMs >= STABILIZE_MS; }

/** Watch a freshly spawned game process; when it has stayed alive for the
 *  whole stability window, arm the watchdog and quit the launcher. If the
 *  game dies inside the window the watcher simply stops — the regular
 *  'close' handler reports the crash and the launcher STAYS OPEN. */
function watchStabilityAndHandoff(proc, { onQuit }) {
  const startedAt = Date.now();
  let done = false;
  const finish = (why) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (why === 'stable') onQuit();
    else logger.game.info(`Close-on-launch cancelled: Minecraft ${why === 'exited' ? 'exited during startup' : 'watch aborted'} — the launcher stays open.`);
  };
  const timer = setInterval(() => {
    try {
      if (proc.exitCode !== null || proc.signalCode !== null) return finish('exited');
      proc.kill(0); // liveness probe — throws if the PID is gone
    } catch {
      return finish('exited');
    }
    const aliveMs = Date.now() - startedAt;
    emitState('stabilizing', { aliveMs, remainMs: Math.max(0, STABILIZE_MS - aliveMs) });
    if (closeOnLaunchReady(aliveMs)) finish('stable');
  }, STABILIZE_POLL_MS);
  try { if (timer.unref) timer.unref(); } catch { /* keep a strong ref — fine */ }
  return () => finish('aborted');
}

let activeLaunch = null; // single-flight guard

/**
 * Launch Minecraft.
 * opts: { instanceId?, versionId?, username? } — instance wins over raw version.
 * The guard is claimed IMMEDIATELY: a second PLAY click while Java/runtime setup
 * is still running must never start a second parallel launch (that used to
 * double-download the Java runtime and collide on temp files → EPERM).
 */
async function launchGame(opts = {}) {
  if (activeLaunch) throw new Error('A game is already starting. Wait for it to launch or exit.');
  activeLaunch = 'starting';
  try {
    const r = await launchGameInner(opts);
    if (!r || !r.pid) activeLaunch = null; // no real process — release the guard
    return r;
  } catch (e) {
    activeLaunch = null;
    throw e;
  }
}

async function launchGameInner(opts = {}) {
  const set = settingsMod.get();
  const account = await auth.currentAccount();
  const instance = opts.instanceId ? store.getInstance(opts.instanceId) : null;

  const mcVersion = instance ? instance.version : (opts.versionId || set.selectedVersion || 'latest-release');
  const loader = instance ? (instance.loader || 'vanilla') : 'vanilla';
  const loaderVersion = instance ? instance.loaderVersion : null;

  // "latest-release" resolution
  let versionNum = mcVersion;
  if (versionNum === 'latest-release' || !versionNum) {
    const m = await versions.getMojangManifest();
    versionNum = m.latest.release;
  }

  emitState('starting', { instance: instance ? instance.name : null, version: versionNum, loader });
  logger.game.info(`Launch requested: ${instance ? `instance "${instance.name}"` : 'vanilla'} ${versionNum}${loader !== 'vanilla' ? ' + ' + loader : ''}`);

  // Java
  const javaMajor = javaEngine.javaMajorFor(versionNum);
  emitState('checking-java', { javaMajor });
  const java = await javaEngine.ensureJava(javaMajor, {
    onProgress: (r, t) => emitProgress('java-download', r, t),
    overridePath: set.javaPathOverride || '',
  });
  const srcLabel = java.downloaded ? 'auto-installed once, saved for reuse'
    : java.source === 'system' ? 'system install — no download'
    : java.source === 'override' ? 'set in Settings'
    : 'saved runtime — no download';
  logger.game.info(`Using Java ${java.major || javaMajor}: ${java.path} (${srcLabel})`);

  // Loader prep (fabric/quilt/forge/neoforge)
  const prepared = await prepareLoader({ loader, mcVersion: versionNum, loaderVersion });
  const customId = prepared.customId;

  // Memory — v1.0 AUTO by default: the heap is picked FOR THIS PC at every
  // launch (total RAM × GPU-class factor), so a 16 GB laptop with an
  // integrated GPU gets a safe ~9.8 GB while a 64 GB rig with a dedicated
  // card gets up to ~48 GB — nobody is stuck with a hardcoded number.
  // Integrated GPUs SHARE system RAM with Windows, so the cap always leaves
  // the driver's share free (that was the access-violation crash cause).
  const totalMB = Math.floor(require('os').totalmem() / 1024 / 1024);
  let gpus = [];
  try { gpus = await crashDoctor.detectGpus(); } catch { gpus = []; }
  const memCap = crashDoctor.classifyMemoryCap({ totalMB, gpus });
  let memMB;
  const memAuto = set.memoryAuto !== false && !(instance && instance.memoryMB);
  if (memAuto) {
    memMB = memCap;
    logger.game.info(`Memory AUTO: ${memMB}MB — ${totalMB}MB RAM, ${gpus.length ? gpus.map((g) => g.type).join(' + ') + ' GPU' : 'unknown GPU'} (safe cap for this machine).`);
  } else {
    memMB = instance?.memoryMB || set.memoryMB || 2048;
  }
  const maxMB = Math.max(1024, Math.min(memMB, memCap, totalMB - 1024));
  if (maxMB < memMB) {
    logger.game.warn(`Memory clamped ${memMB}MB → ${maxMB}MB — ${crashDoctor.memoryClampReason(gpus)}. Lower it any time in Settings if you want.`);
  }

  // Game directory: instances keep saves/configs locally, assets/libs shared globally
  const gameDir = instance ? store.instanceGameDir(instance.id) : DIRS.minecraft;

  // v1.0 RESOURCE-PACK INJECTION REMOVED (owner request): every game dir the
  // launcher ever touched is silently CLEANED — the injected NX-UI pack, its
  // marker and its options.txt entry are removed once, then never return.
  try { nxInject.purgeInjectedPack(gameDir); } catch {}

  // v1.0 crash-avoidance flags for modern JDKs (restricted-method warnings in
  // the Java 21/23/25 era, native access needed by LWJGL 3.4.x)
  const jvmFlags = crashDoctor.compatJvmFlags(java.major || javaMajor);

  // v1.0 NEURAX CLIENT: resolve the optimization stack (Sodium, Lithium, Iris,
  // C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton, Dynamic FPS +
  // the bundled NX core) for Fabric/Quilt launches, plus tuned-G1GC perf flags.
  // Cached 7 days, sha1-verified, never blocks a launch. Instance-managed
  // stacks (mods already in <gameDir>/mods) skip the command-line injection.
  // Vanilla/Forge launches just purge any legacy injected resource packs.
  let clientPrep = null;
  try {
    const client = require('./client');
    clientPrep = await client.prepareLaunch({
      gameDir,
      gameVersion: versionNum,
      loader,
      instanceManaged: !!(instance && client.hasManagedMods(instance)),
      onProgress: (done, total, name) => emitProgress('client-mods', done, total),
    });
    if (clientPrep && clientPrep.mods.length) {
      logger.game.info(`Neurax Client: ${clientPrep.mods.length} optimization mod(s) injected (${clientPrep.mods.map((m) => m.name).join(', ')}).`);
    }
  } catch (e) { logger.game.warn('Neurax Client skipped: ' + e.message); }

  // v4.6 AUTO SAFE MODE: when recent launches kept crashing, run this one
  // 100% vanilla — every resource pack is quarantined (reversible) so a bad
  // pack or a driver choking on pack textures can never repeat the crash.
  let safeModeInfo = null;
  try {
    const armed = crashDoctor.consumeSafeMode();
    if (armed) {
      safeModeInfo = crashDoctor.prepareSafeMode(gameDir);
      logger.game.warn(`SAFE MODE active (${armed.reason || 'repeated crashes'}) — quarantined ${safeModeInfo.moved.length} resource pack(s). They return automatically after 10 clean minutes, or via Settings → Diagnostics → Restore packs.`);
    }
  } catch (e) { logger.game.warn('Safe-mode prep skipped: ' + e.message); }

  const { Client } = require('minecraft-launcher-core');
  const launcher = new Client();
  launcher.on('debug', (m) => logger.game.debug(String(m).replace(/\[MCLC\]:\s?/, '')));
  launcher.on('data', (m) => logger.game.info(String(m).trim()));
  launcher.on('progress', (p) => emitProgress(p.type || 'download', p.task || 0, p.total || 0));
  launcher.on('download-status', (s) => { if (s && s.name) logger.game.debug(`downloading ${s.name}`); });
  launcher.on('arguments', (args) => logger.game.debug(`launch args: ${args.length} tokens`));
  let launchedAt = 0; // set once the process is really running (uptime for crash history)
  launcher.on('close', (code) => {
    // v4.6 crash intelligence: map the exit code to a human cause, read the
    // game's own crash report, remember it, and auto-arm safe mode when the
    // same launch keeps dying.
    const crash = crashDoctor.describeExit(code);
    const stopped = userStopRequested;
    userStopRequested = false;
    let crashInfo = null;
    try {
      if (crash.crashed && !stopped && launchedAt) {
        const uptimeSec = Math.round((Date.now() - launchedAt) / 1000);
        const rep = crashDoctor.findLatestCrashReport(gameDir, launchedAt - 5000);
        const summary = rep ? crashDoctor.summarizeCrashReport(rep.text) : null;
        crashDoctor.recordCrash({
          code: crash.code, gameDir, version: versionNum, uptimeSec,
          summary, reportFile: rep ? rep.file : null,
        });
        if (crashDoctor.shouldAutoSafeMode(crashDoctor.history())) {
          crashDoctor.armSafeMode('repeated Minecraft crashes');
        }
        crashInfo = { ...crash, uptimeSec, summary, reportFile: rep ? rep.file : null };
      }
    } catch (e) {
      logger.game.warn('Crash bookkeeping failed: ' + e.message);
    }
    if (crash.crashed && !stopped) {
      logger.game.warn(`Minecraft crashed — ${crash.title} (${crash.hex})`);
      if (crash.detail) logger.game.warn(crash.detail);
    } else {
      logger.game.info(`Minecraft exited with code ${code}`);
    }
    emitState('exited', { code, crash: crashInfo });
    activeLaunch = null;
    nxCloud.setGameRunning(false);
    require('./perf').setGameRunning(false);
    if (instance) store.updateInstance(instance.id, { lastPlayed: Date.now() });
  });

  // Window: when fullscreen play is requested we launch at the CURRENT desktop
  // resolution instead of a fixed 1280x720. Switching to a non-native resolution
  // makes Windows change the display mode / DPI — that is exactly what shrunk
  // every maximized window while the game was starting. Native res = no mode
  // switch = other windows keep their size.
  let winW = set.gameWidth || 1280;
  let winH = set.gameHeight || 720;
  let winFullscreen = !!set.playFullscreen;
  try {
    if (winFullscreen) {
      const { screen } = require('electron');
      const d = screen.getPrimaryDisplay();
      winW = d.bounds.width; winH = d.bounds.height;
    }
  } catch { /* screen unavailable (headless tests) — keep settings values */ }

  const launchOpts = {
    authorization: authForMCLC(account),
    root: DIRS.minecraft, // shared versions/libraries/assets
    version: {
      number: versionNum,
      type: loader === 'vanilla' ? (versionNum.includes('w') ? 'snapshot' : 'release') : 'release',
      custom: loader === 'vanilla' ? undefined : customId,
    },
    memory: { max: `${maxMB}M`, min: `${Math.min(512, maxMB)}M` },
    javaPath: java.path,
    window: { width: winW, height: winH, fullscreen: winFullscreen },
    overrides: {
      gameDirectory: gameDir,
      detached: false,
      cwd: gameDir,
    },
    // JVM-side crash-avoidance flags + Neurax Client perf flags + fabric.addMods
    customArgs: [
      ...jvmFlags,
      ...((clientPrep && clientPrep.customArgs) || []),
      ...((clientPrep && clientPrep.addModsArg) ? [clientPrep.addModsArg] : []),
    ],
    timeout: 60000,
  };

  logger.game.info(`Launching ${loader === 'vanilla' ? versionNum : customId} | memory ${maxMB}MB | dir ${gameDir}`);
  emitState('downloading-game', {});
  nxCloud.setGameRunning(true);
  require('./perf').setGameRunning(true);
  try {
    const proc = await launcher.launch(launchOpts);
    activeLaunch = proc || null;
    if (instance) store.updateInstance(instance.id, { lastPlayed: Date.now() });
    emitState('running', { pid: proc ? proc.pid : null, instance: instance?.name, version: versionNum });

    // v1.0 behaviour flag (checked AFTER a confirmed running game):
    //   closeLauncherOnLaunch → STABILITY WINDOW first: the launcher only quits
    //     once Minecraft has stayed alive 12 s — a game that dies during
    //     startup can NEVER leave the player with a closed launcher and no
    //     game. After the window: watchdog armed → quit (zero footprint), and
    //     the watchdog brings the launcher back the moment the game exits.
    //     (v1.0-R2 — the old keep-open toggle was REMOVED; this is the only
    //     launch-behaviour switch.)
    if (proc && proc.pid) {
      launchedAt = Date.now();
      if (safeModeInfo) {
        // this launch survived startup in safe mode → restore packs if it stays alive
        crashDoctor.armAutoRestore(gameDir);
      }
      if (set.closeLauncherOnLaunch) {
        emitState('stabilizing', { aliveMs: 0, remainMs: 12000 });
        watchStabilityAndHandoff(proc, {
          onQuit: () => {
            armWatchdog(proc.pid);
            scheduleLauncherExit('close-on-launch');
          },
        });
      }
    }

    return { ok: true, pid: proc ? proc.pid : null, account: { name: account.name, type: account.type } };
  } catch (e) {
    activeLaunch = null;
    emitState('failed', { message: e.message });
    logger.game.error('Launch failed: ' + e.message);
    throw e;
  }
}

function isLaunching() { return !!activeLaunch; }

/**
 * Kill the running Minecraft process (STOP button on the dashboard).
 * The 'close' listener above fires afterwards → emits launch:state 'exited',
 * which returns the engine to idle exactly like a natural game exit.
 */
function stopGame() {
  if (!activeLaunch) return { stopped: false, reason: 'No game is currently running or starting.' };
  if (activeLaunch === 'starting') return { stopped: false, reason: 'The game is still preparing (Java/loader setup) — try again in a moment.' };
  try {
    userStopRequested = true; // a deliberate STOP must never be recorded as a crash
    activeLaunch.kill();
    logger.game.info('Stop requested by user — killed Minecraft process.');
    return { stopped: true };
  } catch (e) {
    logger.game.error('Failed to stop Minecraft: ' + e.message);
    return { stopped: false, reason: e.message };
  }
}

module.exports = { launchGame, prepareLoader, mergeVersionJson, flattenVersion, isLaunching, stopGame, setBroadcaster, buildWatchdogScript, decodeJwtPayload, authForMCLC, closeOnLaunchReady, watchStabilityAndHandoff, STABILIZE_MS };
