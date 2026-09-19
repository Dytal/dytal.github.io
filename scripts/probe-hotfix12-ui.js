// probe-hotfix12-ui.js — UI checks for the boot-unblocking fix.
// Reproduces the user's exact bug: auth:current is DELAYED 20s (simulating a
// slow Microsoft silent-refresh on a bad network — the thing that used to
// block boot past the 15s failsafe with a "missing file" message).
//   1. at ~5s: navbar + home page present, stage 'ready', NO failsafe overlay
//   2. at ~16.5s: STILL no overlay (previously it fired at 15s)
//   3. at ~21s: the late account lands → settings chip shows it (live update)
//   4. screenshots of both phases.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe12';
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);

  const shellAsserts = `
    ({
      booted: !!document.querySelector('#navbar'),
      home: !!document.querySelector('#page-host .page[data-page="home"]'),
      overlay: !!document.getElementById('neurax-failsafe'),
      stage: window.__neuraxBootStage || 'none',
    })
  `;

  win.webContents.once('did-finish-load', async () => {
    try {
      /* self-clean + arm the bug scenario: auth:current takes 20s, account
         arrives LATE as an MSA login named LateUser */
      await js(`
        localStorage.removeItem('__neuraxDemoAccount');
        localStorage.removeItem('__neuraxSlowChannels');
        localStorage.setItem('__neuraxDemoAccount', JSON.stringify({
          type: 'msa', name: 'LateUser', uuid: 'late-uuid-1', accessToken: 'demo',
          skin: { id: 's', state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/demo' },
        }));
        localStorage.setItem('__neuraxSlowChannels', JSON.stringify({ 'auth:current': 20000 }));
        'armed'`);
      await js(`location.reload()`);
      const t0 = Date.now();
      await sleep(4800); // boot settles well before the 15s watchdog

      /* ---- phase 1: UI must be UP long before 15s ---- */
      const p1 = await js(shellAsserts);
      console.log('T+' + Math.round((Date.now() - t0) / 1000) + 's ' + JSON.stringify(p1));
      check('navbar mounted', p1.booted);
      check('home page rendered', p1.home);
      check('boot stage is "ready"', p1.stage === 'ready', p1.stage);
      check('NO failsafe overlay (bug fixed — boot not blocked by slow auth)', !p1.overlay);
      fs.writeFileSync(path.join(OUT, 'boot-fast.png'), (await win.webContents.capturePage()).toPNG());

      /* ---- phase 2: past the old 15s trigger — still no overlay ---- */
      await sleep(11700); // ≈16.5s total
      const p2 = await js(shellAsserts);
      console.log('T+' + Math.round((Date.now() - t0) / 1000) + 's ' + JSON.stringify(p2));
      check('past 15s: still NO failsafe overlay (watchdog disarmed)', p2.booted && !p2.overlay);

      /* ---- phase 3: the 20s auth:current lands → chip updates live ---- */
      await sleep(5200); // ≈21.7s total — account resolved
      await js(`document.querySelector('[data-nav="settings"]').click()`);
      await sleep(1200);
      const chip = await js(`
        (() => {
          const chip = document.querySelector('.account-chip');
          return {
            name: chip && chip.querySelector('b') ? chip.querySelector('b').textContent : null,
            letter: chip && chip.querySelector('.a-fallback') ? chip.querySelector('.a-fallback').textContent : null,
            hasHead: !!(chip && chip.querySelector('img')),
            buildError: !!(document.querySelector('#page-host .page') || {}).dataset?.buildError,
          };
        })()
      `);
      console.log('CHIP ' + JSON.stringify(chip));
      check('settings page builds (late account)', !chip.buildError && chip.name !== null);
      check('late-arriving account shows in the chip (live EVENTS.ACCOUNT update)',
        chip.name === 'LateUser' && chip.letter === null, JSON.stringify(chip));
      check('head avatar rendered from demo skin', chip.hasHead);
      fs.writeFileSync(path.join(OUT, 'late-account.png'), (await win.webContents.capturePage()).toPNG());

      /* cleanup so other probes get a clean slate */
      await js(`
        localStorage.removeItem('__neuraxDemoAccount');
        localStorage.removeItem('__neuraxSlowChannels');
        'cleaned'`);
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
