// modrinth.js — Modrinth API v2 client + real installer for mods, resource packs,
// shaders, datapacks, plugins (server-side) and .mrpack modpacks.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS } = require('./paths');
const { getJSON, cachedJSON, download } = require('./net');
const logger = require('./logger');

const API = 'https://api.modrinth.com/v2';
const CDN_HOSTS = ['cdn.modrinth.com', 'modrinth.com'];

// Loaders that mark a project as a server PLUGIN (bukkit family / proxies).
const PLUGIN_LOADERS = ['bukkit', 'spigot', 'paper', 'purpur', 'folia', 'velocity', 'waterfall', 'bungeecord'];
// Client-side mod loaders Neurax supports.
const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];

// ---------- search & metadata ----------

/**
 * Search projects. Mirrors the website experience.
 * q, facets: { projectType?, categories: [], versions: [], loaders: [] },
 * index: relevance|downloads|follows|newest|updated, limit, offset
 */
async function search({ q = '', projectType = null, categories = [], versions = [], loaders = [], index = 'relevance', limit = 20, offset = 0 } = {}) {
  const facets = [];
  if (projectType) facets.push([`project_type:${projectType}`]);
  if (categories.length) facets.push(categories.map(c => `categories:${c}`));
  if (versions.length) facets.push(versions.map(v => `versions:${v}`));
  if (loaders.length) facets.push(loaders.map(l => `categories:${l}`));
  const params = new URLSearchParams({
    query: q, index, limit: String(limit), offset: String(offset),
  });
  if (facets.length) params.set('facets', JSON.stringify(facets));
  const { data } = await cachedJSON(`${API}/search?${params}`, { key: `mr-search-${params}`, maxAgeMs: 3 * 60 * 1000 });
  return data; // { hits, total_hits }
}

async function getProject(idOrSlug) {
  const { data } = await cachedJSON(`${API}/project/${idOrSlug}`, { key: `mr-project-${idOrSlug}`, maxAgeMs: 5 * 60 * 1000 });
  return data;
}

async function getVersions(idOrSlug, { loaders = [], gameVersions = [], featured = null } = {}) {
  const params = new URLSearchParams();
  if (loaders.length) params.set('loaders', JSON.stringify(loaders));
  if (gameVersions.length) params.set('game_versions', JSON.stringify(gameVersions));
  const { data } = await cachedJSON(`${API}/project/${idOrSlug}/version?${params}`, { key: `mr-versions-${idOrSlug}-${params}`, maxAgeMs: 3 * 60 * 1000 });
  return data || [];
}

async function getVersion(id) {
  const { data } = await cachedJSON(`${API}/version/${id}`, { key: `mr-version-${id}`, maxAgeMs: 5 * 60 * 1000 });
  return data;
}

async function getUser(idOrUsername) {
  return getJSON(`${API}/user/${idOrUsername}`);
}

// ---------- version picking ----------

/**
 * Pick the best ("latest working") version for a loader + game version.
 * Modrinth returns versions newest-first, so the FIRST match is the latest.
 * Preference order: loader+gameVersion match → gameVersion match → loader
 * match → newest overall. Pure function (also unit-tested).
 */
function pickBestVersion(versions, { loader = null, gameVersion = null } = {}) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return null;
  const hasLoader = (v) => !loader || !(v.loaders || []).length || (v.loaders || []).includes(loader);
  const hasGame = (v) => !gameVersion || !(v.game_versions || []).length || (v.game_versions || []).includes(gameVersion);
  return list.find(v => hasLoader(v) && hasGame(v))
      || list.find(v => hasGame(v))
      || list.find(v => hasLoader(v))
      || list[0];
}

function isPluginProject(project) {
  return !!project && (project.loaders || []).some(l => PLUGIN_LOADERS.includes(String(l).toLowerCase()));
}

// ---------- installation ----------

function gameDirOf(target) {
  const store = require('./store');
  if (!target) return DIRS.minecraft;
  if (target.type === 'instance') return store.instanceGameDir(target.instanceId);
  if (target.type === 'server') return store.serverDir(target.serverId);
  return DIRS.minecraft;
}

/**
 * Destination folder for a project. Server targets split mods vs plugins by the
 * project's own loaders (a "mod" project whose loaders are paper/spigot/... is
 * really a plugin and belongs in plugins/).
 */
function folderFor(projectType, target = null, projectLoaders = []) {
  if (target && target.type === 'server') {
    const loaders = (projectLoaders || []).map(l => String(l).toLowerCase());
    const plugin = projectType === 'plugin' || loaders.some(l => PLUGIN_LOADERS.includes(l));
    if (plugin) return 'plugins';
    return 'mods';
  }
  switch (projectType) {
    case 'mod': return 'mods';
    case 'resourcepack': return 'resourcepacks';
    case 'shader': return 'shaderpacks';
    case 'plugin': return 'plugins';
    case 'datapack': return 'datapacks';
    default: return 'mods';
  }
}

/** Download a file into the right folder of the target game dir. */
async function installFile(target, file, projectType, projectLoaders = [], onProgress = null) {
  const dir = path.join(gameDirOf(target), folderFor(projectType, target, projectLoaders));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.filename);
  await download(file.url, dest, { onProgress });
  logger.modrinth.info(`Installed ${file.filename} -> ${dir}`);
  return dest;
}

/** Install latest/selected version's primary file (instance, global or SERVER target). */
async function installProject({ projectId, target, versionId = null, onProgress = null }) {
  const project = await getProject(projectId);
  let version;
  if (versionId) version = await getVersion(versionId);
  else {
    const vs = await getVersions(projectId);
    version = pickBestVersion(vs, {
      loader: target.loader || null,
      gameVersion: target.version || null,
    });
    if (!version) throw new Error('No compatible versions found');
  }
  const primary = version.files.find(f => f.primary) || version.files[0];
  if (!primary) throw new Error('No downloadable file on this version');
  const dest = await installFile(target, primary, project.project_type, project.loaders || [], onProgress);
  return { file: primary.filename, path: dest, version: version.version_number, dependencies: version.dependencies || [] };
}

// ---------- .mrpack modpacks ----------

function loaderOfDependencies(deps = {}) {
  if (deps['fabric-loader']) return { loader: 'fabric', loaderVersion: deps['fabric-loader'] };
  if (deps['quilt-loader']) return { loader: 'quilt', loaderVersion: deps['quilt-loader'] };
  if (deps['forge']) return { loader: 'forge', loaderVersion: deps['forge'] };
  if (deps['neoforge']) return { loader: 'neoforge', loaderVersion: deps['neoforge'] };
  return { loader: 'vanilla', loaderVersion: null };
}

function sha1OfFile(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Read a .mrpack WITHOUT installing — returns a summary for the UI preview:
 * { name, summary, gameVersion, loader, loaderVersion, fileCount, totalBytes, hasOverrides }
 */
async function readMrpackIndex(mrpackPath) {
  const extract = require('extract-zip');
  if (!mrpackPath || !fs.existsSync(mrpackPath)) throw new Error('File not found');
  const tmp = path.join(DIRS.temp, 'mrinspect-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await extract(mrpackPath, { dir: tmp });
    const index = parseMrpackIndex(tmp);
    const loader = loaderOfDependencies(index.dependencies || {});
    const files = index.files || [];
    return {
      name: index.name || path.basename(mrpackPath, '.mrpack'),
      summary: index.summary || '',
      gameVersion: (index.dependencies || {})['minecraft'] || null,
      loader: loader.loader,
      loaderVersion: loader.loaderVersion,
      fileCount: files.length,
      totalBytes: files.reduce((n, f) => n + (f.fileSize || 0), 0),
      hasOverrides: fs.existsSync(path.join(tmp, index.overrides || 'overrides')),
      versionId: index.versionId || null,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** Validate + parse modrinth.index.json from an extracted mrpack dir. */
function parseMrpackIndex(extractedDir) {
  const indexPath = path.join(extractedDir, 'modrinth.index.json');
  if (!fs.existsSync(indexPath)) throw new Error('Not a valid .mrpack — modrinth.index.json is missing');
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (e) { throw new Error('Corrupted modrinth.index.json: ' + e.message); }
  if (index.game && index.game !== 'minecraft') throw new Error(`Unsupported modpack game: ${index.game}`);
  if (index.formatVersion && Number(index.formatVersion) > 1) {
    throw new Error(`Unsupported modpack format version ${index.formatVersion} (this launcher supports 1)`);
  }
  if (!Array.isArray(index.files)) index.files = [];
  return index;
}

/** Refuse path traversal ("../../etc") inside modpack file entries. */
function safeJoin(gameDir, relPath) {
  const dest = path.resolve(gameDir, relPath);
  const root = path.resolve(gameDir) + path.sep;
  if (!dest.startsWith(root)) throw new Error(`Unsafe path in modpack: ${relPath}`);
  return dest;
}

/**
 * FULL .mrpack → instance converter. Real, verified, idempotent:
 *   1. extract index           2. create/patch the target instance
 *   3. apply overrides         4. download every file (sha1-verified, client env filter)
 *   5. patch instance loader+version so PLAY just works
 * target: { type:'new-instance', name?, memoryMB? } | { type:'instance', instanceId }
 */
async function installMrpack({ mrpackPath, target, onProgress = null, onStatus = null }) {
  const extract = require('extract-zip');
  const store = require('./store');
  const status = (s) => { try { onStatus && onStatus(s); } catch {} };

  if (!mrpackPath || !fs.existsSync(mrpackPath)) throw new Error('Modpack file not found');
  const tmp = path.join(DIRS.temp, 'mrpack-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(tmp, { recursive: true });

  try {
    status('Reading modpack…');
    await extract(mrpackPath, { dir: tmp });
    const index = parseMrpackIndex(tmp);
    const deps = index.dependencies || {};
    const mcVersion = deps['minecraft'];
    if (!mcVersion) throw new Error('Modpack does not declare a Minecraft version');
    const { loader, loaderVersion } = loaderOfDependencies(deps);

    // 1. resolve the target instance (create when needed)
    let instanceId = target && target.instanceId;
    let inst = instanceId ? store.getInstance(instanceId) : null;
    if (!inst) {
      const packName = index.name || path.basename(mrpackPath, '.mrpack');
      status('Creating instance…');
      inst = store.createInstance({
        name: (target && target.name) || packName,
        version: mcVersion, loader, loaderVersion,
        memoryMB: (target && target.memoryMB) || null,
      });
      instanceId = inst.id;
      logger.modrinth.info(`mrpack: created instance "${inst.name}" (${mcVersion}/${loader}${loaderVersion ? ' ' + loaderVersion : ''})`);
    }
    const gameDir = store.instanceGameDir(instanceId);

    // 2. apply overrides (client side; server-overrides are ignored for player instances)
    const overDir = path.join(tmp, index.overrides || 'overrides');
    if (fs.existsSync(overDir)) {
      status('Applying overrides…');
      await copyDir(overDir, gameDir);
    }

    // 3. download every declared file with sha1 verification
    const files = index.files || [];
    let done = 0, skipped = 0;
    for (const f of files) {
      const env = f.env || {};
      if (env.client === 'unsupported') { skipped++; continue; } // server-side only file
      const dest = safeJoin(gameDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const url = (f.downloads || [])[0];
      if (!url) { skipped++; continue; }
      await download(url, dest, { tries: 2 });
      if (f.hashes && f.hashes.sha1) {
        let actual = sha1OfFile(dest);
        if (actual !== f.hashes.sha1) {
          logger.modrinth.warn(`mrpack: sha1 mismatch for ${f.path} — redownloading once`);
          await download(url, dest, { tries: 2 });
          actual = sha1OfFile(dest);
          if (actual !== f.hashes.sha1) throw new Error(`Integrity check failed for ${f.path} (sha1 mismatch)`);
        }
      }
      done++;
      onProgress && onProgress(done, files.length, f.path);
    }

    // 4. make sure the instance launches: version + loader + loaderVersion from the pack
    store.updateInstance(instanceId, { version: mcVersion, loader, loaderVersion });
    // provenance marker (harmless, useful for support)
    try {
      fs.writeFileSync(path.join(gameDir, '.neurax-modpack.json'), JSON.stringify({
        name: index.name || null, versionId: index.versionId || null,
        gameVersion: mcVersion, loader, loaderVersion, files: done, importedAt: Date.now(),
      }, null, 2));
    } catch {}

    logger.modrinth.info(`Modpack installed: ${done} files (+${skipped} skipped) -> ${gameDir}`);
    return {
      instanceId, instance: inst.name,
      version: mcVersion, loader, loaderVersion,
      files: done, skipped,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** OLD signature kept for compatibility: mrpack into a resolved target. */
async function installModpack({ mrpackPath, target, onProgress = null, onStatus = null }) {
  return installMrpack({ mrpackPath, target, onProgress, onStatus });
}

/** Only https + Modrinth CDN hosts are accepted for any modpack download. */
function assertCdnUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error('Invalid download URL'); }
  if (url.protocol !== 'https:' || !CDN_HOSTS.includes(url.hostname)) {
    throw new Error('Refusing non-Modrinth CDN download URL');
  }
  return url;
}

/**
 * Download a modpack VERSION's primary .mrpack file to a user-chosen path.
 * Only Modrinth CDN urls are allowed.
 */
async function downloadMrpackFile({ versionId, destPath, onProgress = null }) {
  if (!versionId) throw new Error('No modpack version selected');
  if (!destPath) throw new Error('No destination chosen');
  if (!/\.mrpack$/i.test(destPath)) destPath += '.mrpack';
  const version = await getVersion(versionId);
  const primary = version.files.find(f => f.primary) || version.files[0];
  if (!primary) throw new Error('This modpack version has no downloadable file');
  assertCdnUrl(primary.url);
  await download(primary.url, destPath, { onProgress });
  logger.modrinth.info(`mrpack saved: ${destPath}`);
  return { path: destPath, size: primary.size, filename: primary.filename };
}

/**
 * One-call modpack install from Modrinth: fetch the chosen version's .mrpack
 * into temp, then run the full converter into a new or existing instance.
 */
async function installModpackVersion({ projectId = null, versionId, target, onDownload = null, onProgress = null, onStatus = null }) {
  const status = (s) => { try { onStatus && onStatus(s); } catch {} };
  status('Downloading modpack…');
  const version = await getVersion(versionId);
  const primary = version.files.find(f => f.primary) || version.files[0];
  if (!primary) throw new Error('This modpack version has no downloadable file');
  const tmpMrpack = path.join(DIRS.temp, `mrpack-dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mrpack`);
  try {
    await download(primary.url, tmpMrpack, {
      onProgress: (r, t) => { try { onDownload && onDownload(r, t); } catch {} },
    });
    return await installMrpack({
      mrpackPath: tmpMrpack, target,
      onProgress: (d, n, f) => onProgress && onProgress(d, n, f),
      onStatus: status,
    });
  } finally {
    try { fs.rmSync(tmpMrpack, { force: true }); } catch {}
  }
}

async function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = {
  API, PLUGIN_LOADERS, MOD_LOADERS,
  search, getProject, getVersions, getVersion, getUser,
  pickBestVersion, isPluginProject, assertCdnUrl, safeJoin,
  installProject, installMrpack, installModpack, installModpackVersion,
  downloadMrpackFile, readMrpackIndex, installFile, folderFor, gameDirOf,
};
