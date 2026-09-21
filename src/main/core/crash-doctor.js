// crash-doctor.js — v4.6 game-crash intelligence.
//
// Diagnoses WHY Minecraft died (Windows exit codes), reads the game's own
// crash report, keeps a small crash history, and arms AUTO SAFE MODE when the
// same launch keeps dying: the next PLAY runs with every resource pack
// quarantined (100% vanilla) — the #1 quick fix for GPU-driver crashes —
// and the packs are restored automatically after 10 clean minutes.
//
// Also owns hardware awareness used at launch time:
//   - GPU detection (PowerShell wmic fallback, cached 24 h) with integrated/
//     dedicated classification, because integrated GPUs SHARE system RAM.
//   - Memory clamping so a 14.5 GB heap can no longer strangle a 16 GB
//     shared-memory machine (the classic "access violation at startup").
//   - Java compatibility flags (--enable-native-access / unsafe-memory-access)
//     for the modern JDK era (Java 21/23/25 warnings seen in MC 26.x logs).
//
// Stdlib only. Pure functions are exported for probes; file effects live in
// .neurax/cache (crash-history.json, safe-mode.json, gpu-info.json).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { DIRS, readJSON, writeJSON } = require('./paths');
const logger = require('./logger');

let broadcast = () => {}; // set by main.js like game.setBroadcaster
function setBroadcaster(fn) { broadcast = typeof fn === 'function' ? fn : () => {}; }

/* ============================================================ exit codes */

const WINDOWS_EXIT_CODES = {
  0xC0000005: {
    kind: 'access-violation',
    title: 'Minecraft crashed — graphics driver (access violation)',
    detail: 'This exit code almost always means the GPU driver crashed, not Minecraft itself — especially on integrated AMD Radeon / Intel graphics with older drivers. Update your graphics driver (AMD Software, NVIDIA app, or Intel Driver & Support Assistant). Safe relaunch usually gets you into the game right away.',
    driver: true,
  },
  0xC0000409: {
    kind: 'fail-fast',
    title: 'Minecraft crashed — native fail-fast (stack buffer overrun)',
    detail: 'The process killed itself on purpose after detecting corruption — on startup crashes this is nearly always the graphics driver or a bad native library. Updating the GPU driver + a safe relaunch is the reliable fix.',
    driver: true,
  },
  0xC0000142: {
    kind: 'dll-init-failed',
    title: 'Minecraft could not start — a Windows library failed to initialise',
    detail: 'A system DLL failed to load. Windows Update / a GPU driver reinstall usually repairs this.',
    driver: false,
  },
  0xC000001D: {
    kind: 'illegal-instruction',
    title: 'Minecraft crashed — CPU instruction not supported',
    detail: 'The CPU hit an instruction it does not support. This is a machine/CPU compatibility problem, not your world or settings.',
    driver: false,
  },
  0xC00000FD: {
    kind: 'stack-overflow',
    title: 'Minecraft crashed — native stack overflow',
    detail: 'A native library recursion blew the stack. Mod conflicts are the usual cause — a safe (vanilla) relaunch confirms it.',
    driver: false,
  },
  0x80000003: {
    kind: 'breakpoint',
    title: 'Minecraft crashed — native breakpoint',
    detail: 'A native library hit a hard breakpoint — typically the GPU driver or injected software.',
    driver: true,
  },
  0xC0000001: {
    kind: 'status-unsuccessful',
    title: 'Minecraft exited with a Windows error',
    detail: 'The operating system reported a generic failure while the game was running. Check the game logs and crash report.',
    driver: false,
  },
};

/** Map signed (Node/POSIX-style) exit codes to unsigned Windows NTSTATUS. */
function normalizeExitCode(code) {
  let n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (n < 0) n = n >>> 0; // 0xC0000005 as int32 (-1073741819) → 3221225477
  return Math.floor(n);
}

/** Codes that mean "the process was terminated on purpose", not a crash. */
const NOT_CRASH_CODES = new Set([0, 130, 137, 143]); // 0 clean, SIGINT, SIGKILL, SIGTERM

function describeExit(code) {
  const n = normalizeExitCode(code);
  if (n === null) {
    return { code: null, hex: null, kind: 'unknown', title: 'Minecraft exited', detail: '', driverLikely: false, crashed: false };
  }
  if (NOT_CRASH_CODES.has(n)) {
    return { code: n, hex: `0x${n.toString(16).toUpperCase()}`, kind: 'normal', title: 'Minecraft exited', detail: '', driverLikely: false, crashed: false };
  }
  const info = WINDOWS_EXIT_CODES[n];
  const hex = `0x${n.toString(16).toUpperCase()}`;
  if (info) {
    return { code: n, hex, kind: info.kind, title: info.title, detail: info.detail, driverLikely: !!info.driver, crashed: true };
  }
  const native = n >= 0x80000000;
  return {
    code: n,
    hex,
    kind: native ? 'native-error' : 'generic-error',
    title: native ? `Minecraft crashed (Windows error ${hex})` : `Minecraft exited with an error (code ${n})`,
    detail: native
      ? 'The game process died with a native Windows error. A safe relaunch plus a graphics-driver update fixes most of these.'
      : 'The game closed with an error code instead of finishing normally — check the Logs and the crash report.',
    driverLikely: native,
    crashed: true,
  };
}

/* ============================================================ crash reports */

/** Newest crash-*.txt written at/after minMtime (ms epoch, optional). */
function findLatestCrashReport(gameDir, minMtime = 0) {
  try {
    const dir = path.join(gameDir, 'crash-reports');
    if (!fs.existsSync(dir)) return null;
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!/^crash-.*\.txt$/i.test(name)) continue;
      const file = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      if (minMtime && st.mtimeMs < minMtime) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    }
    if (!best) return null;
    let text = '';
    try { text = fs.readFileSync(best.file, 'utf8'); } catch { return null; }
    return { file: best.file, mtimeMs: best.mtimeMs, text };
  } catch { return null; }
}

/** Pull the human headline (Description / first exception / screen) out of a
 *  Minecraft crash report body. Returns { description, error, screen } | null. */
function summarizeCrashReport(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  const out = {};
  const di = lines.findIndex((l) => l.startsWith('Description:'));
  if (di >= 0) {
    let desc = lines[di].slice('Description:'.length).trim();
    if (!desc && lines[di + 1]) desc = lines[di + 1].trim();
    if (desc) out.description = desc.slice(0, 240);
    for (let i = di + 1; i < Math.min(lines.length, di + 14); i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith('at ')) continue;
      if (/[\w.$]+(Exception|Error)\b/.test(l)) { out.error = l.slice(0, 240); break; }
    }
  }
  const si = lines.findIndex((l) => l.startsWith('Screen Name:'));
  if (si >= 0) {
    const s = lines[si].slice('Screen Name:'.length).trim();
    if (s) out.screen = s.slice(0, 80);
  }
  return Object.keys(out).length ? out : null;
}

/* ============================================================ crash history */

function historyFile() { return path.join(DIRS.cache, 'crash-history.json'); }

function history() {
  const h = readJSON(historyFile(), []);
  return Array.isArray(h) ? h : [];
}

/** Persist one crash. Skips clean exits, user stops and never-started games.
 *  Returns the stored entry or null. */
function recordCrash({ code, gameDir, version, uptimeSec, summary, reportFile }) {
  try {
    const d = describeExit(code);
    if (!d.crashed) return null;
    if (uptimeSec === null || uptimeSec === undefined) return null; // game never actually started (e.g. Java check failed)
    const entry = {
      ts: Date.now(),
      code: d.code,
      hex: d.hex,
      kind: d.kind,
      title: d.title,
      uptimeSec: Math.max(0, Math.floor(uptimeSec)),
      version: version || null,
      gameDir: gameDir || null,
      reportFile: reportFile || null,
      summary: summary || null,
    };
    const h = history();
    h.push(entry);
    while (h.length > 20) h.shift();
    writeJSON(historyFile(), h);
    cancelAutoRestore(); // a new crash means the session was NOT clean
    logger.game.warn(`Crash recorded: ${entry.title} (${entry.hex}) after ${entry.uptimeSec}s${entry.version ? ` — ${entry.version}` : ''}`);
    return entry;
  } catch (e) {
    logger.game.warn('Could not record crash: ' + e.message);
    return null;
  }
}

/** Auto safe-mode decision (pure): 2+ startup crashes (≤ 90 s uptime) within
 *  15 minutes, or 3+ crashes of any kind within 15 minutes. */
function shouldAutoSafeMode(list, now = Date.now()) {
  if (!Array.isArray(list)) return false;
  const recent = list.filter((c) => c && typeof c.ts === 'number' && now - c.ts < 15 * 60 * 1000);
  if (recent.length >= 3) return true;
  const startup = recent.filter((c) => typeof c.uptimeSec === 'number' && c.uptimeSec <= 90);
  return startup.length >= 2;
}

/* ============================================================ safe mode */

function safeModeFile() { return path.join(DIRS.cache, 'safe-mode.json'); }
const SAFE_MODE_DIRNAME = '.nx-safe-mode-backup';
const AUTO_RESTORE_DELAY_MS = 10 * 60 * 1000;
let autoRestoreTimer = null;

/** Arm safe mode for the NEXT launch (persisted — survives launcher restarts,
 *  which matters because close-on-launch relaunches the app after a crash). */
function armSafeMode(reason) {
  try {
    writeJSON(safeModeFile(), { armed: true, reason: String(reason || 'crashes').slice(0, 200), ts: Date.now() });
    logger.game.warn(`SAFE MODE armed (${reason || 'crashes'}) — the next PLAY quarantines resource packs and runs 100% vanilla.`);
    broadcast('launch:notice', {
      message: 'Neurax armed SAFE MODE — the next PLAY launches without resource packs. They return automatically after 10 clean minutes (or Settings → Diagnostics → Restore packs).',
    });
    return true;
  } catch (e) {
    logger.game.warn('Could not arm safe mode: ' + e.message);
    return false;
  }
}

/** Read + disarm the persisted flag. Returns { reason, ts } or null. */
function consumeSafeMode() {
  const st = readJSON(safeModeFile(), null);
  if (!st || !st.armed) return null;
  try { fs.rmSync(safeModeFile(), { force: true }); } catch { /* best effort */ }
  return st;
}

function isSafeModeArmed() {
  const st = readJSON(safeModeFile(), null);
  return !!(st && st.armed);
}

/** Rewrite options.txt so the game loads ["vanilla"] only. */
function writeOptionsVanilla(gameDir) {
  const p = path.join(gameDir, 'options.txt');
  if (!fs.existsSync(p)) return false;
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    let changed = false;
    for (const key of ['resourcePacks', 'incompatibleResourcePacks']) {
      const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
      const line = `${key}:${JSON.stringify(['vanilla'])}`;
      if (idx >= 0) { if (lines[idx] !== line) { lines[idx] = line; changed = true; } }
    }
    if (changed) fs.writeFileSync(p, lines.join('\n'), 'utf8');
    return changed;
  } catch { return false; }
}

/** Quarantine EVERY resource pack into <gameDir>/.nx-safe-mode-backup/<ts>/
 *  and force vanilla-only options.txt. Reversible via restoreSafeModeBackups. */
function prepareSafeMode(gameDir) {
  const rpDir = path.join(gameDir, 'resourcepacks');
  const backupRoot = path.join(gameDir, SAFE_MODE_DIRNAME);
  const moved = [];
  try {
    if (fs.existsSync(rpDir)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(backupRoot, ts);
      for (const entry of fs.readdirSync(rpDir)) {
        if (entry === SAFE_MODE_DIRNAME) continue;
        try {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.renameSync(path.join(rpDir, entry), path.join(backupDir, entry));
          moved.push(entry);
        } catch { /* single stubborn pack must not block the rest */ }
      }
      if (!moved.length) { try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* empty dir is harmless */ } }
    }
    writeOptionsVanilla(gameDir);
  } catch (e) {
    logger.game.warn('Safe-mode pack quarantine partially failed: ' + e.message);
  }
  return { moved, backupRoot, rpDir };
}

/** Put quarantined packs back. Duplicate names are dropped (the launcher
 *  re-injects the NX pack itself). Returns { restored, removed }. */
function restoreSafeModeBackups(gameDir) {
  const backupRoot = path.join(gameDir, SAFE_MODE_DIRNAME);
  const rpDir = path.join(gameDir, 'resourcepacks');
  let restored = 0;
  const removed = [];
  try {
    if (!fs.existsSync(backupRoot)) return { restored, removed };
    for (const ts of fs.readdirSync(backupRoot)) {
      const d = path.join(backupRoot, ts);
      let entries = [];
      try { entries = fs.readdirSync(d); } catch { continue; }
      for (const entry of entries) {
        const dest = path.join(rpDir, entry);
        try {
          if (fs.existsSync(dest)) {
            removed.push(entry);
            fs.rmSync(path.join(d, entry), { recursive: true, force: true });
          } else {
            fs.mkdirSync(rpDir, { recursive: true });
            fs.renameSync(path.join(d, entry), dest);
            restored++;
          }
        } catch { /* keep going */ }
      }
      try { fs.rmdirSync(d); } catch { /* non-empty — fine */ }
    }
    try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  } catch (e) {
    logger.game.warn('Safe-mode restore failed: ' + e.message);
  }
  return { restored, removed };
}

/** After a safe-mode launch survived `delayMs`, quietly put the packs back. */
function armAutoRestore(gameDir, delayMs = AUTO_RESTORE_DELAY_MS) {
  cancelAutoRestore();
  autoRestoreTimer = setTimeout(() => {
    autoRestoreTimer = null;
    const r = restoreSafeModeBackups(gameDir);
    logger.game.info(`Safe-mode auto-restore: ${r.restored} pack(s) returned${r.removed.length ? `, ${r.removed.length} duplicate(s) dropped` : ''}.`);
    broadcast('launch:notice', {
      message: r.restored
        ? `Safe mode finished clean — ${r.restored} resource pack(s) restored for your next play.`
        : 'Safe mode finished clean — no packs needed restoring.',
    });
  }, Math.max(1000, delayMs));
  if (autoRestoreTimer.unref) autoRestoreTimer.unref();
  return true;
}

function cancelAutoRestore() {
  if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); autoRestoreTimer = null; return true; }
  return false;
}

/* ============================================================ GPU detection */

// WMI writes "(TM)" either attached (Radeon(TM)) or spaced (Radeon (TM)) —
// accept both. Dedicated cards are checked FIRST (Radeon RX beats Radeon(TM)).
const IGPU_RX = /radeon\s*\(tm\)|\bvega\b|\buhd\b|intel\(r?\)? (uhd|hd|iris)|\barc graphics\b|\bradeon\s*\(tm\)\s*[0-9]{3}m\b|\bradeon (r[2-7]|hd) [0-9]{3}/i;
const DGPU_RX = /\bgeforce\b|\brtx\b|\bgtx\b|arc\s*\(tm\)|\bradeon rx\b|\bquadro\b|\bradeon pro\b|\bfirepro\b/i;

function classifyGpu(name) {
  const n = String(name || '');
  if (DGPU_RX.test(n)) return 'dedicated';
  if (IGPU_RX.test(n)) return 'integrated';
  return 'unknown';
}

function gpuCacheFile() { return path.join(DIRS.cache, 'gpu-info.json'); }
const GPU_TTL_MS = 24 * 60 * 60 * 1000;

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout || ''));
      });
    } catch { resolve(null); }
  });
}

/** Normalize PowerShell ConvertTo-Json output (object OR array) → gpu list. */
function parseGpuJson(raw) {
  try {
    let parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed
      .map((g) => ({ name: String(g && g.Name || '').trim(), driver: String(g && g.DriverVersion || '').trim() }))
      .filter((g) => g.name)
      .map((g) => ({ ...g, type: classifyGpu(g.name) }));
  } catch { return []; }
}

/** Fallback: `wmic ... /format:csv` (older machines where PS is locked down). */
function parseWmicCsv(raw) {
  try {
    const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return [];
    const headerIdx = lines.findIndex((l) => /,Name,|,Name$/i.test(l) || /Node,.*Name/i.test(l));
    const start = headerIdx >= 0 ? headerIdx + 1 : 1;
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const cells = lines[i].split(',').map((c) => c.trim()).filter(Boolean);
      if (!cells.length) continue;
      const name = cells.find((c) => /radeon|geforce|intel|nvidia|amd|arc|graphics|quadro/i.test(c) && !/^node$/i.test(c) && !/^[0-9.]+$/.test(c));
      const driver = cells.find((c) => /^[0-9][0-9.]{4,}$/.test(c));
      if (name) out.push({ name, driver: driver || '', type: classifyGpu(name) });
    }
    return out;
  } catch { return []; }
}

async function probeWindowsGpus() {
  const ps = await runCmd('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress',
  ], 7000);
  const parsed = parseGpuJson(ps);
  if (parsed.length) return parsed;
  const csv = await runCmd('wmic.exe', ['path', 'Win32_VideoController', 'get', 'Name,DriverVersion', '/format:csv'], 7000);
  return parseWmicCsv(csv);
}

/** Cached GPU list (24 h TTL, disk-backed). Returns [] off-Windows. */
async function detectGpus(opts = {}) {
  try {
    if (!opts.force) {
      const cached = readJSON(gpuCacheFile(), null);
      if (cached && Array.isArray(cached.gpus) && Date.now() - cached.ts < GPU_TTL_MS) return cached.gpus;
    }
  } catch { /* cache unreadable — re-detect */ }
  let gpus = [];
  if (process.platform === 'win32') {
    try { gpus = await probeWindowsGpus(); } catch { gpus = []; }
  }
  try { writeJSON(gpuCacheFile(), { ts: Date.now(), gpus }); } catch { /* cache is optional */ }
  return gpus;
}

/* ============================================================ memory clamping */

/** Safe heap ceiling (MB) for THIS machine (pure, probe-friendly).
 *  Integrated GPUs share system RAM with the game — the heap must leave room
 *  for Windows + the driver's shared graphics memory, or the driver dies with
 *  access violations exactly like the reported startup crashes. */
function classifyMemoryCap({ totalMB, gpus }) {
  const total = Math.max(2048, Math.floor(Number(totalMB) || 0));
  const list = Array.isArray(gpus) ? gpus : [];
  const hasI = list.some((g) => g && g.type === 'integrated');
  const hasD = list.some((g) => g && g.type === 'dedicated');
  let factor; let reserve;
  if (hasI && !hasD) { factor = 0.6; reserve = 4096; }   // integrated only — tightest
  else if (hasI && hasD) { factor = 0.7; reserve = 2048; } // hybrid — OS still needs headroom
  else if (!list.length) { factor = 0.7; reserve = 2048; } // unknown hardware — stay cautious
  else { factor = 0.75; reserve = 2048; }                  // dedicated only
  return Math.max(1024, Math.min(total - reserve, Math.floor(total * factor)));
}

function clampMemory(requestedMB, cap) {
  const r = Math.max(256, Math.floor(Number(requestedMB) || 512));
  return Math.max(256, Math.min(r, Math.floor(Number(cap) || r)));
}

/** Human reason for the launch log when a clamp actually fires. */
function memoryClampReason(gpus) {
  const list = Array.isArray(gpus) ? gpus : [];
  return list.some((g) => g && g.type === 'integrated')
    ? 'integrated GPUs share system RAM with the game'
    : 'memory is reserved for Windows and graphics';
}

/* ============================================================ JVM flags */

/** Java-era compatibility flags (pure). MC 26.x on modern JDKs warns about
 *  restricted native methods / Unsafe — these flags silence the warnings and
 *  keep LWJGL 3.4.x working when JDKs tighten the defaults. */
function compatJvmFlags(javaMajor) {
  const major = Math.floor(Number(javaMajor) || 0);
  const flags = [];
  if (major >= 21) flags.push('--enable-native-access=ALL-UNNAMED');
  if (major >= 23) flags.push('--sun-misc-unsafe-memory-access=allow');
  return flags;
}

/* ============================================================ summary */

async function diagSummary() {
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  let gpus = [];
  try { gpus = await detectGpus(); } catch { gpus = []; }
  const h = history();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return {
    platform: process.platform,
    gpus,
    hasIntegratedGPU: gpus.some((g) => g.type === 'integrated'),
    hasDedicatedGPU: gpus.some((g) => g.type === 'dedicated'),
    totalMB,
    safeMemoryCapMB: classifyMemoryCap({ totalMB, gpus }),
    lastCrash: h.length ? h[h.length - 1] : null,
    crashesRecent: h.filter((c) => c && c.ts >= dayAgo).length,
    safeModeArmed: isSafeModeArmed(),
  };
}

/** Test hook — clear all on-disk state this module owns. */
function _resetForTests() {
  cancelAutoRestore();
  for (const f of [historyFile(), safeModeFile(), gpuCacheFile()]) {
    try { fs.rmSync(f, { force: true }); } catch { /* fine */ }
  }
}

module.exports = {
  setBroadcaster,
  // exit codes
  normalizeExitCode, describeExit,
  // crash reports + history
  findLatestCrashReport, summarizeCrashReport, recordCrash, history, shouldAutoSafeMode,
  // safe mode
  armSafeMode, consumeSafeMode, isSafeModeArmed, prepareSafeMode, restoreSafeModeBackups,
  armAutoRestore, cancelAutoRestore, SAFE_MODE_DIRNAME, AUTO_RESTORE_DELAY_MS,
  // hardware
  classifyGpu, parseGpuJson, parseWmicCsv, detectGpus,
  classifyMemoryCap, clampMemory, memoryClampReason,
  // jvm
  compatJvmFlags,
  // misc
  diagSummary, _resetForTests,
};
