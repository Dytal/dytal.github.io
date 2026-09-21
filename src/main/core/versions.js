// versions.js — Minecraft version metadata engine.
// - Mojang official manifest (all releases, snapshots, old_beta, old_alpha) with auto-refresh
// - Fabric / Quilt loader metadata + client "profile" installation
// - Forge (promotions + installer download) and NeoForge (maven) version lists
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./paths');
const { getJSON, cachedJSON, download } = require('./net');
const logger = require('./logger');

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const FORGE_PROMOS = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

// ---------------- Mojang manifest ----------------

/**
 * Full Mojang manifest. Auto-adds new versions: we always try a fresh fetch on
 * launcher start (background), falling back to the cached copy when offline.
 * Returns { latest: {release, snapshot}, versions: [...] }
 */
async function getMojangManifest({ force = false } = {}) {
  const key = 'mojang-manifest-v2';
  if (!force) {
    const fresh = require('./net').cacheGet(key, 30 * 60 * 1000);
    if (fresh) return fresh;
  }
  try {
    const data = await getJSON(MANIFEST_URL, { timeout: 20000 });
    require('./net').cacheSet(key, data);
    logger.versions.info(`Mojang manifest refreshed: ${data.versions.length} versions (latest release ${data.latest.release}).`);
    return data;
  } catch (e) {
    const stale = require('./net').cacheGet(key, null);
    if (stale) {
      logger.versions.warn(`Manifest fetch failed (${e.message}); using cached copy.`);
      return stale;
    }
    throw e;
  }
}

/** New versions the cache has not seen yet (used for the "auto-added" toast). */
async function detectNewVersions() {
  const known = require('./net').cacheGet('neurax-known-versions', null) || null;
  const manifest = await getMojangManifest({ force: true });
  const ids = manifest.versions.map(v => v.id);
  require('./net').cacheSet('neurax-known-versions', { count: ids.length, latest: ids.slice(0, 10) });
  if (!known) return { added: [], manifest };
  const added = known.latest ? ids.filter(v => !known.latest.includes(v)).slice(0, 10) : [];
  return { added, manifest };
}

function classify(type) {
  switch (type) {
    case 'release': return 'Releases';
    case 'snapshot': return 'Snapshots';
    case 'old_beta': return 'Beta';
    case 'old_alpha': return 'Alpha';
    default: return 'Other';
  }
}

/** Structured list for the UI: grouped + flat. */
async function getAllVersions() {
  const m = await getMojangManifest();
  const groups = { Releases: [], Snapshots: [], Beta: [], Alpha: [], Other: [] };
  for (const v of m.versions) {
    const g = classify(v.type);
    (groups[g] || groups.Other).push({
      id: v.id,
      type: v.type,
      group: g,
      releaseTime: v.releaseTime,
      url: v.url,
      sha1: v.sha1,
    });
  }
  return { latest: m.latest, groups, flat: m.versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })) };
}

/** Resolves a version id -> Mojang version JSON (downloads + caches by sha1). */
async function getVersionJson(versionId) {
  const m = await getMojangManifest();
  const entry = m.versions.find(v => v.id === versionId);
  if (!entry) throw new Error(`Unknown Minecraft version: ${versionId}`);
  const dir = path.join(DIRS.minecraft, 'versions', versionId);
  const file = path.join(dir, `${versionId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  fs.mkdirSync(dir, { recursive: true });
  const data = await getJSON(entry.url, { timeout: 30000 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// ---------------- Fabric ----------------

async function getFabricLoaderVersions(gameVersion) {
  const { data } = await cachedJSON(`${FABRIC_META}/versions/loader/${gameVersion}`, { key: `fabric-loaders-${gameVersion}`, maxAgeMs: 10 * 60 * 1000 });
  return (data || []).map(e => ({
    loader: e.loader.version, stable: !!e.loader.stable,
  }));
}

/**
 * Installs a Fabric client profile into a launcher root (.minecraft style dir).
 * Returns the custom version id to launch (e.g. fabric-loader-0.16.9-1.21.4).
 */
async function installFabricClient(root, gameVersion, loaderVersion) {
  const profile = await getJSON(`${FABRIC_META}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`);
  const vid = profile.id || `fabric-loader-${loaderVersion}-${gameVersion}`;
  const dir = path.join(root, 'versions', vid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${vid}.json`), JSON.stringify(profile, null, 2));
  logger.versions.info(`Fabric client installed: ${vid} -> ${root}`);
  return vid;
}

// ---------------- Quilt ----------------

async function getQuiltLoaderVersions(gameVersion) {
  const { data } = await cachedJSON(`${QUILT_META}/versions/loader/${gameVersion}`, { key: `quilt-loaders-${gameVersion}`, maxAgeMs: 10 * 60 * 1000 });
  return (data || []).map(e => ({ loader: e.loader.version, stable: !!e.loader.stable }));
}

async function installQuiltClient(root, gameVersion, loaderVersion) {
  const profile = await getJSON(`${QUILT_META}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`);
  const vid = profile.id || `quilt-loader-${loaderVersion}-${gameVersion}`;
  const dir = path.join(root, 'versions', vid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${vid}.json`), JSON.stringify(profile, null, 2));
  logger.versions.info(`Quilt client installed: ${vid} -> ${root}`);
  return vid;
}

// ---------------- Forge ----------------

/** Forge promotions ("recommended"/"latest") per MC version. */
async function getForgeVersions(gameVersion) {
  const { data } = await cachedJSON(FORGE_PROMOS, { key: 'forge-promos', maxAgeMs: 30 * 60 * 1000 });
  const promos = data.promos || {};
  const out = [];
  const rec = promos[`${gameVersion}-recommended`];
  const lat = promos[`${gameVersion}-latest`];
  const seen = new Set();
  if (rec) { out.push({ version: rec, tag: 'recommended' }); seen.add(rec); }
  if (lat && !seen.has(lat)) { out.push({ version: lat, tag: 'latest' }); seen.add(lat); }
  return out; // installer listing full branch lists is huge; promos cover recommended/latest
}

/** Downloads the forge installer jar for mc+forge version. Returns { installerPath, versionId }. */
async function downloadForgeInstaller(root, gameVersion, forgeVersion, onProgress) {
  const branch = '';
  const jarName = `forge-${gameVersion}-${forgeVersion}-installer.jar`;
  const url = `${FORGE_MAVEN}/${gameVersion}-${forgeVersion}${branch}/${jarName}`;
  const dest = path.join(DIRS.temp, jarName);
  await download(url, dest, { onProgress });
  return { installerPath: dest, versionId: `${gameVersion}-forge-${forgeVersion}` };
}

// ---------------- NeoForge ----------------

async function getNeoForgeVersions(gameVersion) {
  const key = 'neoforge-metadata';
  const { getJSON: _g, cachedJSON: _c, ...netRest } = require('./net');
  let txt = netRest.cacheGet(key, 30 * 60 * 1000);
  if (!txt) {
    const { getText } = require('./net');
    txt = await getText(`${NEOFORGE_MAVEN}/maven-metadata.xml`, { timeout: 20000 });
    netRest.cacheSet(key, txt);
  }
  const versions = [...txt.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
  // NeoForge versions track MC: MC 1.21.4 -> NeoForge 21.4.x, MC 1.20.1 -> 20.x
  const mcParts = gameVersion.split('.').slice(0, 2).join('.') // e.g. "1.21"
    .replace(/^1\./, '');                                      // -> "21"
  const matching = versions.filter(v => v.startsWith(`${mcParts}.`));
  const list = (matching.length ? matching : versions).slice(-40).reverse();
  return list.map(v => ({ version: v }));
}

/** Downloads the neoforge installer jar. Returns { installerPath, versionId }. */
async function downloadNeoForgeInstaller(root, gameVersion, neoVersion, onProgress) {
  const jarName = `neoforge-${neoVersion}-installer.jar`;
  const url = `${NEOFORGE_MAVEN}/${neoVersion}/${jarName}`;
  const dest = path.join(DIRS.temp, jarName);
  await download(url, dest, { onProgress });
  return { installerPath: dest, versionId: `neoforge-${neoVersion}` };
}

module.exports = {
  getMojangManifest, getAllVersions, getVersionJson, detectNewVersions,
  getFabricLoaderVersions, installFabricClient,
  getQuiltLoaderVersions, installQuiltClient,
  getForgeVersions, downloadForgeInstaller,
  getNeoForgeVersions, downloadNeoForgeInstaller,
  MANIFEST_URL,
};
