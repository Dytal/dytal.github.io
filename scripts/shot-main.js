// shot-main.js — boot the REAL renderer (no preload => mock bridge activates),
// wait for paint, capture a PNG screenshot, then quit. Purely a test harness.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// env USE_REAL_PRELOAD=1 → load the real engine bridge (full end-to-end check)
const useRealPreload = process.env.USE_REAL_PRELOAD === '1';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      ...(useRealPreload ? { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') } : {}),
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', async () => {
    // give modules time to boot + pages to render
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        const out = process.env.SHOT_OUT || '/tmp/neurax-shot.png';
        fs.writeFileSync(out, img.toPNG());
        console.log('SHOT_SAVED ' + out);
        // navigate to settings (crash source page) and capture again
        if (process.env.SHOT_SETTINGS) {
          await win.webContents.executeJavaScript(
            `document.querySelector('[data-nav="settings"]').click()`);
          await new Promise(r => setTimeout(r, 1500));
          if (process.env.SHOT_SETTINGS_SCROLL) {
            // scroll the Java card into view before capturing
            await win.webContents.executeJavaScript(
              `(async () => {
                const page = document.querySelector('#page-host .page');
                const cards = [...document.querySelectorAll('#page-host .card')];
                const javaCard = cards.find(c => c.querySelector('.label')?.textContent === 'Java');
                (javaCard || page)?.scrollIntoView({ block: 'end' });
                await new Promise(r => setTimeout(r, 400));
              })()`);
          }
          const img2 = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SHOT_SETTINGS, img2.toPNG());
          console.log('SHOT_SAVED ' + process.env.SHOT_SETTINGS);
        }
        // also dump any page errors the failsafe caught
        const errs = await win.webContents.executeJavaScript(
          '({ booted: !!window.__neuraxMarkBooted && document.querySelectorAll("#navbar").length > 0, overlay: !!document.getElementById("neurax-failsafe") })');
        console.log('STATE ' + JSON.stringify(errs));
      } catch (e) {
        console.error('SHOT_FAIL ' + e.message);
      }
      app.quit();
    }, 5000);
  });
});
