// game.js — real Minecraft launch engine.
// Vanilla/old versions: Mojang JSON via MCLC. Fabric/Quilt: profile JSONs from meta APIs.
// Forge/NeoForge: official installers run headless (--installClient), then MCLC launch with a
// fully-merged (inheritsFrom-resolved) version JSON.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DIRS } = require('./paths');
const store = require('./store');
const settingsMod = require('./settings');
const versions = require('./versions');
const javaEngine = require('./java');
const auth = require('./auth');
const logger = require('./logger');
const nxInject = require('./nx-inject');
const nxCloud = require('./nx-cloud');

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

/** Authorisation object for MCLC. */
function authForMCLC(account) {
  return {
    access_token: account.accessToken || '0',
    uuid: account.uuid,
    name: account.name,
    meta: { type: account.type === 'msa' ? 'msa' : 'offline' },
    user_properties: '{}',
  };
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

  // Memory
  const memMB = instance?.memoryMB || set.memoryMB || 2048;
  const totalMB = Math.floor(require('os').totalmem() / 1024 / 1024);
  const maxMB = Math.max(1024, Math.min(memMB, totalMB - 1024));

  // Game directory: instances keep saves/configs locally, assets/libs shared globally
  const gameDir = instance ? store.instanceGameDir(instance.id) : DIRS.minecraft;

  // NX-UI 64x pack: make sure this game dir has it (fires also for brand-new instances,
  // so every current AND future instance gets it automatically)
  try { nxInject.injectGameDir(gameDir); } catch {}

  const { Client } = require('minecraft-launcher-core');
  const launcher = new Client();
  launcher.on('debug', (m) => logger.game.debug(String(m).replace(/\[MCLC\]:\s?/, '')));
  launcher.on('data', (m) => logger.game.info(String(m).trim()));
  launcher.on('progress', (p) => emitProgress(p.type || 'download', p.task || 0, p.total || 0));
  launcher.on('download-status', (s) => { if (s && s.name) logger.game.debug(`downloading ${s.name}`); });
  launcher.on('arguments', (args) => logger.game.debug(`launch args: ${args.length} tokens`));
  launcher.on('close', (code) => {
    logger.game.info(`Minecraft exited with code ${code}`);
    emitState('exited', { code });
    activeLaunch = null;
    nxCloud.setGameRunning(false);
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
    timeout: 60000,
  };

  logger.game.info(`Launching ${loader === 'vanilla' ? versionNum : customId} | memory ${maxMB}MB | dir ${gameDir}`);
  emitState('downloading-game', {});
  nxCloud.setGameRunning(true);
  try {
    const proc = await launcher.launch(launchOpts);
    activeLaunch = proc || null;
    if (instance) store.updateInstance(instance.id, { lastPlayed: Date.now() });
    emitState('running', { pid: proc ? proc.pid : null, instance: instance?.name, version: versionNum });
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
    activeLaunch.kill();
    logger.game.info('Stop requested by user — killed Minecraft process.');
    return { stopped: true };
  } catch (e) {
    logger.game.error('Failed to stop Minecraft: ' + e.message);
    return { stopped: false, reason: e.message };
  }
}

module.exports = { launchGame, prepareLoader, mergeVersionJson, flattenVersion, isLaunching, stopGame, setBroadcaster };
