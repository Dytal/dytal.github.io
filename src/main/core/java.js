// java.js — Java discovery + automatic runtime download (Adoptium Temurin).
// Minecraft needs: <=1.16.5 -> Java 8, 1.17 -> 16, 1.18-1.20.4 -> 17, 1.20.5-26.0 -> 21,
// 26.1+ (year-based versions) -> Java 25.
//
// Detection guarantee: system JDKs (JAVA_HOME, PATH, Program Files, ~/.jdks, …) are
// always used first when they satisfy the required major version. Runtimes the
// launcher auto-installs are SAVED under .neurax/runtimes with a ready-marker and
// reused forever after — a download happens at most once per major version.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DIRS, writeJSON, readJSON } = require('./paths');
const { getJSON, download } = require('./net');
const extract = require('extract-zip');
const logger = require('./logger');

const COMPONENT = { 8: 'jre', 16: 'jdk', 17: 'jre', 21: 'jre', 25: 'jre' };

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const MARKER = '.neurax-ready.json'; // written only after a runtime is fully extracted AND verified

function javaMajorFor(mcVersion) {
  // Robust mapping based on known release boundaries.
  const m = mcVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const first = parseInt(m[1], 10);
  // 2026+ Minecraft moved to year-based versions (e.g. 26.3).
  // 26.1 and newer require Java 25; 26.0 and earlier year versions run on Java 21.
  if (first > 1) {
    const minor = parseInt(m[2], 10) || 0;
    if (first > 26 || (first === 26 && minor >= 1)) return 25;
    return 21;
  }
  const minor = first === 1 ? parseInt(m[2], 10) : 0;
  const patch = m[3] ? parseInt(m[3], 10) : 0;
  if (minor <= 16) return 8;              // 1.0 – 1.16.5
  if (minor === 17) return 16;            // 1.17 – 1.17.1
  if (minor <= 20 && !(minor === 20 && patch >= 5)) return 17; // 1.18 – 1.20.4
  return 21;                              // 1.20.5 – 26.0
}

function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
}

function archName() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return process.arch;
}

function runtimeDir(major) { return path.join(DIRS.runtimes, `java-${major}`); }
function markerPath(major) { return path.join(runtimeDir(major), MARKER); }

function findIn(dir) {
  // locate java executable inside an extracted runtime dir (depth <= 3)
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory() && stack.length < 6) stack.push(p);
      else if (it.isFile() && it.name === JAVA_EXE) return p;
    }
  }
  return null;
}

function runJava(javaPath, args) {
  return new Promise((resolve) => {
    // ⚠️ `java -version` prints to STDERR, not stdout. We used to read only
    // stdout, so every probe returned "" -> javaVersionOf()=0 -> NO java was
    // ever "found" -> system JDKs were ignored AND the auto-installed runtime
    // was re-downloaded on every single launch. Merge both streams.
    execFile(javaPath, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return resolve(null);
      resolve(((stdout || '') + '\n' + (stderr || '')).trim());
    });
  });
}

/** Parse merged `java -version` output ("openjdk version \"25.0.4.1\" …") into a major. */
function parseJavaVersion(text) {
  if (!text) return 0;
  const m = String(text).match(/version "(\d+)(?:\.(\d+))?(?:[._](\d+))?[^"]*"/);
  if (!m) return 0;
  if (m[1] === '1') return parseInt(m[2] || '8', 10); // legacy "1.8.0_402"
  return parseInt(m[1], 10);
}

/** Check a java binary's major version (returns 0 when it can't be run/parsed). */
async function javaVersionOf(javaPath) {
  const out = await runJava(javaPath, ['-version']);
  return parseJavaVersion(out);
}

// ---- discovery --------------------------------------------------------------
// Short in-memory cache: launches and the Settings page both scan; within the
// TTL the scan is instant. installRuntime() clears it after adding a runtime.
let scanCache = null; // { at, results }
const SCAN_TTL = 10 * 60 * 1000;

function normKey(p) {
  try {
    // realpath collapses symlinked PATH entries (/usr/bin/java vs /usr/lib/jvm/.../bin/java)
    const r = fs.realpathSync(path.resolve(p));
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch { return p; }
}

function isUnderRuntimes(p) {
  try { return path.resolve(p).startsWith(path.resolve(DIRS.runtimes) + path.sep); }
  catch { return false; }
}

/** Collect every `<dir>/**\/bin/java.exe` (depth-limited, no process spawns). */
function collectJavaExes(base, depth, out) {
  if (depth > 4) return;
  let items;
  try { items = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const p = path.join(base, it.name);
    const exe = path.join(p, 'bin', JAVA_EXE);
    try { if (fs.existsSync(exe)) out.push(exe); else collectJavaExes(p, depth + 1, out); } catch {}
  }
}

/** Run async fn over items with limited concurrency. */
async function pool(items, limit, fn) {
  const ret = [];
  for (let i = 0; i < items.length; i += limit) {
    ret.push(...await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return ret;
}

function readRuntimeMarker(major) {
  const m = readJSON(markerPath(major), null);
  return m && m.javaPath ? m : null;
}

function writeRuntimeMarker(major, data) {
  try {
    fs.mkdirSync(runtimeDir(major), { recursive: true });
    writeJSON(markerPath(major), data);
  } catch (e) {
    logger.java.warn(`Could not write runtime marker for Java ${major}: ${e.message}`);
  }
}

/** A runtime we installed earlier is only trusted when it is complete:
 *  java.exe present + the image's `release` file next to bin/. */
function runtimeLooksComplete(javaExe) {
  try { return fs.existsSync(path.join(path.dirname(path.dirname(javaExe)), 'release')); }
  catch { return false; }
}

/** Scan system locations + our saved runtimes. Returns [{path, major, source}]
 *  (source: 'system' | 'neurax' | 'override'), best-first (highest major first). */
async function discoverJavas({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && scanCache && now - scanCache.at < SCAN_TTL) return scanCache.results;

  const exeSet = new Map(); // normKey -> raw path (direct candidate exes)
  const addExe = (p) => { try { if (fs.existsSync(p)) exeSet.set(normKey(p), p); } catch {} };
  const walkRoots = []; // dirs to walk for */bin/java.exe
  const addRoot = (dir) => { try { if (fs.existsSync(dir)) walkRoots.push(dir); } catch {} };

  // 1) JAVA_HOME → <JAVA_HOME>/bin/java.exe
  if (process.env.JAVA_HOME) addExe(path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  // 2) every PATH entry → java.exe directly inside it (NEVER walk PATH dirs:
  //    entries like C:\Windows\System32 are huge)
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(path.delimiter)) {
      if (dir) addExe(path.join(dir, JAVA_EXE));
    }
  }
  // 3) common install roots — recursive walk (depth-limited)
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    for (const base of [
      'C:/Program Files/Java', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Microsoft',
      'C:/Program Files (x86)/Java', 'C:/Program Files (x86)/Eclipse Adoptium',
      'C:/Program Files/Amazon Corretto', 'C:/Program Files (x86)/Amazon Corretto',
      'C:/Program Files/BellSoft', 'C:/Program Files/AdoptOpenJDK',
      'C:/Program Files/Zulu', 'C:/Program Files/Azul',
      'C:/Program Files/Common Files/Oracle/Java/javapath',
      path.join(pf, 'Java'), path.join(pf, 'Eclipse Adoptium'), path.join(pf, 'Microsoft'),
      path.join(pf, 'Amazon Corretto'), path.join(pf, 'Zulu'),
      path.join(pf86, 'Java'), path.join(pf86, 'Eclipse Adoptium'),
    ]) addRoot(base);
  } else if (process.platform === 'darwin') {
    addRoot('/Library/Java/JavaVirtualMachines');
  } else {
    for (const base of ['/usr/lib/jvm', '/usr/java', '/opt/java']) addRoot(base);
  }
  // 4) IntelliJ IDEA downloads JDKs into ~/.jdks — very common on dev machines
  addRoot(path.join(os.homedir(), '.jdks'));
  // 5) runtimes WE installed. Markerless dirs (e.g. installed by an older
  //    launcher version) are probed + self-healed below instead of ignored,
  //    so nothing gets re-downloaded after this update.
  try {
    for (const d of fs.readdirSync(DIRS.runtimes)) {
      if (/^java-\d+$/.test(d)) addRoot(path.join(DIRS.runtimes, d));
    }
  } catch {}

  // gather every candidate exe (fast, filesystem only)
  const exes = [];
  for (const r of walkRoots) collectJavaExes(r, 0, exes);
  for (const [, p] of exeSet) exes.push(p);
  const probeTargets = [...new Map(exes.map(p => [normKey(p), p])).values()];

  // probe versions in parallel (java -version per binary, 6 at a time)
  const probed = await pool(probeTargets, 6, async (p) => {
    const major = await javaVersionOf(p);
    if (!major) return null;
    const source = isUnderRuntimes(p) ? 'neurax' : 'system';
    // self-heal: a complete but markerless neurax runtime (pre-marker install)
    // gets its marker written so future launches take the fast path
    if (source === 'neurax') {
      const majorFromDir = parseInt(path.basename(path.dirname(path.dirname(path.dirname(p)))).replace('java-', ''), 10);
      if (!fs.existsSync(markerPath(majorFromDir)) && runtimeLooksComplete(p)) {
        writeRuntimeMarker(majorFromDir, { major, release: 'pre-marker-install', javaPath: p, installedAt: 0 });
      }
    }
    return { path: p, major, source };
  });
  const results = probed.filter(Boolean).sort((a, b) => b.major - a.major);

  scanCache = { at: now, results };
  logger.java.info(results.length
    ? `Discovered Java runtimes: ${results.map(r => `Java ${r.major} [${r.source}] ${r.path}`).join('  |  ')}`
    : 'No Java runtimes found on this PC.');
  return results;
}

// Only one runtime install per major at a time — a second PLAY click used to
// start a parallel download of the same runtime (and collide on temp files).
const runtimeJobs = new Map(); // major -> Promise<javaPath>

/** Download + extract a Temurin JRE for the requested major. Returns java exe path. */
function installRuntime(major, onProgress) {
  if (runtimeJobs.has(major)) return runtimeJobs.get(major);
  const job = installRuntimeInner(major, onProgress).finally(() => runtimeJobs.delete(major));
  runtimeJobs.set(major, job);
  return job;
}

async function installRuntimeInner(major, onProgress) {
  const osn = osName(), arch = archName();
  const imgType = COMPONENT[major] || 'jre';
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=${imgType}&os=${osn}&vendor=eclipse`;
  const assets = await getJSON(url, { timeout: 20000 });
  if (!assets.length) throw new Error(`No Adoptium ${major} build for ${osn}/${arch}`);
  const pkg = assets[0];
  const link = pkg.binary.package.link;
  const name = pkg.binary.package.name;
  const release = pkg.release_name || `temurin-${major}`;
  logger.java.info(`Downloading Java ${major}: ${release} (${name})`);
  const destPkg = path.join(DIRS.temp, name);
  await download(link, destPkg, { onProgress });
  const extractTo = runtimeDir(major);
  // start from a CLEAN dir — a half-extracted previous attempt must never survive
  try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(extractTo, { recursive: true });
  logger.java.info(`Extracting ${name} ...`);
  // Adoptium ships .zip on Windows but .tar.gz on Linux/macOS — the old code
  // always used the ZIP extractor, so any non-Windows download crashed with
  // "end of central directory record signature not found".
  const extractOnce = async () => {
    if (/\.tar\.gz$|\.tgz$/i.test(name)) {
      await new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile('tar', ['-xzf', destPkg, '-C', extractTo], { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`tar extract failed: ${String(stderr || err.message).slice(-300)}`));
          resolve();
        });
      });
    } else {
      await extract(destPkg, { dir: extractTo });
    }
  };
  try {
    await extractOnce();
  } catch (e) {
    // Windows AV/indexer can hold extracted files locked (EPERM/EBUSY) — one clean retry
    logger.java.warn(`Extract failed (${e.message}) — cleaning and retrying once.`);
    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(extractTo, { recursive: true });
    await extractOnce();
  }
  try { fs.rmSync(destPkg, { force: true }); } catch {}
  const javaPath = findIn(extractTo);
  if (!javaPath) throw new Error('Java extraction failed: java executable not found');
  try { fs.chmodSync(javaPath, 0o755); } catch {}
  // verify it actually runs BEFORE writing the ready-marker
  const v = await javaVersionOf(javaPath);
  if (!v || v < major) throw new Error(`Installed Java failed verification (reported ${v || 'nothing'})`);
  writeRuntimeMarker(major, { major: v, release, javaPath, installedAt: Date.now() });
  scanCache = null; // next discovery must include the new runtime
  logger.java.info(`Java ${v} installed and saved at ${javaPath} — future launches reuse it (no re-download).`);
  return javaPath;
}

/** Ensure a java >= major is available:
 *  0) Settings override  1) our saved runtime (instant, no scan)
 *  2) system scan        3) auto-download (once per major, then saved).
 *  Concurrent calls for the same major share one job (no double download). */
async function ensureJava(major, { onProgress = null, overridePath = '' } = {}) {
  if (ensureJobs.has(major)) return ensureJobs.get(major);
  const job = ensureJavaInner(major, { onProgress, overridePath }).finally(() => ensureJobs.delete(major));
  ensureJobs.set(major, job);
  return job;
}

const ensureJobs = new Map();

async function ensureJavaInner(major, { onProgress = null, overridePath = '' } = {}) {
  // 0) explicit override from Settings
  if (overridePath && fs.existsSync(overridePath)) {
    const v = await javaVersionOf(overridePath);
    if (v >= major) {
      logger.java.info(`Using Java ${v} from Settings override: ${overridePath}`);
      return { path: overridePath, major: v, downloaded: false, source: 'override' };
    }
    logger.java.warn(`Overridden Java (${v}) is too old for required ${major}; ignoring override.`);
  }

  // 1) fast path: a runtime WE installed earlier (marker = fully extracted + verified)
  const cached = readRuntimeMarker(major);
  if (cached && cached.javaPath && fs.existsSync(cached.javaPath)) {
    const v = await javaVersionOf(cached.javaPath);
    if (v >= major) {
      logger.java.info(`Reusing saved Java ${v}: ${cached.javaPath} (no download needed)`);
      return { path: cached.javaPath, major: v, downloaded: false, source: 'neurax' };
    }
    logger.java.warn(`Saved runtime for Java ${major} is broken (reported ${v || 'nothing'}) — recovering.`);
  }

  // 2) system scan (system JDKs win ties against our saved runtime)
  const found = await discoverJavas();
  const rank = (j) => (j.source === 'system' ? 0 : 1);
  const ok = found
    .filter(j => j.major >= major)
    .sort((a, b) => a.major - b.major || rank(a) - rank(b));
  if (ok.length) {
    const pick = ok[0];
    logger.java.info(`Using ${pick.source === 'system' ? 'system' : 'saved'} Java ${pick.major}: ${pick.path}${pick.source === 'system' ? ' — found on this PC, no download needed' : ''}`);
    return { path: pick.path, major: pick.major, downloaded: false, source: pick.source };
  }
  logger.java.info(`No Java >= ${major} on this PC (scan saw: ${found.map(j => `Java ${j.major}`).join(', ') || 'nothing usable'}) — installing one.`);

  // 3) download + save forever
  const dl = await installRuntime(major, onProgress);
  return { path: dl, major, downloaded: true, source: 'neurax' };
}

module.exports = { javaMajorFor, discoverJavas, ensureJava, javaVersionOf, parseJavaVersion, installRuntime, runtimeDir };
