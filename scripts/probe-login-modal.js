// probe-login-modal.js — open settings → click "Sign in with Microsoft" → screenshot the new modal (demo mode)
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-nav="settings"]').click();
          await new Promise(r => setTimeout(r, 800));
          const btns = [...document.querySelectorAll('button')];
          const b = btns.find(x => x.textContent.trim() === 'Sign in with Microsoft');
          b.click();
          await new Promise(r => setTimeout(r, 400));
        })()`);
        await new Promise(r => setTimeout(r, 1800)); // let demo stage messages appear
        const img = await win.webContents.capturePage();
        fs.writeFileSync('/tmp/neurax-login-modal.png', img.toPNG());
        console.log('SHOT_SAVED /tmp/neurax-login-modal.png');
      } catch (e) { console.error('PROBE_FAIL ' + e.message); }
      app.quit();
    }, 5000);
  });
});
