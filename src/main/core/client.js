// client.js — the Neurax CLIENT: injects the bundled NX core mod into every
// Fabric/Quilt launch. v1.0-R2 (owner request): ONLY Neurax's own mods are
// injected automatically. The third-party optimization stack (Sodium, Lithium,
// Iris, C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton, Dynamic
// FPS) is STRICTLY OPT-IN via Settings → "Extra optimization mods" — and even
// when enabled it is guarded:
//   • VulkanMod installed → the Sodium family (Sodium, Sodium Extra, Iris) is
//     skipped automatically — VulkanMod and Sodium are INCOMPATIBLE with each
//     other and crash when loaded together.
//   • a mod that already exists in the target mods folder (user-installed OR
//     previously injected) is NEVER injected twice.
// v1.0: the themed GUI RESOURCE PACK was removed entirely (owner request — the
// launcher never touches resource packs again); anything an old build injected
// is purged on sight.
//
// How injection works (verified against fabric-loader's own jar):
//   Fabric Loader reads the system property `fabric.addMods`
//   (net.fabricmc.loader.impl.discovery.ArgumentModCandidateFinder) and loads the
//   listed jars as extra mods ON TOP of the official game — no mods folder edits,
//   nothing touches the user's instances, uninstall = toggle off in Settings.
//   The launcher passes it through MCLC's `customArgs` (which land on the JVM
//   command line before -cp).
//
// The stack is resolved LIVE from the Modrinth API for the exact game version
// (1.21.11, 26.1.x, 26.2, 26.3 tested; future versions resolve automatically),
// cached for 7 days, sha1-verified, and NEVER blocks a launch: on any failure the
// game simply starts without the injected mods.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS } = require('./paths');
const settingsMod = require('./settings');
const logger = require('./logger');

const clientRoot = () => path.join(DIRS.root, 'client');
const modsRoot = () => path.join(clientRoot(), 'mods');
const stateRoot = () => path.join(clientRoot(), 'resolved');
const NX_SRC = path.join(__dirname, '..', 'nx');             // bundled NX core mod jar(s)

const RESOLVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check Modrinth weekly

// Bump whenever the MODS stack changes shape: cached resolve states that were
// written by an older stack version are invalid.
// v3 (launcher 1.0.0-R2): NX-only resolve states (+ the third-party opt-in),
// so every cache written by v2 is re-resolved under the new split.
const STACK_VERSION = 3;

// Versions the stack is CURATED + tested against. Resolution itself is
// version-agnostic — new game versions keep working automatically.
const SUPPORTED_VERSIONS = ['26.3', '26.2', '26.1.2', '26.1.1', '26.1', '1.21.11'];

/**
 * The curated stack. modes: which FPS modes include it (ONLY relevant when
 * the third-party stack is enabled in Settings — the NX core always runs).
 *  - balanced: the proven classics, maximum stability
 *  - ultra:    everything, including parallel chunk loading (C2ME)
 * Iris is in BOTH: it is what makes shaderpacks run on Fabric at all, and
 * Sodium-backed Iris is how shaders stay playable on integrated graphics.
 */
const MODS = [
  { slug: 'nx', name: 'NX', purpose: 'Neurax core v2: adaptive FPS engine (render distance, entities, particles) + frame metrics — zero renderer hooks', modes: ['balanced', 'ultra'], bundled: true },
  { slug: 'sodium', name: 'Sodium', purpose: 'Rewrites the renderer — the single biggest FPS gain', modes: ['balanced', 'ultra'] },
  { slug: 'lithium', name: 'Lithium', purpose: 'Optimizes game physics & tick logic (no gameplay changes)', modes: ['balanced', 'ultra'] },
  { slug: 'iris', name: 'Iris', purpose: 'Sodium-backed shader loader — shaders stay fast & playable', modes: ['balanced', 'ultra'] },
  { slug: 'fabric-api', name: 'Fabric API', purpose: 'Compatibility base required by Iris & most mods', modes: ['balanced', 'ultra'] },
  { slug: 'ferrite-core', name: 'FerriteCore', purpose: 'Cuts RAM usage dramatically', modes: ['balanced', 'ultra'] },
  { slug: 'immediatelyfast', name: 'ImmediatelyFast', purpose: 'Speeds up HUD / menu / entity immediate rendering', modes: ['balanced', 'ultra'] },
  { slug: 'entityculling', name: 'Entity Culling', purpose: 'Skips rendering entities you cannot see', modes: ['balanced', 'ultra'] },
  { slug: 'krypton', name: 'Krypton', purpose: 'Optimizes the Minecraft network stack', modes: ['balanced', 'ultra'] },
  { slug: 'dynamic-fps', name: 'Dynamic FPS', purpose: 'Reduces GPU load when the window is unfocused', modes: ['balanced', 'ultra'] },
  { slug: 'c2me-fabric', name: 'C2ME', purpose: 'Parallel world gen — much faster chunk loading', modes: ['ultra'] },
  { slug: 'sodium-extra', name: 'Sodium Extra', purpose: 'Extra Sodium video options (more FPS control)', modes: ['ultra'] },
];

// JVM flags — G1GC tuned like the well-known client flag sets: low pauses,
// steady frame times, no GC hiccups. Purely JVM-level: gameplay untouched.
const PERF_FLAGS = {
  balanced: [
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=40',
    '-XX:G1HeapRegionSize=16M',
    '-XX:+ParallelRefProcEnabled',
    '-XX:+DisableExplicitGC',
  ],
  ultra: [
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+UseG1GC',
    '-XX:G1NewSizePercent=20',
    '-XX:G1ReservePercent=20',
    '-XX:MaxGCPauseMillis=40',
    '-XX:G1HeapRegionSize=16M',
    '-XX:+ParallelRefProcEnabled',
    '-XX:+DisableExplicitGC',
    '-XX:MaxTenuringThreshold=1',
    '-XX:+PerfDisableSharedMem',
    '-XX:+UseStringDeduplication',
    '-XX:+AlwaysPreTouch',
  ],
};

/**
 * v1.0-R2 — VULKANMOD GUARD. VulkanMod replaces the renderer exactly like
 * Sodium does, and the two are INCOMPATIBLE with each other (loading both
 * hard-crashes Fabric). When VulkanMod is present in the target mods folder
 * the whole Sodium family below is skipped automatically — with a logged
 * reason — no matter what the Settings toggle says. Iris is Sodium-backed in
 * this stack, so it goes too.
 */
const VULKAN_INCOMPATIBLE = new Set(['sodium', 'sodium-extra', 'iris']);

function sha1OfFile(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function modsDirFor(gameVersion) {
  return path.join(modsRoot(), gameVersion);
}

/** Cached resolution state for one (version, mode). */
function stateFileFor(gameVersion, mode) {
  return path.join(stateRoot(), `${gameVersion}-${mode}.json`);
}

function readResolveState(gameVersion, mode) {
  const f = stateFileFor(gameVersion, mode);
  try {
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!st || !Array.isArray(st.mods)) return null;
    if (st.stackVersion !== STACK_VERSION) return null; // stack changed -> re-resolve
    return st;
  } catch { return null; }
}

function writeResolveState(gameVersion, mode, mods) {
  try {
    fs.mkdirSync(stateRoot(), { recursive: true });
    fs.writeFileSync(stateFileFor(gameVersion, mode), JSON.stringify({
      gameVersion, mode, resolvedAt: Date.now(), stackVersion: STACK_VERSION, mods,
    }, null, 2));
  } catch (e) { logger.client.warn('Could not persist client resolve state: ' + e.message); }
}

/* ---------------------------------------------------------------- v1.0-R2
   TARGET GUARDS — never inject a mod that is already in the target's mods
   folder, and never let Sodium meet VulkanMod. Both scans are pure filename
   checks: fast, offline, zero false promises about jar contents. */

/** Lowercase set of *.jar filenames in one mods directory (missing dir → empty). */
function modDirJars(dir) {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.jar$/i.test(f)) set.add(String(f).toLowerCase());
    }
  } catch { /* no mods dir yet */ }
  return set;
}

/** VulkanMod installed in ANY of the target dirs? (filename: vulkanmod*.jar) */
function hasVulkanMod(dirs) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.some((d) => {
    try { return fs.readdirSync(d).some((f) => /^vulkanmod[\w.-]*\.jar$/i.test(f)); }
    catch { return false; }
  });
}

/**
 * Filter a resolved stack for ONE target. Returns { mods, skipped, vulkanMod }:
 *  • a mod whose jar already exists in any target mods dir is skipped
 *    ("the same mods injected" — user-installed or previously injected)
 *  • when VulkanMod is present, the whole Sodium family is skipped with a
 *    logged reason (VulkanMod ⊕ Sodium — they crash when loaded together)
 * The bundled NX core is NEVER filtered out: it is Neurax's own mod, has no
 * renderer hooks and cannot clash with VulkanMod.
 */
function filterModsForTarget(mods, dirs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const present = new Set();
  for (const d of list) for (const f of modDirJars(d)) present.add(f);
  const vulkanMod = hasVulkanMod(list);
  const out = [];
  const skipped = [];
  for (const m of mods || []) {
    if (present.has(String(m.file || '').toLowerCase())) {
      skipped.push({ name: m.name, slug: m.slug, reason: 'already installed in this instance — never injected twice' });
      continue;
    }
    if (vulkanMod && VULKAN_INCOMPATIBLE.has(String(m.slug))) {
      skipped.push({ name: m.name, slug: m.slug, reason: 'VulkanMod is installed — Sodium-family mods are incompatible with it' });
      continue;
    }
    out.push(m);
  }
  return { mods: out, skipped, vulkanMod };
}

/** All cached files still present on disk? */
function filesPresent(mods) {
  return mods.length > 0 && mods.every(m => {
    try { return fs.statSync(m.path).isFile(); } catch { return false; }
  });
}

/**
 * The bundled NX core: ships with the launcher (src/main/nx/nx-<version>.jar),
 * needs no network and is version-scoped to 26.1.2 — its fabric.mod.json pins
 * minecraft >=26.1 <26.2, so it must ONLY ever be added for 26.1.x instances.
 */
function bundledNx(gameVersion) {
  if (gameVersion !== '26.1.2') return null;
  try {
    const file = fs.readdirSync(NX_SRC).find(f => /^nx-\d[\w.]*\.jar$/.test(f));
    if (!file) return null;
    const p = path.join(NX_SRC, file);
    if (!fs.existsSync(p)) return null;
    return {
      slug: 'nx', name: 'NX',
      purpose: 'Neurax core v2: adaptive FPS engine + frame metrics — zero renderer hooks',
      version: file.replace(/^nx-/, '').replace(/\.jar$/, ''),
      file, path: p, bundled: true,
    };
  } catch { return null; }
}

/**
 * Resolve (and cache) the mod stack for one game version + FPS mode.
 * v1.0-R2: `thirdParty` (default FALSE — the owner's rule) decides whether
 * the Sodium & friends stack is fetched at all; the NX core is ALWAYS the
 * first entry. NX-only results cache under their own `<mode>-nx` state file,
 * so toggling the opt-in never serves the wrong stack from cache.
 * Never throws: on hard failure returns { mods: [], injected: false, reason }.
 */
async function resolveStack({ gameVersion, fpsMode = 'ultra', thirdParty = false, force = false, onProgress = null } = {}) {
  const wanted = MODS.filter((m) => m.bundled || (thirdParty && m.modes.includes(fpsMode)));
  const cacheKey = thirdParty ? fpsMode : `${fpsMode}-nx`;
  if (!force) {
    const cached = readResolveState(gameVersion, cacheKey);
    if (cached && (Date.now() - cached.resolvedAt) < RESOLVE_TTL_MS && filesPresent(cached.mods)) {
      logger.client.debug(`client stack for ${gameVersion} (${cacheKey}) fresh from cache (${cached.mods.length} mods)`);
      return { gameVersion, fpsMode, thirdParty, mods: cached.mods, injected: true, fromCache: true };
    }
  }

  const modrinth = require('./modrinth');
  const { download } = require('./net');
  const dir = modsDirFor(gameVersion);
  fs.mkdirSync(dir, { recursive: true });
  logger.client.info(`Resolving client stack for ${gameVersion}: mode=${cacheKey} (${thirdParty ? 'NX core + third-party opt-in' : 'NX core ONLY — third-party stack is off'})`);

  const resolved = [];
  let done = 0;
  const nx = bundledNx(gameVersion);
  if (nx) resolved.push(nx); // bundled core first — no network, never fails
  for (const m of wanted) {
    if (m.bundled) { // NX was already pushed via bundledNx() — never fetch it from Modrinth
      done++;
      if (onProgress) { try { onProgress(done, wanted.length, m.name); } catch {} }
      continue;
    }
    try {
      const versions = await modrinth.getVersions(m.slug, { loaders: ['fabric'], gameVersions: [gameVersion] });
      const best = modrinth.pickBestVersion(versions, { loader: 'fabric', gameVersion });
      if (!best) {
        logger.client.info(`${m.name}: no Fabric build for ${gameVersion} — skipped (fine)`);
        continue;
      }
      const primary = best.files.find(f => f.primary) || best.files[0];
      if (!primary) continue;
      const dest = path.join(dir, primary.filename);
      if (!fs.existsSync(dest)) {
        await download(primary.url, dest, { tries: 2 });
      }
      // sha1 integrity — Modrinth publishes it for every file
      if (primary.hashes && primary.hashes.sha1) {
        const actual = sha1OfFile(dest);
        if (actual !== primary.hashes.sha1) {
          logger.client.warn(`${m.name}: sha1 mismatch — re-downloading once`);
          await download(primary.url, dest, { tries: 2 });
          if (sha1OfFile(dest) !== primary.hashes.sha1) {
            logger.client.error(`${m.name}: integrity check failed — skipped`);
            try { fs.rmSync(dest, { force: true }); } catch {}
            continue;
          }
        }
      }
      resolved.push({
        slug: m.slug, name: m.name, purpose: m.purpose,
        version: best.version_number, file: primary.filename, path: dest,
      });
    } catch (e) {
      logger.client.warn(`${m.name}: resolution failed (${e.message}) — skipped`);
    } finally {
      done++;
      if (onProgress) { try { onProgress(done, wanted.length, m.name); } catch {} }
    }
  }

  if (!resolved.length) {
    return { gameVersion, fpsMode, thirdParty, mods: [], injected: false, reason: 'No compatible builds could be resolved (offline?)' };
  }
  writeResolveState(gameVersion, cacheKey, resolved);
  logger.client.info(`Neurax Client stack resolved for ${gameVersion} (${cacheKey}): ${resolved.map(r => r.name).join(', ')}`);
  return { gameVersion, fpsMode, thirdParty, mods: resolved, injected: true, fromCache: false };
}

/** Build the -Dfabric.addMods=... JVM token from resolved mod paths. */
function fabricAddModsArg(mods) {
  if (!mods || !mods.length) return null;
  const paths = mods.map(m => m.path);
  return `-Dfabric.addMods=${paths.join(path.delimiter)}`;
}

/** JVM performance flags for a mode (safe on every loader — pure JVM level). */
function perfJvmArgs(fpsMode = 'ultra') {
  return [...(PERF_FLAGS[fpsMode] || PERF_FLAGS.ultra)];
}

// ---------------------------------------------------------------------------
// v1.0 — RESOURCE PACKS: the launcher NEVER injects any. Old builds shipped a
// themed "neurax-ui-<theme>" pack; purgeGuiThemePacks() deletes those folders
// and their options.txt entries wherever they are found (idempotent, safe).
// ---------------------------------------------------------------------------

/** Delete every neurax-ui-* pack folder + its options.txt entry from a game dir. */
function purgeGuiThemePacks(gameDir) {
  const out = { removedDirs: 0, cleanedOptions: false };
  try {
    if (!gameDir) return out;
    const rpDir = path.join(gameDir, 'resourcepacks');
    for (const d of fs.readdirSync(rpDir)) {
      if (String(d).startsWith('neurax-ui-')) {
        try { fs.rmSync(path.join(rpDir, d), { recursive: true, force: true }); out.removedDirs++; } catch {}
      }
    }
  } catch { /* no resourcepacks dir — nothing to purge */ }
  try { removeNeuraxPacksFromOptions(gameDir); out.cleanedOptions = true; } catch { /* no options.txt */ }
  if (out.removedDirs) logger.client.info(`Removed ${out.removedDirs} legacy neurax-ui pack folder(s) from ${gameDir} — resource-pack injection is gone.`);
  return out;
}

function setOptionLines(gameDir, pairs) {
  const optFile = path.join(gameDir, 'options.txt');
  let lines = [];
  if (fs.existsSync(optFile)) {
    lines = fs.readFileSync(optFile, 'utf8').split(/\r?\n/);
  }
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex(l => l.startsWith(k + ':'));
    if (i >= 0) lines[i] = `${k}:${v}`; else lines.push(`${k}:${v}`);
  }
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(optFile, lines.filter(l => l !== '').join('\n') + '\n');
}

/** Read current option values (or null) without creating the file. */
function getOptionLines(gameDir, keys) {
  const optFile = path.join(gameDir, 'options.txt');
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(optFile, 'utf8').split(/\r?\n/); } catch { return out; }
  for (const k of keys) {
    const line = lines.find(l => l.startsWith(k + ':'));
    out[k] = line ? line.slice(k.length + 1).trim() : null;
  }
  return out;
}

/**
 * One-call launch preparation (v1.0-R2 — NX MODS ONLY by default).
 * NEVER throws, NEVER blocks: any failure degrades to "launch without that
 * piece" and is logged. Also purges legacy theme packs from the game dir.
 * Returns { customArgs, addModsArg, mods, skipped, thirdParty }.
 */
async function prepareLaunch({ gameDir, gameVersion, loader, instanceManaged = false, onProgress = null } = {}) {
  const set = settingsMod.get();
  const fpsMode = set.clientFpsMode === 'balanced' ? 'balanced' : 'ultra';
  const thirdParty = set.clientThirdPartyMods === true; // owner rule: Sodium & friends are OPT-IN, never automatic
  const out = { customArgs: perfJvmArgs(fpsMode), addModsArg: null, mods: [], skipped: [], thirdParty };

  // 0. purge any theme packs an old build injected (one quick pass per launch)
  try { purgeGuiThemePacks(gameDir); } catch { /* best effort */ }

  // Mod injection — Fabric/Quilt only (fabric.addMods is a Fabric-Loader feature)
  const injectable = loader === 'fabric' || loader === 'quilt';
  if (!injectable) return out;
  if (set.neuraxClient === false) return out;
  // Instance-managed stack: the mods already live in <gameDir>/mods (v2.3.1
  // instance injection). Adding them AGAIN via -Dfabric.addMods would make
  // Fabric see every jar twice — skip, the mods folder does the job.
  if (instanceManaged) {
    logger.client.debug('Client stack is instance-managed (mods folder) — launch-time addMods skipped');
    return out;
  }

  try {
    const r = await resolveStack({ gameVersion, fpsMode, thirdParty, onProgress });
    if (r.injected && r.mods.length) {
      // target guards: never double-inject, never Sodium+VulkanMod
      const f = filterModsForTarget(r.mods, gameDir ? [path.join(gameDir, 'mods')] : []);
      for (const s of f.skipped) logger.client.info(`Client injection: ${s.name} skipped — ${s.reason}`);
      if (f.mods.length) {
        out.mods = f.mods;
        out.skipped = f.skipped;
        out.addModsArg = fabricAddModsArg(f.mods);
      } else {
        out.skipped = f.skipped;
        logger.client.warn('Client injection skipped: every resolved mod is already present in the target mods folder.');
      }
    } else {
      logger.client.warn(`Client injection skipped: ${r.reason || 'nothing resolved'}`);
    }
  } catch (e) {
    logger.client.warn('Client injection skipped: ' + e.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// INSTANCE INJECTION (v2.3.1) — the Neurax Client written INTO the instances
// themselves, not just passed at launch time. For every instance whose game
// version is in INSTANCE_SCOPE the launcher now:
//   1. layers the Fabric Loader profile onto the game (vanilla instances are
//      upgraded: they launch the MODDED jar chain instead of the official one,
//      exactly like a "launcher + client" should — reversible via uninject)
//   2. copies the curated optimization mods into <instance>/.minecraft/mods/
//      as MANAGED files (tracked in a manifest — user mods are never touched)
//   3. (v1.0 — GUI resource packs REMOVED; old ones are purged instead)
//   4. records everything in <instance>/.minecraft/neurax-client.json
// Runs automatically for ALL existing instances at launcher start
// (migrateInstances) and for every NEW 26.1.2 instance at creation
// (hooked in store.createInstance). Launch-time addMods stays as the
// fallback for out-of-scope fabric/quilt instances.
// ---------------------------------------------------------------------------

/** Rollout scope: which game versions get instance-level injection. */
const INSTANCE_SCOPE = ['26.1.2']; // user-directed: 26.1.2 first, more versions later
const INJECTOR_VERSION = 3;        // v3 (launcher 1.0.0): GUI pack REMOVED — re-inject once to purge old packs + refresh the stack

let broadcast = () => {};
function setBroadcaster(fn) { broadcast = (channel, payload) => { try { fn(channel, payload); } catch {} }; }

// store.js hooks back into injectInstance on create/update — keep the require
// lazy so the two modules never form a load-order cycle.
function storeMod() { return require('./store'); }

// single-flight per instance: creation hook + migration + manual re-inject
// can all race; they must collapse into ONE physical injection.
const inflight = new Map();
function injectInstance(opts = {}) {
  const key = opts.instanceId || (opts.instance && opts.instance.id);
  if (!key) return Promise.resolve({ ok: false, reason: 'no-instance' });
  if (inflight.has(key)) return inflight.get(key);
  const p = injectInstanceInner(opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function manifestPath(gameDir) { return path.join(gameDir, 'neurax-client.json'); }
function readManifest(gameDir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(gameDir), 'utf8')); } catch { return null; }
}
function writeManifest(gameDir, data) {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(manifestPath(gameDir), JSON.stringify(data, null, 2));
}

/** The instance's injection manifest — SYNC (used by the launch pipeline). */
function instanceManifest(instance) {
  if (!instance || !INSTANCE_SCOPE.includes(instance.version)) return null;
  try { return readManifest(storeMod().instanceGameDir(instance.id)); } catch { return null; }
}

/** True when the instance's mods folder carries launcher-managed mods. */
function hasManagedMods(instance) {
  const m = instanceManifest(instance);
  return !!(m && Array.isArray(m.mods) && m.mods.length > 0);
}

/** Fabric profile JSON on disk? Install it (cached: no network if present). */
async function ensureFabricProfile(mcVersion, loaderVersion) {
  const root = DIRS.minecraft;
  const vid = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const prof = path.join(root, 'versions', vid, `${vid}.json`);
  if (fs.existsSync(prof)) return vid;
  return require('./versions').installFabricClient(root, mcVersion, loaderVersion);
}

/** Remove every neurax-ui-* pack from the options.txt resourcePacks list. */
function removeNeuraxPacksFromOptions(gameDir) {
  const optFile = path.join(gameDir, 'options.txt');
  if (!fs.existsSync(optFile)) return;
  const lines = fs.readFileSync(optFile, 'utf8').split(/\r?\n/);
  const idx = lines.findIndex(l => l.startsWith('resourcePacks:'));
  if (idx < 0) return;
  let packs;
  try { packs = JSON.parse(lines[idx].slice('resourcePacks:'.length).trim()); } catch { return; }
  if (!Array.isArray(packs)) return;
  const next = packs.filter(p => !String(p).startsWith('file/neurax-ui-'));
  if (next.length === packs.length) return;
  lines[idx] = 'resourcePacks:' + JSON.stringify(next);
  fs.writeFileSync(optFile, lines.filter(l => l !== '').join('\n') + '\n');
}

/**
 * Inject the Neurax Client INTO one instance. Idempotent, single-flight,
 * NEVER throws. Steps: legacy pack purge -> Fabric loader layer ->
 * managed mods (cached after first resolve). Skipped cleanly for
 * out-of-scope versions, disabled settings, and forge/neoforge mods
 * (those get the GUI pack only — Fabric jars can't load there).
 */
async function injectInstanceInner({ instanceId, instance: instRef, force = false, onProgress = null, source = 'manual' } = {}) {
  const store = storeMod();
  const instance = instRef || store.getInstance(instanceId);
  if (!instance) return { ok: false, skipped: true, reason: 'Instance not found.' };
  const set = settingsMod.get();

  const emit = (stage, detail) => broadcast('client:inject-progress', {
    instanceId: instance.id, instance: instance.name, stage, detail,
  });

  if (!INSTANCE_SCOPE.includes(instance.version)) {
    return { ok: false, skipped: true, instance: instance.name, instanceId: instance.id,
      reason: `Neurax Client instance injection currently targets ${INSTANCE_SCOPE.join(', ')} — ${instance.version} is not in scope yet.` };
  }
  if (set.neuraxClient === false) {
    return { ok: false, skipped: true, instance: instance.name, instanceId: instance.id, reason: 'Neurax Client is disabled in Settings.' };
  }

  const fpsMode = set.clientFpsMode === 'balanced' ? 'balanced' : 'ultra';
  const thirdParty = set.clientThirdPartyMods === true; // owner rule: Sodium & friends are OPT-IN
  const gameDir = store.instanceGameDir(instance.id);

  // freshness: same injector version + same mode + same third-party choice +
  // files intact. modsExpected=false (forge/neoforge) instances are fresh with
  // an EMPTY mod list — they only get the loader layer, so re-injecting them
  // forever would make every migration churn.
  const manifest = readManifest(gameDir);
  const modsOk = (m) => Array.isArray(m.mods) && (m.modsExpected === false
    ? m.mods.length === 0
    : m.mods.length > 0 && m.mods.every(x => { try { return fs.statSync(path.join(m.modsDir, x.file)).isFile(); } catch { return false; } }));
  const fresh = !force && manifest && manifest.injectorVersion === INJECTOR_VERSION
    && manifest.fpsMode === fpsMode && manifest.thirdParty === thirdParty && modsOk(manifest);
  if (fresh) {
    logger.client.debug(`Instance "${instance.name}" already injected (v${manifest.injectorVersion}) — nothing to do`);
    return { ok: true, already: true, instance: instance.name, instanceId: instance.id,
      mods: manifest.mods.length, loader: manifest.loader };
  }

  logger.client.info(`Injecting Neurax Client into instance "${instance.name}" (${instance.version}, ${instance.loader})…`);
  emit('start', `Injecting Neurax Client into ${instance.name}…`);
  const result = { ok: true, already: false, instance: instance.name, instanceId: instance.id, source };

  // ---- 1. resource packs: PURGE legacy theme packs (v1.0 — none are injected) ----
  try { purgeGuiThemePacks(gameDir); } catch { /* best effort */ }

  // ---- 1.5 perf options sync — the real FPS ceiling unlock ----------------
  // maxFps:260 IS vanilla's "Unlimited"; vsync off removes the 60Hz brake.
  // Originals are remembered in the manifest and restored on uninject (or on
  // switching back to balanced).
  try {
    if (fpsMode === 'ultra') {
      result.perfPrev = getOptionLines(gameDir, ['maxFps', 'enableVsync']);
      setOptionLines(gameDir, { maxFps: 260, enableVsync: 'false' });
      result.perfOptions = { maxFps: 260, vsync: false };
    } else if (manifest && manifest.perf && manifest.perf.prevMaxFps != null) {
      setOptionLines(gameDir, { maxFps: manifest.perf.prevMaxFps, enableVsync: manifest.perf.prevVsync ?? 'true' });
      result.perfRestored = true;
    }
  } catch (e) {
    logger.client.warn(`Perf options sync skipped for "${instance.name}": ${e.message}`);
  }

  // ---- 2. Fabric loader layer ---------------------------------------------
  // vanilla -> UPGRADED to fabric (the modded jar chain replaces the official
  // launch); fabric keeps its pinned loaderVersion; quilt already loads mods
  // from mods/; forge/neoforge must stay untouched (incompatible mod loader).
  const loader = instance.loader || 'vanilla';
  const fabricCompatible = ['vanilla', 'fabric', 'quilt'].includes(loader);
  result.loader = loader;
  let loaderChanged = false;
  let loaderVersion = instance.loaderVersion || null;
  if (loader === 'vanilla') {
    try {
      emit('loader', 'Layering Fabric Loader onto the instance…');
      if (!loaderVersion) {
        const lvList = await require('./versions').getFabricLoaderVersions(instance.version);
        loaderVersion = (lvList && lvList[0] && lvList[0].loader) || null;
      }
      if (!loaderVersion) throw new Error('no Fabric loader version available');
      await ensureFabricProfile(instance.version, loaderVersion);
      store.updateInstance(instance.id, { loader: 'fabric', loaderVersion });
      loaderChanged = true;
      result.loader = 'fabric';
      result.loaderVersion = loaderVersion;
      logger.client.info(`Instance "${instance.name}" upgraded vanilla -> fabric (${loaderVersion})`);
    } catch (e) {
      logger.client.warn(`Fabric layer skipped for "${instance.name}": ${e.message}`);
      result.loaderWarning = `Fabric layer not installed: ${e.message}`;
    }
  } else if (loader === 'fabric' && loaderVersion) {
    try { await ensureFabricProfile(instance.version, loaderVersion); } catch (e) {
      logger.client.warn(`Fabric profile refresh skipped for "${instance.name}": ${e.message}`);
    }
  }

  // ---- 3. managed mods into <gameDir>/mods --------------------------------
  let managed = [];
  if (fabricCompatible) {
    try {
      emit('mods', thirdParty
        ? 'Resolving the NX core + the extra optimization stack…'
        : 'Resolving the NX core mod…');
      const r = await resolveStack({ gameVersion: instance.version, fpsMode, thirdParty, onProgress });
      if (r.injected && r.mods.length) {
        const modsDir = path.join(gameDir, 'mods');
        fs.mkdirSync(modsDir, { recursive: true });
        // target guards: never double-inject, never Sodium+VulkanMod
        const f = filterModsForTarget(r.mods, [modsDir]);
        for (const s of f.skipped) {
          logger.client.info(`Instance "${instance.name}": ${s.name} skipped — ${s.reason}`);
        }
        result.skipped = f.skipped;
        // drop previously-managed files that are no longer part of the FINAL
        // stack (e.g. the third-party opt-in was switched off — the mods we
        // injected for it are un-injected; user-installed jars never match a
        // managed manifest entry, so they are always untouched)
        for (const old of (manifest && Array.isArray(manifest.mods) ? manifest.mods : [])) {
          if (!f.mods.some(m => m.file === old.file)) {
            try { fs.rmSync(path.join(modsDir, old.file), { force: true }); } catch {}
          }
        }
        for (const m of f.mods) {
          const dest = path.join(modsDir, m.file);
          if (!fs.existsSync(dest)) fs.copyFileSync(m.path, dest);
        }
        managed = f.mods.map(m => ({ slug: m.slug, name: m.name, version: m.version, file: m.file }));
        result.mods = managed.length;
        result.modList = managed;
        emit('mods', thirdParty
          ? `${managed.length} mods (NX core + extras) installed into ${instance.name}`
          : `NX core installed into ${instance.name} (third-party stack is off)`);
      } else {
        result.modsWarning = r.reason || 'No compatible mods resolved — nothing was injected.';
        logger.client.warn(`Mod injection for "${instance.name}" skipped: ${result.modsWarning}`);
      }
    } catch (e) {
      result.modsWarning = e.message;
      logger.client.warn(`Mod injection for "${instance.name}" failed: ${e.message}`);
    }
  } else if (loader === 'forge' || loader === 'neoforge') {
    result.modsWarning = 'Forge/NeoForge instance — Fabric mods cannot load here; perf options still apply.';
  }

  // ---- 4. manifest + instance metadata ------------------------------------
  const manifestOut = {
    injectorVersion: INJECTOR_VERSION,
    instanceId: instance.id,
    gameVersion: instance.version,
    loader: result.loader || loader,
    loaderVersion: loaderVersion || (loaderChanged ? result.loaderVersion : instance.loaderVersion),
    baseLoader: (manifest && manifest.baseLoader) || loader, // remember what the user picked
    loaderChanged: loaderChanged || !!(manifest && manifest.loaderChanged),
    fpsMode,
    thirdParty,                       // v1.0-R2 — re-inject when the opt-in flips
    skipped: result.skipped || [],    // guard decisions kept for the Status UI
    perf: result.perfOptions ? {
      maxFps: 260, vsync: false,
      prevMaxFps: result.perfPrev ? result.perfPrev.maxFps : null,
      prevVsync: result.perfPrev ? result.perfPrev.enableVsync : null,
    } : null,
    modsExpected: fabricCompatible, // false = forge/neoforge: empty mods is the steady state
    modsDir: path.join(gameDir, 'mods'),
    mods: managed.length ? managed : ((manifest && manifest.mods) || []),
    injectedAt: Date.now(),
  };
  writeManifest(gameDir, manifestOut);
  store.updateInstance(instance.id, {
    neuraxClient: {
      injected: true,
      at: manifestOut.injectedAt,
      mods: manifestOut.mods.length,
      loader: manifestOut.loader,
      loaderVersion: manifestOut.loaderVersion,
      baseLoader: manifestOut.baseLoader,
    },
  });

  broadcast('client:injected', {
    instanceId: instance.id, instance: instance.name, ok: true, already: false,
    mods: manifestOut.mods.length, loader: manifestOut.loader, source,
  });
  logger.client.info(`Neurax Client injected into "${instance.name}": ${manifestOut.mods.length} mods (loader ${manifestOut.loader})`);
  return result;
}

/**
 * Remove the Neurax Client from an instance: managed mods deleted (user mods
 * stay), GUI pack removed, options.txt cleaned, vanilla loader restored if we
 * upgraded it, manifest deleted. Never throws.
 */
async function uninjectInstance({ instanceId } = {}) {
  const store = storeMod();
  const instance = store.getInstance(instanceId);
  if (!instance) return { ok: false, reason: 'Instance not found.' };
  const gameDir = store.instanceGameDir(instance.id);
  const manifest = readManifest(gameDir);
  let removedMods = 0;

  if (manifest) {
    if (Array.isArray(manifest.mods) && manifest.modsDir) {
      for (const m of manifest.mods) {
        try { fs.rmSync(path.join(manifest.modsDir, m.file), { force: true }); removedMods++; } catch {}
      }
    }
    try { fs.rmSync(manifestPath(gameDir), { force: true }); } catch {}
  }
  // remove every neurax-ui-* pack folder + options.txt entry
  try {
    const rpDir = path.join(gameDir, 'resourcepacks');
    for (const d of fs.readdirSync(rpDir)) {
      if (d.startsWith('neurax-ui-')) fs.rmSync(path.join(rpDir, d), { recursive: true, force: true });
    }
  } catch {}
  try { removeNeuraxPacksFromOptions(gameDir); } catch {}

  // restore the original maxFps / vsync if the NX perf sync touched them
  if (manifest && manifest.perf && manifest.perf.prevMaxFps != null) {
    try {
      setOptionLines(gameDir, { maxFps: manifest.perf.prevMaxFps, enableVsync: manifest.perf.prevVsync ?? 'true' });
    } catch {}
  }

  // restore the loader the user originally picked (we upgraded vanilla -> fabric)
  if (manifest && manifest.loaderChanged && manifest.baseLoader === 'vanilla') {
    store.updateInstance(instance.id, { loader: 'vanilla', loaderVersion: null });
  }
  store.updateInstance(instance.id, { neuraxClient: null });
  logger.client.info(`Neurax Client removed from "${instance.name}" (${removedMods} managed mods deleted)`);
  return { ok: true, instance: instance.name, removedMods };
}

/**
 * Startup migration: inject EVERY existing instance whose version is in
 * scope. Sequential + single-flight + never throws. Broadcasts ONE summary.
 */
async function migrateInstances({ force = false } = {}) {
  const store = storeMod();
  const targets = store.listInstances().filter(i => INSTANCE_SCOPE.includes(i.version));
  if (!targets.length) return { scope: INSTANCE_SCOPE, targets: 0, injected: 0, results: [] };
  logger.client.info(`Neurax Client instance migration: ${targets.length} instance(s) in scope [${INSTANCE_SCOPE.join(', ')}]`);
  const results = [];
  for (const inst of targets) {
    try { results.push(await injectInstance({ instanceId: inst.id, force, source: 'migration' })); }
    catch (e) { results.push({ ok: false, instance: inst.name, instanceId: inst.id, reason: e.message }); }
  }
  const injected = results.filter(r => r.ok && !r.already).length;
  broadcast('client:injected', {
    migrated: true, injected, total: targets.length,
    summary: results.map(r => ({ instance: r.instance, ok: r.ok, already: !!r.already, mods: r.mods || 0 })),
  });
  return { scope: INSTANCE_SCOPE, targets: targets.length, injected, results };
}

/** Fire-and-forget catch-up used by the launch pipeline (never awaited). */
function syncInstance(instance) {
  if (!instance || !INSTANCE_SCOPE.includes(instance.version)) return;
  if (settingsMod.get().neuraxClient === false) return;
  injectInstance({ instanceId: instance.id, source: 'launch' }).catch((e) =>
    logger.client.warn(`Background injection for "${instance.name}" failed: ${e.message}`));
}

/** Status for the Settings UI. */
function status() {
  const cached = [];
  try {
    for (const f of fs.readdirSync(stateRoot())) {
      if (!f.endsWith('.json')) continue;
      try {
        const st = JSON.parse(fs.readFileSync(path.join(stateRoot(), f), 'utf8'));
        if (st && Array.isArray(st.mods)) {
          cached.push({
            gameVersion: st.gameVersion, mode: st.mode, resolvedAt: st.resolvedAt,
            mods: st.mods.map(m => ({ name: m.name, version: m.version, file: m.file })),
          });
        }
      } catch {}
    }
  } catch {}
  // per-instance injection summary (in-scope instances only)
  let instances = [];
  try {
    instances = storeMod().listInstances()
      .filter(i => INSTANCE_SCOPE.includes(i.version))
      .map(i => ({
        id: i.id, name: i.name, version: i.version, loader: i.loader,
        injected: !!(i.neuraxClient && i.neuraxClient.injected),
        mods: i.neuraxClient ? i.neuraxClient.mods : 0,
        at: i.neuraxClient ? i.neuraxClient.at : null,
      }));
  } catch {}
  return {
    supportedVersions: SUPPORTED_VERSIONS,
    instanceScope: INSTANCE_SCOPE,
    injectorVersion: INJECTOR_VERSION,
    nx: bundledNx('26.1.2') ? { version: bundledNx('26.1.2').version, file: bundledNx('26.1.2').file } : null,
    stack: MODS.map(m => ({ slug: m.slug, name: m.name, purpose: m.purpose, modes: m.modes, bundled: !!m.bundled })),
    // v1.0-R2 — the owner's injection rule, surfaced for the Settings UI:
    injectionRule: {
      nxAlways: true,                       // the bundled NX core is always injected
      thirdPartyDefault: false,              // Sodium & friends are OPT-IN (default OFF)
      vulkanGuard: [...VULKAN_INCOMPATIBLE], // auto-skipped when VulkanMod is installed
      noDuplicates: true,                   // a mod already in the target is never injected twice
    },
    cached,
    instances,
  };
}

/** Forget resolved stacks (mods stay on disk; next launch re-resolves). */
function clearResolveCache() {
  try { fs.rmSync(stateRoot(), { recursive: true, force: true }); } catch {}
  logger.client.info('Client resolve cache cleared.');
  return true;
}

module.exports = {
  SUPPORTED_VERSIONS, INSTANCE_SCOPE, INJECTOR_VERSION, MODS, PERF_FLAGS, STACK_VERSION,
  VULKAN_INCOMPATIBLE,
  resolveStack, fabricAddModsArg, perfJvmArgs, prepareLaunch,
  modDirJars, hasVulkanMod, filterModsForTarget,
  purgeGuiThemePacks,
  setOptionLines, getOptionLines, bundledNx,
  injectInstance, uninjectInstance, migrateInstances, syncInstance,
  instanceManifest, hasManagedMods, removeNeuraxPacksFromOptions,
  setBroadcaster,
  status, clearResolveCache,
};
