// store.js — instances & servers persistence (.neurax/instances.json, .neurax/servers.json)
// plus per-instance directories that follow the standard .minecraft layout.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIRS, writeJSON, readJSON } = require('./paths');
const logger = require('./logger');

function id() { return crypto.randomBytes(6).toString('hex'); }

// ---------- instances ----------
function instancesFile() { return path.join(DIRS.root, 'instances.json'); }

function listInstances() {
  return readJSON(instancesFile(), []);
}

function saveInstances(list) { writeJSON(instancesFile(), list); }

function getInstance(instanceId) {
  return listInstances().find(i => i.id === instanceId) || null;
}

/** loader: vanilla | fabric | forge | neoforge | quilt */
function createInstance({ name, version, loader = 'vanilla', loaderVersion = null, memoryMB = null }) {
  const list = listInstances();
  const inst = {
    id: id(),
    name: String(name || 'Instance').slice(0, 60),
    version: String(version),
    loader: String(loader).toLowerCase(),
    loaderVersion: loaderVersion || null,
    memoryMB: memoryMB || null,
    created: Date.now(),
    lastPlayed: 0,
    icon: null,
  };
  list.push(inst);
  saveInstances(list);
  instanceDir(inst.id); // ensure dir
  logger.core.info(`Instance created: ${inst.name} (${inst.version}/${inst.loader})`);
  // NX-UI 64x pack: future instances get it the moment they are created
  try { require('./nx-inject').injectGameDir(instanceGameDir(inst.id)); } catch {}
  return inst;
}

function updateInstance(instanceId, patch) {
  const list = listInstances();
  const idx = list.findIndex(i => i.id === instanceId);
  if (idx === -1) return null;
  const allowed = {};
  for (const k of ['name', 'version', 'loader', 'loaderVersion', 'memoryMB', 'icon']) {
    if (k in patch) allowed[k] = patch[k];
  }
  list[idx] = { ...list[idx], ...allowed };
  saveInstances(list);
  return list[idx];
}

function deleteInstance(instanceId) {
  let list = listInstances();
  const inst = list.find(i => i.id === instanceId);
  list = list.filter(i => i.id !== instanceId);
  saveInstances(list);
  if (inst) {
    try { fs.rmSync(instanceDir(instanceId), { recursive: true, force: true }); } catch {}
    logger.core.info(`Instance deleted: ${inst.name}`);
  }
  return inst || null;
}

function instanceDir(instanceId) {
  const d = path.join(DIRS.instances, instanceId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** The game directory for an instance ("minecraft" subfolder, standard layout). */
function instanceGameDir(instanceId) {
  const d = path.join(instanceDir(instanceId), '.minecraft');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- servers ----------
function serversFile() { return path.join(DIRS.root, 'servers.json'); }

function listServers() { return readJSON(serversFile(), []); }
function saveServers(list) { writeJSON(serversFile(), list); }

function getServer(serverId) { return listServers().find(s => s.id === serverId) || null; }

/** type: paper | spigot | fabric | forge | vanilla | neoforge | quilt */
function createServer({ name, type = 'vanilla', version, memoryMB = 2048, port = 25565, motd = 'A Neurax Server' }) {
  const list = listServers();
  const srv = {
    id: id(),
    name: String(name || 'Server').slice(0, 60),
    type: String(type).toLowerCase(),
    version: String(version),
    memoryMB: Math.max(512, Number(memoryMB) || 2048),
    port: Number(port) || 25565,
    motd: String(motd || '').slice(0, 120),
    created: Date.now(),
    lastRun: 0,
    installed: false,
    jarFile: null,
  };
  list.push(srv);
  saveServers(list);
  serverDir(srv.id);
  logger.core.info(`Server created: ${srv.name} (${srv.type} ${srv.version})`);
  return srv;
}

function updateServer(serverId, patch) {
  const list = listServers();
  const idx = list.findIndex(s => s.id === serverId);
  if (idx === -1) return null;
  const allowed = {};
  for (const k of ['name', 'type', 'version', 'memoryMB', 'port', 'motd', 'installed', 'jarFile']) {
    if (k in patch) allowed[k] = patch[k];
  }
  list[idx] = { ...list[idx], ...allowed };
  saveServers(list);
  return list[idx];
}

function deleteServer(serverId) {
  let list = listServers();
  const srv = list.find(s => s.id === serverId);
  list = list.filter(s => s.id !== serverId);
  saveServers(list);
  if (srv) {
    try { fs.rmSync(serverDir(serverId), { recursive: true, force: true }); } catch {}
    logger.core.info(`Server deleted: ${srv.name}`);
  }
  return srv || null;
}

function serverDir(serverId) {
  const d = path.join(DIRS.servers, serverId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ---------- global selected instance ----------
function setSelected(instanceId) {
  const { set } = require('./settings');
  set({ selectedInstanceId: instanceId });
}

module.exports = {
  listInstances, createInstance, updateInstance, deleteInstance, getInstance,
  instanceDir, instanceGameDir,
  listServers, createServer, updateServer, deleteServer, getServer, serverDir,
  setSelected,
};
