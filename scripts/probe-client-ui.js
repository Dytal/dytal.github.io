// probe-client-ui.js — UI checks for the Neurax Client settings card (v2.3.0).
// Boots the REAL renderer (no preload → mock bridge) on Xvfb, then:
//   1. Settings shows the NEURAX CLIENT card: enable toggle, FPS segmented
//      control (Ultra preselected), GUI theme segmented control (Match launcher),
//      and the injected mod stack (mock resolves 5 mods for 26.3),
//   2. clicking Balanced persists clientFpsMode and re-renders the stack,
//      GUI theme switch persists clientGuiTheme,
//   3. the theme cards still work (launcher theme switch),
//   4. demo launch lifecycle shows the "Neurax Client: N optimization mods
//      injected" stage on the dashboard,
//   5. screenshots: settings card + dashboard launch stage.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe-client-ui';
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

  const openSettings = async () => {
    await win.webContents.executeJavaScript(`document.querySelector('[data-nav="settings"]').click()`);
    await sleep(1200);
  };

  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(4200); // boot + mock settle
      console.log('— Neurax Client UI probe —');

      /* ---- 1. card renders with all controls ---- */
      await openSettings();
      const card = await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.settings-wrap .card')];
        const c = cards.find(x => x.querySelector('.label')?.textContent === 'Neurax Client');
        if (!c) return null;
        const toggle = c.querySelector('.setting-row .switch input');
        const segs = [...c.querySelectorAll('.seg')];
        const segValues = (seg) => [...seg.querySelectorAll('.seg-btn')].map(b => b.textContent + (b.classList.contains('selected') ? '*' : ''));
        return {
          hasCard: true,
          hasToggle: !!toggle, toggleOn: toggle ? toggle.checked : null,
          seg1: segs[0] ? segValues(segs[0]) : null,
          seg2: segs[1] ? segValues(segs[1]) : null,
          stackChips: [...c.querySelectorAll('.chip b')].map(b => b.textContent),
          versionsHint: [...c.querySelectorAll('.hint')].map(h => h.textContent).find(t => t.includes('26.3') && t.includes('1.21.11')) || null,
        };
      })()`);
      check('Neurax Client card renders', !!card && card.hasCard);
      check('enable toggle present + ON', !!card && card.hasToggle && card.toggleOn === true);
      check('FPS segments Balanced/Ultra with Ultra selected', !!card && JSON.stringify(card.seg1) === JSON.stringify(['Balanced', 'Ultra FPS*']), JSON.stringify(card && card.seg1));
      check('GUI theme segments with Match launcher selected', !!card && card.seg2[0] === 'Match launcher*' && card.seg2[5] === 'Vanilla', JSON.stringify(card && card.seg2));
      check('mock stack resolved (5 mods incl. Sodium + Iris)', !!card && card.stackChips.includes('Sodium') && card.stackChips.includes('Iris') && card.stackChips.length === 5, JSON.stringify(card && card.stackChips));
      check('supported versions hint lists 26.3 + 1.21.11', !!card && /26\.3/.test(card.versionsHint || '') && /1\.21\.11/.test(card.versionsHint || ''), JSON.stringify(card && card.versionsHint));

      /* ---- 2. switch FPS mode + GUI theme, verify persistence ---- */
      await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.settings-wrap .card')];
        const c = cards.find(x => x.querySelector('.label')?.textContent === 'Neurax Client');
        const segs = [...c.querySelectorAll('.seg')];
        segs[0].querySelectorAll('.seg-btn')[0].click(); // Balanced
        segs[1].querySelectorAll('.seg-btn')[3].click(); // Cyan (index 3)
        return true;
      })()`);
      await sleep(900);
      const persisted = await win.webContents.executeJavaScript(`(async () => {
        const s = await window.neurax.invoke('settings:get');
        return { fps: s.clientFpsMode, gui: s.clientGuiTheme };
      })()`);
      check('clientFpsMode=balanced persisted', persisted.fps === 'balanced');
      check('clientGuiTheme=cyan persisted', persisted.gui === 'cyan');
      // restore defaults for screenshot sanity
      await win.webContents.executeJavaScript(`(async () => {
        await window.neurax.invoke('settings:set', { clientFpsMode: 'ultra', clientGuiTheme: 'auto' });
        return true;
      })()`);

      /* ---- 3. launcher theme switch still works ---- */
      await win.webContents.executeJavaScript(`(() => {
        const btn = [...document.querySelectorAll('.theme-card')].find(b => b.dataset.theme === 'purple');
        if (!btn) return null; btn.click(); return true;
      })()`);
      let themeNow = null;
      for (let i = 0; i < 10; i++) {
        themeNow = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
        if (themeNow === 'purple') break;
        await sleep(300);
      }
      check('launcher theme switch works (purple)', themeNow === 'purple', 'theme=' + themeNow);
      await win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('.theme-card')].find(x => x.dataset.theme === 'emerald'); if (b) b.click(); return !!b; })()`);
      await sleep(600);

      const step = async (name, script) => {
        try { return await win.webContents.executeJavaScript(script); }
        catch (e) { console.log(`  (step ${name} failed: ${e.message})`); return null; }
      };

      await step('scrollIntoView', `document.querySelector('[data-nav="settings"]').scrollIntoView()`);
      await win.capturePage().then(img => fs.writeFileSync(path.join(OUT, 'settings-client-card.png'), img.toPNG()));

      /* ---- 4. demo launch shows the client-setup stage ---- */
      await step('nav home', `document.querySelector('.brand').click()`);
      await sleep(900);
      const clicked = await win.webContents.executeJavaScript(`(() => {
        try {
          const play = [...document.querySelectorAll('button')].find(b => /^PLAY/.test((b.textContent || '').trim()));
          if (play) { play.click(); return true; }
          return false;
        } catch (e) { return 'err:' + e.message; }
      })()`);
      check('PLAY clicked on dashboard', clicked === true, String(clicked));
      let sawClientStage = false;
      let lastLabel = '';
      for (let i = 0; i < 24; i++) {
        lastLabel = await win.webContents.executeJavaScript(`(() => { try { return document.body.innerText.match(/Neurax Client[^\\n]*/)?.[0] || ''; } catch (e) { return ''; } })()`).catch(() => '');
        if (lastLabel) { sawClientStage = true; break; }
        await sleep(300);
      }
      check('launch pipeline surfaces the Neurax Client stage', sawClientStage, JSON.stringify(lastLabel));
      await sleep(2500);
      await win.capturePage().then(img => fs.writeFileSync(path.join(OUT, 'launch-client-stage.png'), img.toPNG()));

      console.log(`\nRESULT: ${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`);
      fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
      app.exit(results.some(r => !r.ok) ? 1 : 0);
    } catch (e) {
      console.error('PROBE CRASH:', e);
      app.exit(2);
    }
  });
});
