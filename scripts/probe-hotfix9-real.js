// real-engine IPC wiring check: boots the app with the REAL preload and calls
// the three new channels directly through window.neurax (as the page does).
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
require(path.join(process.cwd(), 'src', 'main', 'ipc')).register(); // real IPC surface
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 700, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(process.cwd(), 'src', 'main', 'preload.js') } });
  win.loadFile(path.join(process.cwd(), 'src', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 3000));
    const out = await win.webContents.executeJavaScript(`(async () => {
      const r = {};
      try { r.runtime = await window.neurax.invoke('servers:runtime'); } catch (e) { r.runtimeErr = e.message; }
      try { r.log = await window.neurax.invoke('servers:log', { id: 'does-not-exist' }); } catch (e) { r.logErr = e.message; }
      try { r.clear = await window.neurax.invoke('servers:clearLog', { id: 'does-not-exist' }); } catch (e) { r.clearErr = e.message; }
      r.stateRunning = (window.stateProbe === undefined) ? 'n/a' : window.stateProbe;
      return r;
    })()`);
    console.log('REAL_IPC ' + JSON.stringify(out));
    app.quit();
    setTimeout(() => process.exit(0), 400);
  });
});
