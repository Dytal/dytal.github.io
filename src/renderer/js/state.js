// state.js — global app state + tiny pub/sub
import { el, $ } from './utils.js';

export const state = {
  appInfo: null,
  settings: null,
  instances: [],
  servers: [],
  account: null,
  runningServers: [],
  launching: false,
  /* Persistent game/launch state — lives OUTSIDE any page so the dashboard can
     always show what happened (starting / running / exited) even after the home
     page is rebuilt (e.g. by navigating with the logo). */
  game: {
    phase: 'idle',      // idle | starting | downloading | running | exited | failed
    label: null,        // progress headline ("Checking Java 21…", "Downloading game files…")
    detail: null,       // "InstanceName • 1.21.4" or "1.21.4"
    pid: null,
    exitCode: null,
    message: null,      // failure message
    lastProgress: null, // { received, total, label } — last known download progress
    stopped: false,     // user pressed STOP (so the exit toast can be friendly)
  },
};

const listeners = new Map();
export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event)?.delete(cb);
}
export function emit(event, data) {
  listeners.get(event)?.forEach(cb => { try { cb(data); } catch (e) { console.error(e); } });
}

export const EVENTS = {
  INSTANCES: 'instances', SERVERS: 'servers', SETTINGS: 'settings',
  ACCOUNT: 'account', SELECTION: 'selection', RUNNING: 'running',
  GAME: 'game',
};

/** Merge a patch into state.game and notify listeners. */
export function setGameState(patch) {
  Object.assign(state.game, patch);
  emit(EVENTS.GAME, state.game);
}

export const api = window.neurax;

// safe defaults so a failed/absent engine call can never leave state.settings null
const SETTINGS_FALLBACK = {
  theme: 'emerald', memoryMB: 4096, selectedVersion: null, selectedInstanceId: null,
  showSnapshots: true, showOldVersions: true, keepLauncherOpen: true,
  rememberWindowSize: true, windowWidth: 1200, windowHeight: 800,
};

export async function loadSettings() {
  state.settings = await api.invoke('settings:get').catch(() => null);
  state.settings = (state.settings && typeof state.settings === 'object')
    ? { ...SETTINGS_FALLBACK, ...state.settings }
    : { ...SETTINGS_FALLBACK };
  document.documentElement.dataset.theme = state.settings.theme || 'emerald';
  return state.settings;
}

export async function saveSettings(patch) {
  const next = await api.invoke('settings:set', patch).catch(() => null);
  state.settings = (next && typeof next === 'object') ? { ...state.settings, ...next } : { ...state.settings, ...patch };
  document.documentElement.dataset.theme = state.settings.theme || 'emerald';
  emit(EVENTS.SETTINGS, state.settings);
  return state.settings;
}

export async function refreshInstances() {
  state.instances = await api.invoke('instances:list');
  const sel = state.settings?.selectedInstanceId;
  if (sel && !state.instances.find(i => i.id === sel)) {
    state.settings.selectedInstanceId = null;
  }
  emit(EVENTS.INSTANCES, state.instances);
  emit(EVENTS.SELECTION, selection());
  return state.instances;
}

export async function refreshServers() {
  state.servers = await api.invoke('servers:list');
  try { state.runningServers = await api.invoke('servers:running'); } catch { state.runningServers = []; }
  emit(EVENTS.SERVERS, state.servers);
  emit(EVENTS.RUNNING, state.runningServers);
  return state.servers;
}

export async function refreshAccount() {
  try {
    state.account = await api.invoke('auth:current');
    emit(EVENTS.ACCOUNT, state.account);
  } catch { /* offline fallback handled by engine */ }
  return state.account;
}

/** What will PLAY launch right now. */
export function selection() {
  const selId = state.settings?.selectedInstanceId;
  const inst = state.instances.find(i => i.id === selId) || null;
  return { instance: inst, version: inst ? null : (state.settings?.selectedVersion || null) };
}

export async function selectInstance(id) {
  await api.invoke('instances:select', { id });
  state.settings.selectedInstanceId = id;
  emit(EVENTS.SELECTION, selection());
}

export async function selectVersion(id) {
  state.settings.selectedVersion = id;
  state.settings.selectedInstanceId = null;
  await saveSettings({ selectedVersion: id, selectedInstanceId: null });
  emit(EVENTS.SELECTION, selection());
}

export async function boot() {
  try { state.appInfo = await api.invoke('app:info'); } catch (e) { console.warn('app:info unavailable:', e.message); }
  await loadSettings();
  await Promise.allSettled([refreshInstances(), refreshServers(), refreshAccount()]);
}

/* ---- app-level server run-state sync -------------------------------------
   ONE listener, alive for the whole app lifetime, keeps state.runningServers
   in sync no matter which page is mounted. Previously only the Servers page
   subscribed to these events, so navigating away (e.g. via the logo) and back
   made a RUNNING server look stopped, and hitting Start then errored with
   "Server is already running". Pages may still subscribe for console lines,
   but the running set itself never depends on a mounted page anymore. */
export function syncServerEvent(p) {
  if (!p || !p.serverId) return;
  const has = state.runningServers.includes(p.serverId);
  if (p.event === 'started' && !has) state.runningServers.push(p.serverId);
  if (p.event === 'stopped' && has) state.runningServers = state.runningServers.filter(id => id !== p.serverId);
  if (p.event === 'started' || p.event === 'stopped') emit(EVENTS.RUNNING, state.runningServers);
}

try {
  api.on('server:event', syncServerEvent);
} catch (e) { console.warn('server:event global sync unavailable:', e.message); }
