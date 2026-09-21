#!/usr/bin/env node
/* probe-features-ui.js — headless UI verification for the v2.2.0 Modrinth power
   update. Boots the REAL renderer with the mock bridge (demo data: 3 instances →
   smart install intentionally OFF, 1 paper + 1 fabric server) and drives:
     - Modrinth home + Plugins quick-type search
     - project page Versions tab with search/filter toolbar
     - install modal with version filters + server targets
     - New Instance page .mrpack import card
     - Servers page "Add mods / plugins" → pinned-server Modrinth preset
   Run (Xvfb): <electron> --no-sandbox --disable-gpu scripts/probe-features-ui.js */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

const results = [];
function ok(name, cond, extra = '') {
  results.push(cond);
  console.log((cond ? '  \u2713 ' : '  \u2717 ') + name + (cond ? '' : ' \u2192 ' + extra));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const ex = (js) => win.webContents.executeJavaScript(js);
  async function shot(name) {
    try {
      const img = await win.webContents.capturePage();
      const out = `/tmp/ui-${name}.png`;
      fs.writeFileSync(out, img.toPNG());
      console.log('SHOT ' + out);
    } catch (e) { console.log('shot failed:', e.message); }
  }

  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2200);
      const boot = await ex('({ booted: document.querySelectorAll("#navbar").length > 0, overlay: !!document.getElementById("neurax-failsafe") })');
      ok('app boots, no failsafe overlay', boot.booted && !boot.overlay, JSON.stringify(boot));

      /* 1 — Modrinth home */
      await ex(`document.querySelector('.provider-btn').click()`);
      await sleep(900);
      ok('Modrinth home renders', await ex(`!!document.querySelector('.store-hero')`));
      ok('no Smart-install chip with 3 demo instances (>1 → feature OFF)',
        await ex(`![...document.querySelectorAll('.chip')].some(c => c.textContent.includes('Smart install'))`));

      /* 2 — Plugins search */
      await ex(`[...document.querySelectorAll('.chip')].find(c => c.textContent === 'Plugins')?.click()`);
      await sleep(900);
      ok('Plugins search returns EssentialsX (demo hits)', await ex(`document.body.textContent.includes('EssentialsX')`));
      ok('plugin loader filter chips shown (Paper/Spigot/…)',
        await ex(`[...document.querySelectorAll('.fchip')].some(c => c.textContent.toLowerCase() === 'paper')`));
      await shot('modrinth-plugins');

      /* 3 — project page + versions tab filters */
      await ex(`[...document.querySelectorAll('.project-card')][0].click()`);
      await sleep(800);
      ok('project page renders', await ex(`!!document.querySelector('.proj-tabs')`));
      await ex(`[...document.querySelectorAll('.proj-tab')].find(t => t.textContent === 'Versions')?.click()`);
      await sleep(400);
      ok('Versions tab has search + loader + game-version toolbar', await ex(`!!document.querySelector('.pick-toolbar')`));
      ok('Versions tab lists rows', await ex(`document.querySelectorAll('.version-row').length > 0`));

      /* 4 — install modal (3 instances → full picker, not smart) */
      await ex(`document.querySelector('.install-btn').click()`);
      await sleep(600);
      ok('install modal opens with filter toolbar', await ex(`!!document.querySelector('.modal .pick-toolbar')`));
      ok('install modal lists versions', await ex(`document.querySelectorAll('.modal .pick-item').length > 0`));
      ok('target list includes Servers section (mods)', await ex(`[...document.querySelectorAll('.modal .pick-section')].some(s => s.textContent.includes('Servers (mods)'))`));
      ok('fabric demo server is an eligible target', await ex(`[...document.querySelectorAll('.modal .pick-item b')].some(b => b.textContent === 'Modded SMP')`));
      ok('paper demo server NOT eligible for mods', await ex(`![...document.querySelectorAll('.modal .pick-item b')].some(b => b.textContent === 'Creative Hub')`));
      // search filter inside the modal: type garbage → "no versions match" hint
      await ex(`(async () => {
        const inp = document.querySelector('.modal .pick-toolbar input');
        inp.value = 'zzz-no-match';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(300);
      ok('version search filters the list (no-match hint)', await ex(`[...document.querySelectorAll('.modal .pick-hint')].some(h => h.textContent.includes('No versions match'))`));
      await shot('modrinth-install-modal');
      await ex(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Cancel')?.click()`);
      await sleep(300);

      /* 4b — modpack flow: MC version + loader + pack version → .mrpack OR instance */
      await ex(`document.querySelector('.provider-btn').click()`);
      await sleep(800);
      await ex(`[...document.querySelectorAll('.chip')].find(c => c.textContent === 'Modpacks')?.click()`);
      await sleep(800);
      ok('modpack search shows Fabulously Optimized (demo)', await ex(`document.body.textContent.includes('Fabulously Optimized')`));
      await ex(`[...document.querySelectorAll('.project-card')][0].click()`);
      await sleep(800);
      ok('modpack install button labelled "Install modpack"', await ex(`document.querySelector('.install-btn')?.textContent.includes('Install modpack')`));
      await ex(`document.querySelector('.install-btn').click()`);
      await sleep(600);
      ok('modpack modal has Minecraft version + loader selects', await ex(`document.querySelectorAll('.modal select').length >= 2`));
      ok('modpack modal lists pack versions with sizes', await ex(`document.body.textContent.includes('5.4.3')`));
      // pick a pack version, then Download .mrpack
      await ex(`document.querySelector('.modal .pick-item').click()`);
      await sleep(200);
      await ex(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Download .mrpack'))?.click()`);
      await sleep(1700);
      ok('Download .mrpack flow completes (saved toast)', await ex(`[...document.querySelectorAll('.toast .t-title')].some(t => t.textContent === 'Modpack saved')`));
      await shot('modpack-downloaded');
      // reopen → Convert to instance (demo converter creates instance + navigates home)
      await ex(`document.querySelector('.install-btn').click()`);
      await sleep(500);
      await ex(`document.querySelector('.modal .pick-item').click()`);
      await sleep(200);
      await ex(`[...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Convert to instance'))?.click()`);
      await sleep(500);
      ok('convert confirm modal shows pack summary', await ex(`document.body.textContent.includes('Minecraft 1.21.4')`));
      await ex(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Create instance')?.click()`);
      await sleep(2600);
      ok('Convert to instance → demo instance created + dashboard landing', await ex(`[...document.querySelectorAll('.toast .t-title')].some(t => t.textContent === 'Modpack instance ready')`));
      await shot('modpack-converted');

      /* 5 — New Instance page: .mrpack import card */
      await ex(`document.querySelector('[data-nav="new-instance"]').click()`);
      await sleep(700);
      ok('mrpack import card present on New Instance page', await ex(`!!document.querySelector('.mrpack-import')`));
      ok('import button labelled', await ex(`[...document.querySelectorAll('.mrpack-import button')].some(b => b.textContent.includes('Import .mrpack'))`));
      await shot('new-instance-import');

      /* 6 — Servers page → Add mods/plugins → pinned Modrinth */
      await ex(`document.querySelector('[data-nav="servers"]').click()`);
      await sleep(800);
      ok('server details shows "Add mods / plugins"', await ex(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Add mods / plugins'))`));
      await ex(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Add mods / plugins')).click()`);
      await sleep(900);
      ok('Modrinth opens with pinned-server banner', await ex(`!!document.querySelector('.preset-banner')`));
      ok('banner names the paper server', await ex(`document.querySelector('.preset-banner')?.textContent.includes('Creative Hub')`));
      ok('search pre-filtered to Plugins for paper', await ex(`[...document.querySelectorAll('.chip, .fchip')].some(c => c.textContent === 'EssentialsX' || document.body.textContent.includes('EssentialsX'))`));
      await shot('modrinth-preset-server');

      const pass = results.filter(Boolean).length;
      console.log(`\n${pass}/${results.length} UI checks passed`);
      process.exitCode = pass === results.length ? 0 : 1;
    } catch (e) {
      console.error('probe crashed:', e);
      process.exitCode = 1;
    }
    app.quit();
  });
});
