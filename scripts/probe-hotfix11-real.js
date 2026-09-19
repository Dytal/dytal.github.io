// probe-hotfix11-real.js — real-engine IPC check for the account head-avatar
// channel. Boots the app with the REAL preload and calls auth:skinData exactly
// like the settings page does:
//   · null account            → must resolve null (offline — no skin)
//   · fake MSA w/ bad skin URL → must resolve null (download fails cleanly)
// A missing/duplicate handler would reject instead — that's what we catch.
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
      try { r.offline = await window.neurax.invoke('auth:skinData', { account: null }); } catch (e) { r.offlineErr = e.message; }
      try {
        r.badMsa = await window.neurax.invoke('auth:skinData', { account: {
          type: 'msa', name: 'Probe', uuid: 'probe-uuid-0001',
          skin: { id: 'x', state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/does-not-exist-probe' },
        } });
      } catch (e) { r.badMsaErr = e.message; }
      return r;
    })()`);
    console.log('REAL_SKIN ' + JSON.stringify(out));
    const ok = out.offline === null && out.badMsa === null && !out.offlineErr && !out.badMsaErr;
    console.log(ok ? 'PASS 2/2 (handler registered, both refusal paths return null)' : 'FAIL');
    app.quit();
    setTimeout(() => process.exit(ok ? 0 : 1), 400);
  });
});
