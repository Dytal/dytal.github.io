// probe-hotfix7.js — verification for: Modrinth install selection, settings
// see-through gaps, login persistence (no more forced re-login).
// Window A: NO preload → mock bridge → drive the REAL installFlow modal DOM.
// Window B: REAL preload → auth:sessionInfo / currentAccount no-downgrade + opaque pages.
'use strict';
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); // headless-safe (Xvfb has no GPU)
const path = require('path');
const fs = require('fs');

const SHOT_DIR = process.env.PROBE_SHOT || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const record = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`PROBE ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ' | ' + detail : ''}`);
};
const js = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => {
  if (!SHOT_DIR) return;
  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    console.log('SHOT ' + name);
  } catch (e) { console.log('SHOT_FAIL ' + name + ' ' + e.message); }
};

app.whenReady().then(async () => {
  require('../src/main/ipc').register();

  /* ================= WINDOW A — mock bridge (install flow) ================= */
  const winA = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  winA.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => winA.webContents.once('did-finish-load', r));
  await sleep(3500);

  try {
    // --- full picker: version + target + Install button ---
    const full = await js(winA, `(async () => {
      const m = await import('./js/pages/store-common.js');
      let installed = null;
      const versions = [
        { id: 'v1', version_number: '1.0.0', date_published: new Date().toISOString(), game_versions: ['1.21.4'], loaders: ['fabric'] },
        { id: 'v2', version_number: '0.9.0', date_published: new Date().toISOString(), game_versions: ['1.21.1'], loaders: ['fabric'] },
      ];
      const p = m.installFlow({ provider: 'modrinth', projectName: 'ProbeMod',
        doInstall: async (t, v) => { installed = { target: t, version: v ? v.version_number : null }; return { file: 'probe.jar' }; },
        versions });
      await new Promise(r => setTimeout(r, 300)); // modal renders
      const modal = document.querySelector('.modal-backdrop:last-of-type');
      const pick = (txt) => [...modal.querySelectorAll('.pick-item')].find(x => x.textContent.includes(txt));
      // select version v2 (0.9.0)
      pick('0.9.0')?.click();
      await new Promise(r => setTimeout(r, 120));
      // select the INSTANCE target (mock has 3 instances; pick 'NeoTech')
      pick('NeoTech')?.click();
      await new Promise(r => setTimeout(r, 120));
      const selCount = modal.querySelectorAll('.pick-item.selected').length;
      const selTexts = [...modal.querySelectorAll('.pick-item.selected')].map(x => x.querySelector('b').textContent);
      // click Install
      [...modal.querySelectorAll('.modal-actions .btn')].find(b => b.textContent === 'Install')?.click();
      const result = await Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), 3000))]);
      return { selCount, selTexts, result: result === 'TIMEOUT' ? 'TIMEOUT' : 'RESOLVED', installed,
               modalGone: !document.body.contains(modal) };
    })()`);
    record('full picker: version AND target rows show selected state', full.selCount === 2 && full.selTexts.includes('NeoTech') && full.selTexts.includes('0.9.0'), JSON.stringify(full.selTexts));
    record('full picker: Install resolves and calls doInstall with target+version', full.result === 'RESOLVED' && full.installed && full.installed.target.type === 'instance' && full.installed.version === '0.9.0', JSON.stringify(full.installed));
    record('full picker: modal actually closed after install', full.modalGone === true);

    await sleep(300);
    // --- quick path (no versions): click target → flow must resolve immediately ---
    const quick = await js(winA, `(async () => {
      const m = await import('./js/pages/store-common.js');
      let got = null;
      const p = m.installFlow({ provider: 'modrinth', doInstall: async (t) => { got = t; return { files: 1 }; }, versions: null });
      await new Promise(r => setTimeout(r, 300));
      const modal = document.querySelector('.modal-backdrop:last-of-type');
      [...modal.querySelectorAll('.pick-item')].find(x => x.textContent.includes('Global'))?.click();
      const result = await Promise.race([p, new Promise(r => setTimeout(() => r('TIMEOUT'), 3000))]);
      return { result, got, selectedShown: !!modal.querySelector && null };
    })()`);
    record('quick path: clicking a target resolves the install (was silently dead)', quick.result !== 'TIMEOUT' && quick.got && quick.got.type === 'global', JSON.stringify({ result: quick.result, got: quick.got }));

    await sleep(300);
    // --- selection visuals close-up ---
    await js(winA, `(async () => {
      const m = await import('./js/pages/store-common.js');
      m.installFlow({ provider: 'modrinth', doInstall: async () => ({ file: 'x' }), versions: null });
      await new Promise(r => setTimeout(r, 250));
      const modal = document.querySelector('.modal-backdrop:last-of-type');
      [...modal.querySelectorAll('.pick-item')].find(x => x.textContent.includes('Classic Survival'))?.click();
    })()`);
    await sleep(300);
    await shot(winA, '5-install-selected.png');

    /* ---------- settings page: opaque background + single page node (window A — mock, no network) ---------- */
    await js(winA, `document.querySelector('.modal-backdrop:last-of-type')?.remove()`);
    await js(winA, `document.querySelector('[data-nav="settings"]').click()`);
    await sleep(250); // mid-transition
    const midTransition = await js(winA, `(() => {
      const pages = document.querySelectorAll('#page-host .page');
      const top = pages[pages.length - 1];
      const cs = getComputedStyle(top);
      return { count: pages.length, bg: cs.backgroundColor, opaque: cs.backgroundColor.startsWith('rgb(') && !cs.backgroundColor.startsWith('rgba(0, 0, 0, 0)') };
    })()`);
    await sleep(700);
    const settled = await js(winA, `(() => ({ count: document.querySelectorAll('#page-host .page').length }))()`);
    record('settings page is OPAQUE (no see-through gaps)', midTransition.opaque, midTransition.bg);
    record('old page fully removed after transition (single .page)', settled.count === 1, JSON.stringify(settled));
    const chip = await js(winA, `(() => { const c = document.querySelector('.account-chip'); return c ? c.querySelector('b').textContent : null; })()`);
    record('settings account chip renders', !!chip, chip);
    await shot(winA, '6-settings-opaque.png');
  } catch (e) { record('window A probe crashed', false, e.message); }
  winA.hide(); // NOT destroy() — closing the only window would quit the app on Linux

  /* ================= WINDOW B — real preload (auth + opacity) ================= */
  const winB = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  winB.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => winB.webContents.once('did-finish-load', r));
  await sleep(4500);

  try {
    // --- auth:sessionInfo exists ---
    const info = await js(winB, `window.neurax.invoke('auth:sessionInfo')`);
    record('auth:sessionInfo wired', info && typeof info.hasSavedLogin === 'boolean', JSON.stringify(info));

    // --- THE REGRESSION: saved MSA tokens + failed refresh must NOT downgrade to offline ---
    const regression = await js(winB, `(async () => {
      const settings = await window.neurax.invoke('settings:get');
      return settings.lastAccount; // should be null in the fresh probe HOME
    })()`);
    // plant a saved MSA token file with a bogus refresh token (refresh will fail online)
    await js(winB, `true`); // noop
    const planted = await (async () => {
      // plant via the main process side (fs) — tokens.json under appData/.neurax/auth
      const { DIRS } = require('../src/main/core/paths');
      const f = path.join(DIRS.auth, 'tokens.json');
      fs.mkdirSync(DIRS.auth, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({
        flow: 'live',
        msRefresh: { enc: 'plain', v: Buffer.from('bogus-refresh-token').toString('base64') },
        msAccess: { enc: 'plain', v: Buffer.from('bogus').toString('base64') },
        msAccessExp: 1,
        clientId: { enc: 'plain', v: Buffer.from('00000000402b5328').toString('base64') },
        profile: { name: 'RememberedUser', uuid: 'abc' },
      }));
      return f;
    })();
    const afterFail = await js(winB, `(async () => {
      const acc = await window.neurax.invoke('auth:current');          // refresh will fail (bogus token)
      const info2 = await window.neurax.invoke('auth:sessionInfo');    // hasSavedLogin must still be true
      const settings = await window.neurax.invoke('settings:get');
      return { acc, info2, lastAccount: settings.lastAccount };
    })()`);
    record('failed refresh returns null (no fake offline account)', afterFail.acc === null, JSON.stringify(afterFail.acc));
    record('failed refresh KEEPS the saved login on disk', afterFail.info2.hasSavedLogin === true && afterFail.info2.profileName === 'RememberedUser', JSON.stringify(afterFail.info2));
    record('failed refresh does NOT overwrite lastAccount to offline', afterFail.lastAccount === null || afterFail.lastAccount.type !== 'offline', JSON.stringify(afterFail.lastAccount));
    // NOTE: settings-page visuals are checked in window A (mock) — window B stays
    // auth-only because every extra auth:current against a bogus token burns a
    // real 25s network timeout here in the sandbox.
  } catch (e) { record('window B probe crashed', false, e.message); }

  console.log('PROBE_RESULT ' + JSON.stringify({ pass, fail }));
  app.quit();
});
