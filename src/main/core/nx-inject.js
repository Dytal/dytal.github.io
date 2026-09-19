// nx-inject.js — injects the bundled NX-UI 64x resource pack into every
// Minecraft game directory the launcher manages, and auto-enables it ONCE
// per game dir (never fights the user if they later disable it in-game).
//
// Works for: every existing instance, every FUTURE instance (called from
// store.createInstance too), the shared global .minecraft (vanilla play),
// and Modrinth-installed modpacks (their game dir is an instance dir).
// Loader-agnostic: vanilla/Fabric/Quilt/Forge/NeoForge all read resourcepacks/.
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./paths');
const settingsMod = require('./settings');
const logger = require('./logger');

const PACK_NAME = 'NX-UI-64x';
const MARKER = '.nx-injected-v3';
let packSource = () => path.join(__dirname, '..', '..', 'assets', 'nx', `${PACK_NAME}.zip`);

function packFile() { return packSource(); }
function packExists() { try { return fs.statSync(packFile()).isFile(); } catch { return false; } }

/** Read a loose key from options.txt (no trailing newline mangling). */
function readOptions(gameDir) {
  const p = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : [];
  return { p, lines };
}

/** Ensure the pack zip exists in <gameDir>/resourcepacks and is enabled once. */
function injectGameDir(gameDir, { enable = true } = {}) {
  try {
    if (!gameDir || !packExists()) return { injected: false, reason: 'pack missing' };
    const rpDir = path.join(gameDir, 'resourcepacks');
    fs.mkdirSync(rpDir, { recursive: true });
    const dest = path.join(rpDir, `${PACK_NAME}.zip`);
    fs.copyFileSync(packFile(), dest); // always refresh so pack updates propagate

    const marker = path.join(rpDir, MARKER);
    if (!enable) return { injected: true, enabled: false, reason: 'disabled in settings' };
    if (fs.existsSync(marker)) return { injected: true, enabled: false, reason: 'already enabled before' };

    const { p, lines } = readOptions(gameDir);
    const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
    let current = [];
    if (idx >= 0) {
      try { current = JSON.parse(lines[idx].slice('resourcePacks:'.length).trim() || '[]'); } catch { current = []; }
      lines.splice(idx, 1);
    }
    const entry = `file/${PACK_NAME}.zip`;
    if (!current.includes(entry)) current = ['vanilla', ...current.filter((x) => x !== 'vanilla'), entry];
    lines.push(`resourcePacks:${JSON.stringify(current)}`);
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
    fs.writeFileSync(marker, 'enabled by Neurax Launcher NX-UI injection\n', 'utf8');
    logger.core.info(`NX-UI pack enabled in ${gameDir}`);
    return { injected: true, enabled: true };
  } catch (e) {
    logger.core.warn(`NX-UI injection failed for ${gameDir}: ${e.message}`);
    return { injected: false, reason: e.message };
  }
}

/** Inject into every instance + the shared global .minecraft. */
function injectAll() {
  const set = settingsMod.get();
  if (!set.nxUiInject) return { skipped: true };
  const results = [];
  try {
    const { listInstances, instanceGameDir } = require('./store');
    for (const inst of listInstances()) {
      results.push({ target: `instance:${inst.name}`, ...injectGameDir(instanceGameDir(inst.id)) });
    }
  } catch (e) { logger.core.warn('NX-UI instance injection scan failed: ' + e.message); }
  results.push({ target: 'global', ...injectGameDir(DIRS.minecraft) });
  return { results };
}

module.exports = { injectGameDir, injectAll, packFile, packExists, PACK_NAME };
