// probe-hotfix11-ui.js — UI checks for the Settings account HEAD avatar.
// Boots the REAL renderer (no preload → mock bridge) on Xvfb, then:
//   1. default boot (offline account) → settings shows the LETTER chip, no img,
//   2. demo MSA account with a deterministic skin → settings shows the HEAD
//      avatar: a <img> whose src is a data URL produced by the canvas crop —
//      decoded pixel asserts prove the FACE crop and the HAT overlay are right
//      (center = skin tone 198,134,99 · top row = hat purple 88,101,242),
//   3. screenshots both states.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe11';
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

  // reads the account chip state; decodes the head img's pixels when present
  const chipAsserts = `
    (async () => {
      const chip = document.querySelector('.account-chip');
      const img = chip ? chip.querySelector('img') : null;
      const letter = chip ? chip.querySelector('.a-fallback') : null;
      const out = {
        hasChip: !!chip,
        hasImg: !!img,
        letterText: letter ? letter.textContent : null,
        name: chip && chip.querySelector('b') ? chip.querySelector('b').textContent : null,
        buildError: !!(document.querySelector('#page-host .page') || {}).dataset?.buildError,
      };
      if (img) {
        out.srcIsData = (img.getAttribute('src') || '').startsWith('data:image/png;base64,');
        await new Promise(r => { if (img.complete) r(); else { img.onload = r; img.onerror = r; setTimeout(r, 1500); } });
        const c = document.createElement('canvas'); c.width = 72; c.height = 72;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const p = (px, py) => [...x.getImageData(px, py, 1, 1).data].slice(0, 3);
        out.center = p(36, 36); // face center → skin tone
        out.top = p(36, 2);     // hat row → purple overlay
      }
      return out;
    })()
  `;

  const openSettings = async () => {
    await win.webContents.executeJavaScript(`document.querySelector('[data-nav="settings"]').click()`);
    await sleep(1300);
  };
  const pollChip = async () => {
    let last = null;
    for (let i = 0; i < 12; i++) {
      last = await win.webContents.executeJavaScript(chipAsserts);
      if (last.hasImg) break;
      await sleep(400);
    }
    return last;
  };
  const eq = (a, b, tol = 12) => a && a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);

  win.webContents.once('did-finish-load', async () => {
    try {
      /* ---- self-clean: drop any demo account a previous run left behind ---- */
      await win.webContents.executeJavaScript(
        `localStorage.removeItem('__neuraxDemoAccount'); 'cleared'`);
      await win.webContents.executeJavaScript(`location.reload()`);
      await sleep(4200); // boot + mock settle

      /* ---- scenario 1: offline default → letter chip, no img ---- */
      await openSettings();
      const s1 = await win.webContents.executeJavaScript(chipAsserts);
      console.log('OFFLINE ' + JSON.stringify(s1));
      check('settings page builds (offline)', !s1.buildError && s1.hasChip);
      check('offline account shows LETTER fallback', s1.letterText === 'S' && !s1.hasImg, JSON.stringify(s1.letterText));
      fs.writeFileSync(path.join(OUT, 'settings-offline.png'),
        (await win.webContents.capturePage()).toPNG());

      /* ---- scenario 2: MSA account with skin → HEAD avatar ---- */
      await win.webContents.executeJavaScript(`
        window.__neuraxDemo.setAccount({
          type: 'msa', name: 'NeuraxPlayer', uuid: 'demo-uuid-1234', accessToken: 'demo',
          skin: { id: 's1', state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/demo' },
        });
        location.reload();
      `);
      await sleep(4200); // boot again
      await openSettings();
      const s2 = await pollChip();
      console.log('MSA ' + JSON.stringify(s2));
      check('settings page builds (MSA)', !s2.buildError && s2.hasChip);
      check('chip shows the account name', s2.name === 'NeuraxPlayer', JSON.stringify(s2.name));
      check('HEAD avatar <img> replaced the letter chip', s2.hasImg && !s2.letterText, JSON.stringify(s2.letterText));
      check('avatar src is a canvas-produced PNG data URL', s2.srcIsData);
      check('face crop correct (center = skin tone 198,134,99)', eq(s2.center, [198, 134, 99]), JSON.stringify(s2.center));
      check('hat overlay correct (top row = purple 88,101,242)', eq(s2.top, [88, 101, 242]), JSON.stringify(s2.top));
      fs.writeFileSync(path.join(OUT, 'settings-msa-head.png'),
        (await win.webContents.capturePage()).toPNG());

      /* ---- app shell health ---- */
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
