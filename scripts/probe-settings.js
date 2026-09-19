// probe-settings.js — diagnose why the settings nav click doesn't navigate
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true, // shown so the compositor actually paints frames
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const diag = await win.webContents.executeJavaScript(`(async () => {
          const b = document.querySelector('[data-nav="settings"]');
          const before = [...document.querySelectorAll('#page-host .page')].map(p => p.dataset.page);
          if (!b) return { found: false, before };
          // simulate a real user click on the inner SVG area AND the button itself
          b.click();
          await new Promise(r => setTimeout(r, 1200));
          const after = [...document.querySelectorAll('#page-host .page')].map(p => p.dataset.page);
          return {
            found: true,
            before, after,
            btnTag: b.tagName,
            listenerTest: typeof window.__neuraxMarkBooted,
            hostChildren: document.getElementById('page-host').children.length,
          };
        })()`);
        console.log('DIAG ' + JSON.stringify(diag));
        const fs = require('fs');
        const img = await win.webContents.capturePage();
        fs.writeFileSync('/tmp/neurax-shot-settings2.png', img.toPNG());
        console.log('SHOT_SAVED /tmp/neurax-shot-settings2.png');
      } catch (e) {
        console.error('DIAG_FAIL ' + e.message);
      }
      app.quit();
    }, 5000);
  });
});
