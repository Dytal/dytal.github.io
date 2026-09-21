// logger.js — unified launcher logger: ring buffer, file sink, broadcast to windows.
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./paths');

const RING_MAX = 4000;
const ring = [];
const listeners = new Set();

function stamp() { return new Date().toISOString().replace('T', ' ').replace('Z', ''); }

let logFile = null;
function getFile() {
  if (!logFile) {
    const d = new Date();
    const name = `launcher-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
    logFile = path.join(DIRS.logs, name);
    fs.mkdirSync(DIRS.logs, { recursive: true });
  }
  return logFile;
}

function broadcast(entry) {
  for (const fn of listeners) { try { fn(entry); } catch {} }
}

function log(level, source, message) {
  const entry = {
    t: Date.now(), time: stamp(), level, source,
    msg: typeof message === 'string' ? message : safeStr(message),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  try { fs.appendFileSync(getFile(), `[${entry.time}] [${level}] [${source}] ${entry.msg}\n`, 'utf8'); } catch {}
  broadcast(entry);
  if (process.env.NEURAX_DEBUG || level === 'error') {
    process.stderr.write(`[${level}] [${source}] ${entry.msg}\n`);
  }
}

function safeStr(m) {
  try { return JSON.stringify(m); } catch { return String(m); }
}

const ns = (source) => ({
  info: (m) => log('info', source, m),
  warn: (m) => log('warn', source, m),
  error: (m) => log('error', source, m),
  debug: (m) => log('debug', source, m),
  game: (m) => log('game', source, m),
  download: (m) => log('download', source, m),
});

module.exports = {
  core: ns('core'),
  versions: ns('versions'),
  java: ns('java'),
  auth: ns('auth'),
  game: ns('game'),
  modrinth: ns('modrinth'),
  mods: ns('mods'),
  servers: ns('servers'),
  files: ns('files'),
  window: ns('window'),
  nx: ns('nx'),
  client: ns('client'),        // the Neurax Client (mod injection) — v1.0-R2: was MISSING, so every inject log call threw and the whole injection silently degraded
  curseforge: ns('curseforge'), // CurseForge installer — same latent miss
  raw: ns,
  log,
  getHistory: () => ring.slice(),
  addListener(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
