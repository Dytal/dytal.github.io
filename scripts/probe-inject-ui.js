// probe-inject-ui.js — UI checks for the v2.3.1 instance injection rollout.
// Boots the REAL renderer (no preload → mock bridge) on Xvfb, then:
//   1. INSTANCE dropdown shows the CLIENT chip on injected 26.1.2 instances
//      and NO chip on the un-injected one,
//   2. double-click opens the edit modal with the Neurax Client section
//      ("Inject Neurax Client" + status line for in-scope instances),
//   3. clicking Inject flips the demo instance to injected: status text,
//      Re-inject/Remove buttons, chip appears after refresh,
//   4. Remove clears the chip again,
//   5. out-of-scope instance edit modal has NO client section,
//   6. screenshots at each step.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe-inject-ui';
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
  const shot = (name) => win.webContents.capturePage().then(img => fs.writeFileSync(path.join(OUT, name), img.toPNG()));

  const openInstances = async () => {
    // resilient: the INSTANCE button toggles — if a stale 'open' state swallowed
    // the click, press it again until the rows are actually visible
    for (let attempt = 0; attempt < 4; attempt++) {
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(b => b.dataset.nav === 'instances')?.click()`);
      await sleep(650);
      const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.dd-inst .dd-item').length`);
      if (n >= 5) return true;
      await win.webContents.executeJavaScript(`document.body.click()`);
      await sleep(350);
    }
    return false;
  };
  const closeDropdown = async () => win.webContents.executeJavaScript(`document.body.click()`).then(() => sleep(350));

  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(4200); // boot + mock settle
      console.log('— Neurax Client instance injection UI probe —');

      /* ---- 1. dropdown chips ---- */
      await openInstances();
      const chips1 = await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        return rows.map(r => ({
          name: r.querySelector('.dd-inst-meta b')?.textContent,
          version: r.querySelector('.dd-inst-meta span')?.textContent,
          chip: !!r.querySelector('.nx-client-chip'),
        }));
      })()`);
      const injectedRow = chips1.find(r => r.name === 'Neurax 26.1.2');
      const vanillaRow = chips1.find(r => r.name === 'Vanilla 26.1.2');
      const otherRow = chips1.find(r => r.name === 'Performance+');
      check('dropdown lists the demo 26.1.2 instances', !!injectedRow && !!vanillaRow, JSON.stringify(chips1));
      check('CLIENT chip on the injected instance', injectedRow && injectedRow.chip === true);
      check('no chip on the not-yet-injected 26.1.2 instance', vanillaRow && vanillaRow.chip === false);
      check('no chip on out-of-scope instances', otherRow && otherRow.chip === false);
      await shot('1-dropdown-chips.png');

      /* ---- 2. edit modal: not-injected instance shows the client section ---- */
      await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        const row = rows.find(r => r.querySelector('.dd-inst-meta b')?.textContent === 'Vanilla 26.1.2');
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      })()`);
      await sleep(650);
      const modal1 = await win.webContents.executeJavaScript(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return null;
        const section = m.querySelector('.nx-client-edit');
        return {
          hasModal: true,
          hasSection: !!section,
          injectBtn: [...m.querySelectorAll('.nx-client-edit button')].map(b => b.textContent).join('|'),
          status: section?.querySelector('.hint')?.textContent || '',
        };
      })()`);
      check('edit modal opens with Neurax Client section', modal1 && modal1.hasSection, JSON.stringify(modal1));
      check('shows "Inject Neurax Client" + Remove hidden', modal1 && /Inject Neurax Client/.test(modal1.injectBtn), modal1 ? modal1.injectBtn : 'no modal');
      await shot('2-modal-not-injected.png');

      /* ---- 3. click Inject -> instance flips to injected ---- */
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .nx-client-edit button')].find(b => b.textContent.includes('Inject'))?.click()`);
      await sleep(1400); // demo handler delay(120) + event delay(250) + refreshInstances
      const modal2 = await win.webContents.executeJavaScript(`(() => {
        const m = document.querySelector('.modal');
        if (!m) return null;
        const section = m.querySelector('.nx-client-edit');
        return {
          status: section?.querySelector('.hint')?.textContent || '',
          btns: [...m.querySelectorAll('.nx-client-edit button')].map(b => b.textContent).join('|'),
          removeVisible: [...m.querySelectorAll('.nx-client-edit button')].some(b => b.textContent === 'Remove' && b.style.display !== 'none'),
        };
      })()`);
      check('modal now shows Injected status', modal2 && /Injected —/.test(modal2.status), modal2 ? modal2.status : 'no modal');
      check('Re-inject + Remove buttons now available', modal2 && /Re-inject/.test(modal2.btns) && modal2.removeVisible, modal2 ? modal2.btns : 'no modal');
      await shot('3-modal-injected.png');
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent === 'Cancel')?.click()`);
      await sleep(500);

      /* ---- 4. chip appears after injection ---- */
      await openInstances();
      const chips2 = await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        return rows.map(r => ({ name: r.querySelector('.dd-inst-meta b')?.textContent, chip: !!r.querySelector('.nx-client-chip') }));
      })()`);
      check('CLIENT chip appears on the freshly injected instance', chips2.find(r => r.name === 'Vanilla 26.1.2')?.chip === true, JSON.stringify(chips2));
      await closeDropdown();

      /* ---- 5. remove flow ---- */
      await openInstances();
      const dbl = await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        const row = rows.find(r => r.querySelector('.dd-inst-meta b')?.textContent === 'Vanilla 26.1.2');
        if (!row) return { found: false, names: rows.map(r => r.querySelector('.dd-inst-meta b')?.textContent) };
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return { found: true };
      })()`);
      check('re-opened dropdown to remove the client', dbl && dbl.found, JSON.stringify(dbl));
      await sleep(600);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .nx-client-edit button')].find(b => b.textContent === 'Remove')?.click()`);
      await sleep(1100);
      await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent === 'Cancel')?.click()`);
      await sleep(500);
      await openInstances();
      const chips3 = await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        return rows.map(r => ({ name: r.querySelector('.dd-inst-meta b')?.textContent, chip: !!r.querySelector('.nx-client-chip') }));
      })()`);
      check('Remove clears the chip again', chips3.find(r => r.name === 'Vanilla 26.1.2')?.chip === false, JSON.stringify(chips3));
      await closeDropdown();

      /* ---- 6. out-of-scope edit modal has NO client section ---- */
      await openInstances();
      await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.dd-inst .dd-item')];
        const row = rows.find(r => r.querySelector('.dd-inst-meta b')?.textContent === 'Performance+');
        if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      })()`);
      await sleep(600);
      const modal3 = await win.webContents.executeJavaScript(`(() => {
        const m = document.querySelector('.modal');
        return { hasModal: !!m, hasSection: !!(m && m.querySelector('.nx-client-edit')) };
      })()`);
      check('out-of-scope instance: edit modal without client section', modal3.hasModal && !modal3.hasSection, JSON.stringify(modal3));
      await shot('4-modal-out-of-scope.png');

      const okCount = results.filter(r => r.ok).length;
      console.log(`\nRESULT: ${okCount}/${results.length} passed (shots in ${OUT})`);
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      setTimeout(() => app.exit(okCount === results.length ? 0 : 1), 300);
    } catch (e) {
      console.error('PROBE CRASH:', e);
      app.exit(1);
    }
  });
});
