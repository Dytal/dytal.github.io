// servers.js — real local Minecraft server engine.
// Downloads: paper (fill.papermc.io v3), vanilla (mojang), fabric/quilt (meta server jars),
// forge/neoforge (installer --installServer). Spigot: honest BuildTools/manual-jar path.
// Runs: java -jar with live console over IPC (stdin/stdout piping), stop command support.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DIRS } = require('./paths');
const store = require('./store');
const versions = require('./versions');
const javaEngine = require('./java');
const { download, getJSON } = require('./net');
const logger = require('./logger');

let broadcast = () => {};
function setBroadcaster(fn) { broadcast = fn; }

function emit(serverId, event, payload) { broadcast('server:event', { serverId, event, payload }); }

const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

function serverLog(serverId, line, level = 'game') {
  logger.log(level, 'server', `[server-${serverId}] ${line}`);
  pushConsoleLine(serverId, line, level);
}

// ---------------- console history engine ----------------
// The console is OWNED BY THE MAIN PROCESS, not by whichever page happens to be
// mounted. Every line is kept in a memory ring buffer AND appended to
// <serverDir>/logs/neurax-console.log so history survives page navigation (the
// logo round-trip bug) AND full launcher restarts. Pages hydrate from here.

const LOG_CAP = 1000;
const logBuffers = new Map(); // serverId -> [{ line, level, t }]
const startedAt = new Map();  // serverId -> epoch ms

function logFileFor(serverId) {
  return path.join(store.serverDir(serverId), 'logs', 'neurax-console.log');
}

/** Push one console line: ring buffer + disk + broadcast. Never throws. */
function pushConsoleLine(serverId, line, level = 'game') {
  const entry = { line, level, t: Date.now() };
  try {
    const buf = getLog(serverId);
    buf.push(entry);
    if (buf.length > LOG_CAP) buf.splice(0, buf.length - LOG_CAP);
  } catch {}
  try {
    if (store.getServer(serverId)) {
      const file = logFileFor(serverId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    }
  } catch { /* logging must never break the server pipeline */ }
  emit(serverId, 'log', entry);
}

/** Rebuild buffer from the on-disk console log (tail) on first access. */
function hydrateLogFromDisk(serverId) {
  const buf = [];
  try {
    if (!store.getServer(serverId)) return buf;
    const raw = fs.readFileSync(logFileFor(serverId), 'utf8');
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      try { buf.push(JSON.parse(l)); } catch { buf.push({ line: l, level: 'game', t: 0 }); }
    }
  } catch { /* no file yet — fresh server */ }
  return buf.slice(-LOG_CAP);
}

/** Full console history for a server (hydrated from disk when needed). */
function getLog(serverId) {
  if (!logBuffers.has(serverId)) logBuffers.set(serverId, hydrateLogFromDisk(serverId));
  return logBuffers.get(serverId);
}

/** Wipe console history: memory buffer + on-disk log + broadcast to UI. */
function clearLog(serverId) {
  logBuffers.set(serverId, []);
  try { fs.rmSync(logFileFor(serverId), { force: true }); } catch {}
  emit(serverId, 'log-cleared', {});
}

/** Authoritative run-state snapshot: who is running + since when. */
function getRuntime() {
  return { running: [...running.keys()], startedAt: Object.fromEntries(startedAt) };
}

// ---------------- installation ----------------

const PAPER_FILL = 'https://fill.papermc.io/v3';

/** Available Paper versions (for the New Server form). */
async function getPaperVersions() {
  const proj = await getJSON(`${PAPER_FILL}/projects/paper`, { timeout: 20000 });
  const versions = Object.keys(proj.versions || {});
  return { versions: versions.reverse() }; // newest first
}

async function installPaper(dir, mcVersion, onProgress) {
  // find closest paper version to mcVersion
  const proj = await getJSON(`${PAPER_FILL}/projects/paper`, { timeout: 20000 });
  const all = Object.keys(proj.versions || {});
  const match = all.includes(mcVersion) ? mcVersion : all.find(v => v === mcVersion);
  if (!match) throw new Error(`Paper does not support ${mcVersion}`);
  const build = await getJSON(`${PAPER_FILL}/projects/paper/versions/${match}/builds/latest`, { timeout: 20000 });
  const dl = build.downloads['server:default'];
  if (!dl) throw new Error('No Paper build found');
  const dest = path.join(dir, dl.name);
  await download(dl.url, dest, { onProgress });
  return { jar: dl.name, version: match, build: build.id };
}

async function installVanilla(dir, mcVersion, onProgress) {
  const json = await versions.getVersionJson(mcVersion);
  const url = json.downloads && json.downloads.server && json.downloads.server.url;
  if (!url) throw new Error(`No vanilla server jar for ${mcVersion}`);
  const dest = path.join(dir, `server-${mcVersion}.jar`);
  await download(url, dest, { onProgress });
  return { jar: path.basename(dest), version: mcVersion };
}

async function installFabricLike(dir, mcVersion, loader, loaderVersion, onProgress) {
  // Fabric & Quilt no longer serve a bundled "server jar" from their meta
  // (the /server/jar endpoint is gone — HTTP 404 for every game version).
  // The real, supported path is their INSTALLER's server command, which
  // generates fabric-server-launch.jar / quilt-server-launch.jar and downloads
  // the actual Mojang server. Verified live against both APIs.
  const isFabric = loader === 'fabric';
  const meta = isFabric ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';

  // 1. pick the LOADER version for this game version (e.g. fabric-loader 0.19.5).
  //    ⚠ NOT /versions/installer — that returns the installer tool's version
  //    (1.1.2 …) which 404s when used as a loader version. This exact mixup was
  //    the "Installing fabric 26.1.2 … HTTP 404" bug.
  if (!loaderVersion) {
    const profiles = await getJSON(`${meta}/versions/loader/${encodeURIComponent(mcVersion)}`, { timeout: 20000 });
    if (!Array.isArray(profiles) || !profiles.length || !profiles[0].loader) {
      throw new Error(`${cap(loader)} has no loader build for Minecraft ${mcVersion}`);
    }
    loaderVersion = profiles[0].loader.version;
  }

  // 2. latest installer jar (the /versions/installer entry carries the maven URL)
  const installers = await getJSON(`${meta}/versions/installer`, { timeout: 20000 });
  const inst = Array.isArray(installers) ? installers[0] : null;
  if (!inst || !inst.url) throw new Error(`No ${cap(loader)} installer download found`);
  const installerPath = path.join(dir, `${loader}-installer.jar`);
  await download(inst.url, installerPath, { onProgress });

  // 3. run the installer's server command (needs Java; same pattern as forge/neoforge)
  const major = Math.max(17, javaEngine.javaMajorFor(mcVersion));
  const { path: javaBin } = await javaEngine.ensureJava(major); // NOT "path" — would shadow the path module
  serverLogMulti(`Running ${cap(loader)} server installer (MC ${mcVersion}, ${loader} ${loaderVersion}) with Java ${major}...`);
  const args = isFabric
    ? ['-jar', installerPath, 'server', '-mcversion', mcVersion, '-loaderversion', loaderVersion, '-downloadMinecraft', '-dir', dir]
    : ['-jar', installerPath, 'install', 'server', mcVersion, loaderVersion, `--install-dir=${dir}`, '--download-server'];
  await new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(javaBin, args, {
      windowsHide: true, timeout: 25 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, cwd: dir,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cap(loader)} server installer failed: ${String(stderr || stdout).slice(-500)}`));
      resolve();
    });
  });

  const launchJar = isFabric ? 'fabric-server-launch.jar' : 'quilt-server-launch.jar';
  try { fs.rmSync(installerPath, { force: true }); } catch {} // keep the server folder clean
  if (fs.existsSync(path.join(dir, launchJar))) return { jar: launchJar, version: mcVersion };
  // unexpected layout — fall back to any runnable jar the installer produced
  const candidates = fs.readdirSync(dir).filter(f => f.endsWith('.jar') && !f.includes('installer'));
  if (!candidates.length) throw new Error(`${cap(loader)} installer produced no launch jar`);
  return { jar: candidates[0], version: mcVersion };
}

async function installInstallerBased(dir, mcVersion, loader, loaderVersion, onProgress) {
  let dl;
  if (loader === 'forge') {
    if (!loaderVersion) {
      const vs = await versions.getForgeVersions(mcVersion);
      if (!vs.length) throw new Error(`No Forge builds for ${mcVersion}`);
      loaderVersion = vs[0].version;
    }
    dl = await versions.downloadForgeInstaller(dir, mcVersion, loaderVersion, onProgress);
  } else {
    if (!loaderVersion) {
      const vs = await versions.getNeoForgeVersions(mcVersion);
      if (!vs.length) throw new Error(`No NeoForge builds for ${mcVersion}`);
      loaderVersion = vs[0].version;
    }
    dl = await versions.downloadNeoForgeInstaller(dir, mcVersion, loaderVersion, onProgress);
  }
  const major = Math.max(17, javaEngine.javaMajorFor(mcVersion));
  const { path: jPath } = await javaEngine.ensureJava(major);
  serverLogMulti(`Running ${loader} server installer with Java ${major}...`);
  await new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(jPath, ['-jar', dl.installerPath, '--installServer', dir], {
      windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, cwd: dir,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${loader} server installer failed: ${String(stderr).slice(-500)}`));
      resolve();
    });
  });
  // find generated jar / run script
  const candidates = fs.readdirSync(dir).filter(f => f.endsWith('.jar') && !f.includes('installer'));
  const jar = candidates[0] || path.basename(dl.installerPath);
  return { jar, version: mcVersion };
}

function serverLogMulti(line) { serverLog('install', line, 'download'); }

async function installSpigot(dir, mcVersion, onProgress) {
  // SpigotMC has no official jar download. Real options: BuildTools (needs git+java) or manual jar.
  const dest = path.join(dir, 'BuildTools.jar');
  await download('https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', dest, { onProgress });
  return { jar: null, version: mcVersion, buildtools: dest, manual: true };
}

/**
 * Install/prepare a server. Returns { jar, version } and marks server installed.
 */
async function installServer(server) {
  const dir = store.serverDir(server.id);
  let result;
  serverLog(server.id, `Installing ${server.type} ${server.version}...`, 'download');
  emit(server.id, 'install-start', { type: server.type, version: server.version });
  const onProgress = (r, t) => emit(server.id, 'download-progress', { received: r, total: t });

  switch (server.type) {
    case 'paper': result = await installPaper(dir, server.version, onProgress); break;
    case 'vanilla': result = await installVanilla(dir, server.version, onProgress); break;
    case 'fabric': result = await installFabricLike(dir, server.version, 'fabric', null, onProgress); break;
    case 'quilt': result = await installFabricLike(dir, server.version, 'quilt', null, onProgress); break;
    case 'forge': result = await installInstallerBased(dir, server.version, 'forge', null, onProgress); break;
    case 'neoforge': result = await installInstallerBased(dir, server.version, 'neoforge', null, onProgress); break;
    case 'spigot': result = await installSpigot(dir, server.version, onProgress); break;
    default: throw new Error(`Unknown server type ${server.type}`);
  }

  if (result.jar) {
    store.updateServer(server.id, { installed: true, jarFile: result.jar });
    serverLog(server.id, `Installed: ${result.jar}`, 'download');
  } else {
    store.updateServer(server.id, { installed: false, jarFile: null });
    serverLog(server.id, 'Spigot has no official direct download. BuildTools.jar was downloaded — run it once (needs git + JDK), or drop a spigot-*.jar into the server folder, then start the server.', 'warn');
  }
  writeEula(server, true);
  writeServerProperties(server);
  emit(server.id, 'install-done', result);
  return result;
}

// ---------------- config files ----------------

function writeEula(server, accept) {
  const dir = store.serverDir(server.id);
  fs.writeFileSync(path.join(dir, 'eula.txt'),
    `# Accepted via Neurax Launcher on ${new Date().toISOString()}\neula=${accept ? 'true' : 'false'}\n`);
}

function writeServerProperties(server) {
  const dir = store.serverDir(server.id);
  const file = path.join(dir, 'server.properties');
  let props = '';
  try { props = fs.readFileSync(file, 'utf8'); } catch {}
  const set = (key, val) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(props)) props = props.replace(re, `${key}=${val}`);
    else props += (props && !props.endsWith('\n') ? '\n' : '') + `${key}=${val}\n`;
  };
  set('server-port', server.port);
  set('motd', server.motd || server.name);
  set('server-name', server.name);
  fs.writeFileSync(file, props);
}

// ---------------- run / console ----------------

const running = new Map(); // serverId -> proc

async function startServer(server) {
  if (running.has(server.id)) {
    // friendly no-op: the UI hydrates run-state from getRuntime(), but if this
    // ever races, returning info beats a scary "already running" error
    const p = running.get(server.id);
    return { pid: p ? p.pid : null, alreadyRunning: true };
  }
  const dir = store.serverDir(server.id);
  let srv = store.getServer(server.id);

  let jar = srv.jarFile && fs.existsSync(path.join(dir, srv.jarFile)) ? srv.jarFile : null;
  if (!jar) {
    // any runnable jar in the dir (user may have dropped one)
    const jars = fs.readdirSync(dir).filter(f => f.endsWith('.jar') && f !== 'BuildTools.jar' && !f.includes('installer'));
    jar = jars[0] || null;
    if (jar) store.updateServer(server.id, { installed: true, jarFile: jar });
  }
  if (!jar) {
    await installServer(srv);
    srv = store.getServer(server.id);
    jar = srv.jarFile;
  }
  if (!jar) throw new Error('No server jar available (spigot needs a jar or BuildTools run).');

  writeServerProperties(server);
  const major = javaEngine.javaMajorFor(server.version);
  const { path: jPath } = await javaEngine.ensureJava(major, {
    onProgress: (r, t) => emit(server.id, 'download-progress', { received: r, total: t }),
  });

  const args = ['-Xms' + Math.min(512, server.memoryMB) + 'M', '-Xmx' + server.memoryMB + 'M', '-jar', jar, 'nogui'];
  serverLog(server.id, `$ ${path.basename(jPath)} ${args.join(' ')}`, 'info');
  const proc = spawn(jPath, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  running.set(server.id, proc);
  startedAt.set(server.id, Date.now());
  emit(server.id, 'started', { pid: proc.pid });
  store.updateServer(server.id, { lastRun: Date.now() });

  let lineBuf = '';
  const onOut = (buf) => {
    lineBuf += buf.toString('utf8');
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop();
    for (const l of lines) if (l.trim()) serverLog(server.id, l);
  };
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  proc.on('close', (code) => {
    running.delete(server.id);
    startedAt.delete(server.id);
    serverLog(server.id, `Server exited with code ${code}`, code === 0 ? 'info' : 'error');
    emit(server.id, 'stopped', { code });
  });
  return { pid: proc.pid };
}

function sendCommand(serverId, cmd) {
  const proc = running.get(serverId);
  if (!proc) throw new Error('Server is not running');
  proc.stdin.write(cmd + '\n');
  serverLog(serverId, `> ${cmd}`, 'info');
}

function stopServer(serverId) {
  const proc = running.get(serverId);
  if (!proc) return false;
  try { proc.stdin.write('stop\n'); } catch { try { proc.kill(); } catch {} }
  return true;
}

function forceKill(serverId) {
  const proc = running.get(serverId);
  if (proc) { try { proc.kill('SIGKILL'); } catch {} return true; }
  return false;
}

function isRunning(serverId) { return running.has(serverId); }

function listRunning() { return [...running.keys()]; }

module.exports = {
  installServer, startServer, stopServer, forceKill, sendCommand,
  isRunning, listRunning, setBroadcaster, writeServerProperties, writeEula,
  getPaperVersions,
  // console history + run-state (main process is the source of truth)
  pushConsoleLine, getLog, clearLog, getRuntime,
};
