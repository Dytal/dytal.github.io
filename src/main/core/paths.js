// paths.js — resolves the .neurax data root in %APPDATA% (Roaming).
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

function appDataRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return path.join(os.homedir(), '.config');
}

const NEURAX = process.env.NEURAX_HOME || path.join(appDataRoot(), '.neurax');

const DIRS = {
  root: NEURAX,
  global: path.join(NEURAX, 'global'),
  minecraft: path.join(NEURAX, 'global', '.minecraft'),
  instances: path.join(NEURAX, 'instances'),
  servers: path.join(NEURAX, 'servers'),
  cache: path.join(NEURAX, 'cache'),
  logs: path.join(NEURAX, 'logs'),
  auth: path.join(NEURAX, 'auth'),
  runtimes: path.join(NEURAX, 'runtimes'),
  assets: path.join(NEURAX, 'assets'),
  images: path.join(NEURAX, 'assets', 'images'),
  skins: path.join(NEURAX, 'assets', 'skins'),
  temp: path.join(NEURAX, 'temp'),
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

/** Atomic JSON write: write tmp then rename (no partial files). */
function writeJSON(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

module.exports = { NEURAX, DIRS, ensureDirs, writeJSON, readJSON, exists, appDataRoot };
