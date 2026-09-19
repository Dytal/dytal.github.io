// probe-hotfix9-ui.js — UI checks for the Servers page state-hydration fix.
// Boots the REAL renderer (no preload → mock bridge) on Xvfb, then:
//   1. opens SERVERS and asserts the console HYDRATES (demo log lines) and the
//      Copy / Clear console buttons + Start button render,
//   2. does the exact user round-trip: logo → home → SERVERS again, asserting
//      the page rebuilds WITHOUT losing the console and without errors,
//   3. screenshots both visits.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe9';
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond, extra });
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
  };

  const pageAsserts = `
    (async () => {
      const page = document.querySelector('#page-host .page');
      const consoleEl = page && page.querySelector('.console');
      const lines = consoleEl ? [...consoleEl.querySelectorAll('.log-line')].map(n => n.textContent) : [];
      const btns = [...page.querySelectorAll('button')].map(b => (b.textContent || '').trim());
      const startBtn = btns.find(t => t.includes('Start server'));
      const stopBtn = btns.find(t => t.includes('Stop server'));
      const forceBtn = btns.find(t => t.includes('Force stop'));
      const copyBtn = btns.find(t => t === 'Copy');
      const clearBtn = btns.find(t => /^Clear$/.test(t));
      const chips = [...page.querySelectorAll('.chip')].map(c => c.textContent.trim());
      const runChip = chips.find(c => c.startsWith('RUNNING') || c === 'stopped');
      const cmdInput = !!page.querySelector('.console-input input');
      const placeholder = lines.some(l => l.includes('console output appears here'));
      const hydrated = lines.some(l => l.includes('Done (3.214s)!')) && lines.some(l => l.includes('Starting minecraft server'));
      return { lines: lines.length, hydrated, placeholder, startBtn: !!startBtn, stopBtn: !!stopBtn,
               forceBtn: !!forceBtn, copyBtn: !!copyBtn, clearBtn: !!clearBtn, runChip, cmdInput,
               buildError: !!(page && page.dataset.buildError) };
    })()
  `;

  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise(r => setTimeout(r, 4200)); // boot + mock settle

      /* ---- visit 1: SERVERS ---- */
      await win.webContents.executeJavaScript(`document.querySelector('[data-nav="servers"]').click()`);
      await new Promise(r => setTimeout(r, 1400));
      const v1 = await win.webContents.executeJavaScript(pageAsserts);
      console.log('VISIT1 ' + JSON.stringify(v1));
      check('servers page builds without error (visit 1)', !v1.buildError);
      check('console HYDRATES history from the engine (visit 1)', v1.hydrated, `lines=${v1.lines}`);
      check('Copy console button present', v1.copyBtn);
      check('Clear console button present', v1.clearBtn);
      check('Start server button present (server stopped)', v1.startBtn && !v1.stopBtn && !v1.forceBtn);
      check('status chip shows stopped (engine truth: not running)', v1.runChip === 'stopped');
      check('console command input present', v1.cmdInput);
      const shot1 = path.join(OUT, 'servers-visit1.png');
      fs.writeFileSync(shot1, (await win.webContents.capturePage()).toPNG());
      console.log('SHOT_SAVED ' + shot1);

      /* ---- THE BUG ROUND-TRIP: logo → home → SERVERS ---- */
      await win.webContents.executeJavaScript(`document.querySelector('.brand').click()`);
      await new Promise(r => setTimeout(r, 1200));
      const onHome = await win.webContents.executeJavaScript(
        `!!document.querySelector('#page-host .page[data-page="home"]')`);
      check('logo navigates to home/dashboard', onHome);
      await win.webContents.executeJavaScript(`document.querySelector('[data-nav="servers"]').click()`);
      await new Promise(r => setTimeout(r, 1400));
      const v2 = await win.webContents.executeJavaScript(pageAsserts);
      console.log('VISIT2 ' + JSON.stringify(v2));
      check('servers page builds without error (visit 2, after round-trip)', !v2.buildError);
      check('console still shows its history after the round-trip (BUG FIXED)', v2.hydrated, `lines=${v2.lines}`);
      check('Copy/Clear buttons present after round-trip', v2.copyBtn && v2.clearBtn);
      const shot2 = path.join(OUT, 'servers-visit2.png');
      fs.writeFileSync(shot2, (await win.webContents.capturePage()).toPNG());
      console.log('SHOT_SAVED ' + shot2);

      /* ---- global run-state listener sanity: state.js registered without crash ---- */
      const healthy = await win.webContents.executeJavaScript(
        `({ booted: !!document.querySelector('#navbar'), overlay: !!document.getElementById('neurax-failsafe') })`);
      check('app shell healthy (navbar present, no failsafe overlay)', healthy.booted && !healthy.overlay);
    } catch (e) {
      console.error('PROBE_FAIL ' + e.message);
      results.push({ name: 'probe executed', ok: false, extra: e.message });
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    app.quit();
    setTimeout(() => process.exit(failed ? 1 : 0), 500);
  });
});
