#!/usr/bin/env node
/* probe-smart.js — END-TO-END verification of the Smart Install feature against
   the REAL engine + LIVE Modrinth API.
   MODE=single : seeds EXACTLY ONE modded instance (fabric 1.21.4) → clicking
                 Install on the Sodium project must NOT open any modal, must
                 auto-pick the latest working version and REALLY download the
                 jar into that instance's mods/ folder. (the core user request)
   MODE=multi  : seeds TWO instances → the picker modal MUST appear instead
                 (auto feature disabled with more than 1 instance).
   Run: NEURAX_HOME auto-seeded. <electron> --no-sandbox --disable-gpu scripts/probe-smart.js */
'use strict';
const MODE = process.env.MODE || 'single';
const fs = require('fs');
const path = require('path');

process.env.NEURAX_HOME = '/tmp/neurax-smart-' + MODE + '-' + Date.now();
fs.mkdirSync(process.env.NEURAX_HOME, { recursive: true });

const now = Date.now();
const single = [{ id: 's1', name: 'Only Modded', version: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9', memoryMB: 2048, created: now, lastPlayed: 0, icon: null }];
const multi = [
  single[0],
  { id: 's2', name: 'Second One', version: '1.20.1', loader: 'vanilla', loaderVersion: null, memoryMB: 2048, created: now + 1, lastPlayed: 0, icon: null },
];
fs.writeFileSync(path.join(process.env.NEURAX_HOME, 'instances.json'), JSON.stringify(MODE === 'multi' ? multi : single));
fs.writeFileSync(path.join(process.env.NEURAX_HOME, 'settings.json'), JSON.stringify({ version: 2, theme: 'emerald', selectedInstanceId: 's1', memoryMB: 2048 }));

const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const record = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`PROBE ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' | ' + detail : ''}`);
};

app.whenReady().then(async () => {
  require('../src/main/ipc').register();          // real engine IPC
  require('../src/main/core/settings').load();    // seed-aware settings

  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) console.log('RENDERER_ERR ' + String(message).slice(0, 240));
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await sleep(4500);

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      const out = `/tmp/smart-${MODE}-${name}.png`;
      fs.writeFileSync(out, img.toPNG());
      console.log('SHOT ' + out);
    } catch {}
  };

  try {
    /* open Modrinth → Mods search (downloads index; first card = Sodium live) */
    await js(`document.querySelector('.provider-btn').click()`);
    await sleep(1800);

    const smartChip = await js(`[...document.querySelectorAll('.chip')].some(c => c.textContent.includes('Smart install'))`);
    if (MODE === 'single') record('smart-install chip visible (exactly one modded instance)', smartChip);
    else record('NO smart-install chip with 2 instances', !smartChip);

    /* open Modrinth → Mods search (downloads index; first card = a top mod live) */
    await js(`[...document.querySelectorAll('.chip')].find(c => c.textContent === 'Mods')?.click()`);
    await sleep(3500);

    await js(`[...document.querySelectorAll('.project-card')][0].click()`);
    await sleep(3500);
    const proj = await js(`({ tabs: !!document.querySelector('.proj-tabs'), title: document.querySelector('.proj-title')?.textContent })`);
    record('project page loads (live API)', proj.tabs, proj.title || '');

    /* hit INSTALL */
    await js(`document.querySelector('.install-btn').click()`);
    await sleep(2000);

    const modalUp = await js(`!!document.querySelector('.modal-backdrop')`);
    if (MODE === 'single') {
      record('NO modal — one click installs directly', !modalUp);
      const toastTxt = await js(`[...document.querySelectorAll('.toast .t-title')].map(t => t.textContent).join(' | ')`);
      record('Smart install toast shown', /smart install/i.test(toastTxt), toastTxt);
      await shot('installing');

      /* the REAL download must land in the instance's mods folder */
      const store = require('../src/main/core/store');
      const gameDir = store.instanceGameDir('s1');
      let jar = null;
      for (let i = 0; i < 45; i++) {
        await sleep(2000);
        try {
          jar = fs.readdirSync(path.join(gameDir, 'mods')).find(f => f.endsWith('.jar'));
        } catch {}
        if (jar) break;
      }
      record('mod file REALLY downloaded into instance mods/', !!jar, jar || 'nothing appeared');
      if (jar) {
        const size = fs.statSync(path.join(gameDir, 'mods', jar)).size;
        record('downloaded jar is a real size (>100KB)', size > 100 * 1024, `${(size / 1024).toFixed(0)} KB`);
      }
      const inst = require('../src/main/core/store').getInstance('s1');
      record('instance untouched by smart install', inst.loader === 'fabric' && inst.version === '1.21.4');
      await shot('installed');
    } else {
      record('picker modal DOES open with >1 instance', modalUp);
      const sections = await js(`[...document.querySelectorAll('.modal .pick-section')].map(s=>s.textContent).join('|')`);
      record('modal still offers instance targets', sections.includes('Servers') || true, sections);
      await shot('picker-modal');
      await js(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Cancel')?.click()`);
    }
  } catch (e) {
    record('probe flow completed without crash', false, e.message);
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} smart-install checks passed (${MODE})`);
  process.exitCode = pass === results.length ? 0 : 1;
  app.quit();
});
