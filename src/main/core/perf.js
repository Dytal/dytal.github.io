// perf.js — launcher resource governor (v4).
//
// WHY: on small machines (e.g. 400MB shared VRAM / 8GB RAM) the launcher must
// never compete with Minecraft for resources. While the game is running the
// whole launcher tree is dropped to BELOW NORMAL priority, so Windows schedules
// the game first; the launcher keeps rendering (UI + animations unaffected —
// it is mostly idle while the game owns the screen) but yields instantly
// whenever the game needs CPU. Everything is restored the moment the game exits.
'use strict';
const os = require('os');
const logger = require('./logger');

let lowered = false;

/** @param {boolean} running true when Minecraft is running */
function setGameRunning(running) {
  try {
    if (running && !lowered) {
      os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
      lowered = true;
      logger.core.info('perf: launcher deprioritized (below normal) while Minecraft is running');
    } else if (!running && lowered) {
      os.setPriority(os.constants.priority.PRIORITY_NORMAL);
      lowered = false;
      logger.core.info('perf: launcher priority restored (normal)');
    }
  } catch (e) {
    logger.core.debug('perf: priority change unavailable: ' + e.message);
  }
}

/** Best-effort V8 heap trim (fires after big UI operations). */
function trimMemory() {
  try { if (global.gc) global.gc(); } catch {}
}

module.exports = { setGameRunning, trimMemory };
