// preload.js — secure bridge between renderer and engine.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload).then(r => {
  if (!r) throw new Error('IPC: no response for ' + channel);
  if (!r.ok) { const e = new Error(r.error || 'Unknown engine error'); e.engine = true; throw e; }
  return r.data;
});

const EVENTS = [
  'launch:progress', 'launch:state', 'java:progress',
  'server:event', 'install:progress', 'logs:entry',
  'versions:auto-added', 'auth:restored', 'auth:deviceCode', 'auth:msWindow',
  // NX Cloud
  'nx:presence', 'nx:lock', 'nx:chat', 'nx:announcements', 'nx:file:progress',
];

contextBridge.exposeInMainWorld('neurax', {
  invoke,
  on(channel, cb) {
    if (!EVENTS.includes(channel)) throw new Error('Blocked event channel: ' + channel);
    const wrapped = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
