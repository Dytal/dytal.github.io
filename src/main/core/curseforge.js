// curseforge.js — CurseForge API client.
// The official CF API requires a personal x-api-key (free from console.curseforge.com).
// The key is stored in settings; without it, the UI explains how to get one (no faking).
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./paths');
const { getJSON, download } = require('./net');
const logger = require('./logger');

const API = 'https://api.curseforge.com/v1';
const MC_GAME_ID = 432; // Minecraft (Java)

function settings() { return require('./settings').get(); }

function key() { return (settings().cfApiKey || '').trim(); }

function requireKey() {
  if (!key()) {
    throw new Error('CF_API_KEY_MISSING');
  }
}

async function cf(pathName, params = {}) {
  requireKey();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `${API}${pathName}${qs.toString() ? '?' + qs : ''}`;
  let res;
  try {
    res = await getJSON(url, { headers: { 'x-api-key': key(), Accept: 'application/json' }, timeout: 25000 });
  } catch (e) {
    if (/HTTP 403\b/.test(e.message || '')) {
      // 403 = the key we sent was rejected — give the user an actionable message
      throw new Error('CurseForge rejected the API key (403 Forbidden). Open Settings → Integrations and paste the exact key from console.curseforge.com — it is a long letters/numbers string, copied in full.');
    }
    throw e;
  }
  return res.data !== undefined ? res.data : res;
}

/** Verify the stored key against a cheap endpoint; throws with a clear message if rejected. */
async function validateKey() {
  requireKey();
  await cf('/games', { gameId: MC_GAME_ID });
  return true;
}

// ---------- categories ----------
let catCache = null;
async function getCategories(classId = 6 /* mods */) {
  if (catCache && catCache.classId === classId) return catCache.list;
  const list = await cf('/categories', { gameId: MC_GAME_ID, classId });
  catCache = { classId, list };
  return list;
}

// ---------- search ----------
// classIds: 6=mods, 12=resourcepacks, 4471=modpacks, 12? (shaders=4471? actually 6=mods,12=RP,4471=modpacks,17=worlds)
const CLASS_IDS = { mod: 6, resourcepack: 12, modpack: 4471, world: 17 };

async function search({ q = '', projectType = 'mod', gameVersion = null, categoryId = null, sortField = 2, sortOrder = 'desc', index = 0, pageSize = 20 } = {}) {
  const classId = CLASS_IDS[projectType] || 6;
  const params = { gameId: MC_GAME_ID, classId, searchFilter: q, sortField, sortOrder, index, pageSize };
  if (gameVersion) params.gameVersion = gameVersion;
  if (categoryId) params.categoryId = categoryId;
  const data = await cf('/mods/search', params);
  return data; // { data: [...], pagination }
}

async function getMod(modId) {
  const data = await cf(`/mods/${modId}`);
  return data; // { data: mod }
}

async function getModDescription(modId) {
  const data = await cf(`/mods/${modId}/description`);
  return data; // { data: html }
}

async function getModFiles(modId, { gameVersion = null, modLoaderType = null } = {}) {
  const params = { gameVersion: gameVersion || undefined };
  if (modLoaderType !== null && modLoaderType !== undefined) params.modLoaderType = modLoaderType;
  const data = await cf(`/mods/${modId}/files`, params);
  return data; // { data: files[] }
}

async function getModFile(modId, fileId) {
  const data = await cf(`/mods/${modId}/files/${fileId}`);
  return data;
}

// modLoaderType enum: 0=Any,1=Forge,4=Fabric,5=Quilt,6=NeoForge
const LOADER_ENUM = { any: 0, forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

// ---------- installation ----------

function gameDirOf(target) {
  const store = require('./store');
  if (target.type === 'instance') return store.instanceGameDir(target.instanceId);
  return DIRS.minecraft;
}

function folderFor(projectType) {
  switch (projectType) {
    case 'mod': return 'mods';
    case 'resourcepack': return 'resourcepacks';
    case 'modpack': return ''; // handled specially
    default: return 'mods';
  }
}

/** Download a CF file (mod/rp) into the target. Modpacks get a full import
 *  (overrides + every manifest file resolved and downloaded). */
async function installFile({ mod, file, projectType = 'mod', target, onProgress = null }) {
  if (projectType === 'modpack') {
    const tmpZip = path.join(DIRS.temp, 'cfpack-download-' + Date.now() + '.zip');
    const url = file.downloadUrl || `https://edge.forgecdn.net/files/${String(file.id).slice(0, 4)}/${String(file.id).slice(4)}/${encodeURIComponent(file.fileName)}`;
    await download(url, tmpZip, { onProgress });
    try {
      return await installModpack({ zipPath: tmpZip, target, onProgress });
    } finally {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    }
  }
  const dir = path.join(gameDirOf(target), folderFor(projectType));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, file.fileName);
  const url2 = file.downloadUrl || `https://edge.forgecdn.net/files/${String(file.id).slice(0, 4)}/${String(file.id).slice(4)}/${encodeURIComponent(file.fileName)}`;
  await download(url2, dest, { onProgress });
  logger.curseforge.info(`Installed ${file.fileName} -> ${dir}`);
  return dest;
}

/** Import a CF modpack zip: manifest.json -> resolve + download all files. */
async function installModpack({ zipPath, target, onProgress = null, onStatus = null }) {
  const extract = require('extract-zip');
  const store = require('./store');
  const tmp = path.join(DIRS.temp, 'cfpack-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  await extract(zipPath, { dir: tmp });
  const manifestPath = path.join(tmp, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('Not a valid CurseForge modpack (missing manifest.json)');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gameDir = gameDirOf(target);

  // overrides (config, options.txt, mods overrides etc.)
  const overDir = path.join(tmp, manifest.overrides || 'overrides');
  if (fs.existsSync(overDir)) {
    await copyDir(overDir, gameDir);
  }

  // resolve + download each file
  const projIds = (manifest.files || []).map(f => f.projectID);
  const fileIds = (manifest.files || []).map(f => f.fileID);
  let done = 0;
  for (let i = 0; i < projIds.length; i++) {
    const fd = await getModFile(projIds[i], fileIds[i]);
    const dir = path.join(gameDir, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const url = fd.downloadUrl || `https://edge.forgecdn.net/files/${String(fd.id).slice(0, 4)}/${String(fd.id).slice(4)}/${encodeURIComponent(fd.fileName)}`;
    await download(url, path.join(dir, fd.fileName));
    done++;
    onProgress && onProgress(done, projIds.length, fd.fileName);
  }

  if (target.instanceId && manifest.minecraft) {
    const patch = { version: manifest.minecraft.version };
    const loader = (manifest.minecraft.modLoaders || [])[0];
    if (loader) {
      if (loader.id.startsWith('forge')) { patch.loader = 'forge'; patch.loaderVersion = loader.id.replace('forge-', ''); }
      if (loader.id.startsWith('neoforge')) { patch.loader = 'neoforge'; patch.loaderVersion = loader.id.replace('neoforge-', ''); }
      if (loader.id.startsWith('fabric')) { patch.loader = 'fabric'; patch.loaderVersion = loader.id.replace('fabric-', ''); }
    }
    store.updateInstance(target.instanceId, patch);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  logger.curseforge.info(`Modpack installed: ${projIds.length} files -> ${gameDir}`);
  return { files: projIds.length };
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
  API, CLASS_IDS, LOADER_ENUM, key, requireKey, validateKey,
  getCategories, search, getMod, getModDescription, getModFiles, getModFile,
  installFile, installModpack, gameDirOf,
};
