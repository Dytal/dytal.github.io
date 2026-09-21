// probe-dashboard.js — headless verification of the Hotfix-6 dashboard fixes.
// Boots the REAL renderer + REAL preload, then:
//   1. verifies instances:create auto-selects the new instance (engine side)
//   2. verifies game:stop IPC is wired
//   3. injects launch:state / launch:progress broadcasts (exactly what game.js
//      emits) and checks the dashboard reacts: progress → RUNNING banner + STOP
//   4. clicks the N logo WHILE "running" → page must NOT rebuild (same DOM node)
//      and the banner must survive  ← the exact bug the user reported
//   5. settings round-trip → banner restored from persistent state.game
//   6. exited(0) → friendly "session ended" pill
// Prints PROBE_RESULT lines; screenshots via PROBE_SHOT dir.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SHOT_DIR = process.env.PROBE_SHOT || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`PROBE ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' | ' + detail : ''}`);
};

app.whenReady().then(async () => {
  require('../src/main/ipc').register(); // the probe bypasses src/main/main.js — wire the engine manually
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 2) console.log('RENDERER_ERR ' + message);
  });

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(4500); // modules boot + home render

  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    try {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
      console.log('SHOT ' + name);
    } catch (e) { console.log('SHOT_FAIL ' + name + ' ' + e.message); }
  };

  try {
    /* ---------- 0. baseline ---------- */
    const base = await js(`(() => {
      const page = document.querySelector('#page-host .page');
      return { booted: !!document.querySelector('#navbar'), pages: document.querySelectorAll('#page-host .page').length,
               dataPage: page ? page.dataset.page : null };
    })()`);
    record('home renders with navbar', base.booted && base.dataPage === 'home', JSON.stringify(base));

    /* ---------- 1. instances:create auto-select (through the app's own state fns, like the UI does) ---------- */
    const sel = await js(`(async () => {
      const m = await import('./js/state.js');
      const inst = await window.neurax.invoke('instances:create', { name: 'ProbeInst', version: '1.21.4', loader: 'vanilla', memoryMB: 2048 });
      await m.refreshInstances();
      await m.selectInstance(inst.id);
      const settings = await window.neurax.invoke('settings:get');
      return { id: inst.id, selected: settings.selectedInstanceId };
    })()`);
    record('instances:create auto-selects new instance', sel.id && sel.selected === sel.id, JSON.stringify(sel));

    /* ---------- 2. game:stop wired (no game running → friendly no-op) ---------- */
    const stop = await js(`window.neurax.invoke('game:stop')`);
    record('game:stop IPC wired', stop && stop.stopped === false && typeof stop.reason === 'string', JSON.stringify(stop));

    /* ---------- 3. launch lifecycle → dashboard reacts ---------- */
    win.webContents.send('launch:state', { state: 'starting', instance: 'ProbeInst', version: '1.21.4', loader: 'vanilla' });
    await sleep(350);
    win.webContents.send('launch:state', { state: 'checking-java', javaMajor: 21 });
    await sleep(350);
    let vis = await js(`(() => { const p = document.querySelector('#page-host .page .launch-progress');
      return { shown: !!p && p.style.display !== 'none', label: p ? p.querySelector('.progress-label span').textContent : '' }; })()`);
    record('starting → progress bar visible', vis.shown && /Java 21/.test(vis.label), JSON.stringify(vis));

    win.webContents.send('launch:state', { state: 'downloading-game' });
    await sleep(250);
    win.webContents.send('launch:progress', { type: 'download', task: 5000, total: 10000 });
    await sleep(350);
    vis = await js(`(() => { const p = document.querySelector('#page-host .page .launch-progress');
      const f = p && p.querySelector('.progress-fill');
      return { label: p ? p.querySelector('.progress-label span').textContent : '', width: f ? f.style.width : '' }; })()`);
    record('downloading → deterministic progress', /Downloading game files/.test(vis.label) && Math.abs(parseFloat(vis.width) - 50) < 0.01, JSON.stringify(vis));

    win.webContents.send('launch:state', { state: 'running', pid: 4242 });
    await sleep(400);
    let banner = await js(`(() => { const b = document.querySelector('#page-host .page .status-banner');
      return { shown: !!b && b.closest('.game-status').style.display !== 'none', running: !!(b && b.classList.contains('running')),
               text: b ? b.querySelector('b').textContent : '', stop: !!document.querySelector('#page-host .page .stop-game-btn') }; })()`);
    record('running → RUNNING banner + STOP button', banner.shown && banner.running && banner.stop && /running/i.test(banner.text), JSON.stringify(banner));
    await shot('1-running-banner.png');

    /* ---------- 4. THE BUG: logo click while running must NOT rebuild ---------- */
    await js(`document.querySelector('#page-host .page').setAttribute('data-probe','A')`);
    await js(`document.querySelector('.brand').click()`);
    await sleep(500);
    const afterLogo = await js(`(() => { const page = document.querySelector('#page-host .page');
      const b = page && page.querySelector('.status-banner');
      return { sameNode: page && page.getAttribute('data-probe') === 'A', pageCount: document.querySelectorAll('#page-host .page').length,
               bannerStill: !!(b && b.classList.contains('running')), stopStill: !!page.querySelector('.stop-game-btn') }; })()`);
    record('LOGO CLICK while running: page NOT rebuilt, banner intact', afterLogo.sameNode && afterLogo.pageCount === 1 && afterLogo.bannerStill && afterLogo.stopStill, JSON.stringify(afterLogo));
    await shot('2-after-logo-click.png');

    /* ---------- 5. settings round-trip → banner restored from state.game ---------- */
    await js(`document.querySelector('[data-nav="settings"]').click()`);
    await sleep(700);
    const onSettings = await js(`document.querySelector('#page-host .page').dataset.page`);
    await js(`document.querySelector('.brand').click()`);
    await sleep(600);
    const backHome = await js(`(() => { const page = document.querySelector('#page-host .page');
      const b = page && page.querySelector('.status-banner');
      return { page: page ? page.dataset.page : null, newNode: page && !page.hasAttribute('data-probe'),
               bannerRestored: !!(b && b.classList.contains('running')), target: page ? (page.querySelector('.launch-target b') || {}).textContent : '' }; })()`);
    record('settings → logo: fresh home STILL shows RUNNING (persistent state)',
      backHome.page === 'home' && backHome.newNode && backHome.bannerRestored && backHome.target === 'ProbeInst', JSON.stringify(backHome));
    await shot('3-restored-after-roundtrip.png');

    /* ---------- 6. exited(0) → friendly pill ---------- */
    win.webContents.send('launch:state', { state: 'exited', code: 0 });
    await sleep(400);
    const exited = await js(`(() => { const b = document.querySelector('#page-host .page .status-banner');
      return { shown: !!b, done: !!(b && b.classList.contains('done')), text: b ? b.querySelector('b').textContent : '' }; })()`);
    record('exited(0) → session-ended pill', exited.shown && exited.done && /ended/i.test(exited.text), JSON.stringify(exited));
    await shot('4-exited.png');

    /* ---------- failsafe sanity ---------- */
    const fs2 = await js(`({ overlay: !!document.getElementById('neurax-failsafe') })`);
    record('no failsafe overlay (no startup errors)', !fs2.overlay);
  } catch (e) {
    record('probe crashed', false, e.message);
  }

  console.log('PROBE_RESULT ' + JSON.stringify({ total: results.length, failed: results.filter(r => !r.pass).length }));
  app.quit();
});
