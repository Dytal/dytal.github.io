// nx-inject.js — v1.0: RESOURCE-PACK INJECTION REMOVED (owner request).
//
// The launcher used to copy the bundled NX-UI 64x pack into every game dir
// and flip it on in options.txt. The owner asked for the whole feature to be
// gone, so this module now does the exact opposite: it CLEANS any game dir
// the launcher ever injected:
//   • resourcepacks/NX-UI-64x.zip                    → deleted
//   • the enable marker (.nx-injected-v3 / legacy)   → deleted
//   • the pack's entry in options.txt resourcePacks  → removed
// Purging is idempotent, runs once per game dir per launch (game.js and
// store.createInstance call it), and never touches packs the USER added —
// only the pack this launcher itself injected. The crash doctor's SAFE MODE
// (temporary quarantine of the player's own packs after repeated crashes)
// is a different, reversible safety feature and is unaffected.
'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const PACK_NAME = 'NX-UI-64x';
const MARKER = '.nx-injected-v3';
const LEGACY_MARKERS = ['.nx-injected', '.nx-injected-v2', MARKER];

function packFile() { return path.join(__dirname, '..', 'assets', 'nx', `${PACK_NAME}.zip`); }
function packExists() { try { return fs.statSync(packFile()).isFile(); } catch { return false; } }

/** Pure helper (probes): remove one entry from an options.txt resourcePacks list. */
function removePackEntry(list, packId) {
  const entry = `file/${packId}.zip`;
  return (Array.isArray(list) ? list : []).filter((x) => x !== entry && x !== packId && x !== `file/${packId}`);
}

/** Remove the injected pack + marker + options.txt entry from one game dir. */
function purgeInjectedPack(gameDir) {
  const out = { removedPack: false, removedMarker: false, cleanedOptions: false };
  try {
    if (!gameDir) return out;
    const rpDir = path.join(gameDir, 'resourcepacks');
    // 1) the injected pack zip itself
    const pack = path.join(rpDir, `${PACK_NAME}.zip`);
    try {
      if (fs.existsSync(pack)) { fs.rmSync(pack, { force: true }); out.removedPack = true; }
    } catch { /* locked by the game — retried on the next launch */ }
    // 2) every enable marker (current + legacy spellings, both locations)
    for (const dir of [gameDir, rpDir]) {
      for (const m of LEGACY_MARKERS) {
        const f = path.join(dir, m);
        try {
          if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); out.removedMarker = true; }
        } catch { /* retried later */ }
      }
    }
    // 3) the options.txt resourcePacks entry
    const optFile = path.join(gameDir, 'options.txt');
    if (fs.existsSync(optFile)) {
      let lines = fs.readFileSync(optFile, 'utf8').split(/\r?\n/);
      const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
      if (idx >= 0) {
        let packs = [];
        try { packs = JSON.parse(lines[idx].slice('resourcePacks:'.length).trim() || '[]'); } catch { packs = []; }
        const cleaned = removePackEntry(packs, PACK_NAME);
        if (cleaned.length !== packs.length) {
          lines[idx] = `resourcePacks:${JSON.stringify(cleaned)}`;
          fs.writeFileSync(optFile, lines.join('\n'), 'utf8');
          out.cleanedOptions = true;
        }
      }
    }
    if (out.removedPack || out.removedMarker || out.cleanedOptions) {
      logger.core.info(`Resource-pack injection cleanup: removed the launcher-injected ${PACK_NAME} pack from ${gameDir} (user packs untouched).`);
    }
  } catch (e) {
    logger.core.warn(`Resource-pack cleanup skipped for ${gameDir}: ${e.message}`);
  }
  return out;
}

/** Purge every instance + the shared global .minecraft (called at app start). */
function purgeAll() {
  const results = [];
  try {
    const { listInstances, instanceGameDir } = require('./store');
    for (const inst of listInstances()) {
      results.push({ target: `instance:${inst.name}`, ...purgeInjectedPack(instanceGameDir(inst.id)) });
    }
  } catch (e) { logger.core.warn('Resource-pack cleanup scan failed: ' + e.message); }
  try {
    const { DIRS } = require('./paths');
    results.push({ target: 'global', ...purgeInjectedPack(DIRS.minecraft) });
  } catch { /* paths unavailable (tests) */ }
  return { results };
}

module.exports = { purgeInjectedPack, purgeAll, removePackEntry, packFile, packExists, PACK_NAME, MARKER };
