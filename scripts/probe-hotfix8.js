// probe-hotfix8.js — headless regression probe for the Java-detection hotfix.
// Boots the REAL app under Xvfb, then asserts:
//  1. app boots with zero renderer errors (no failsafe overlay)
//  2. java:discover returns real results (or an empty array on java-less CI)
//     — and NEVER throws "not detectable" behaviour: every probed binary that
//     runs must yield a parseable major version
//  3. settings page renders with the Java scan section visible
//  4. parseJavaVersion + javaMajorFor contracts hold inside the real renderer/preload env
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

app.disableHardwareAcceleration(); // headless-safe (Xvfb has no GPU)
// container-safe GPU fallbacks: some CI environments abort with
// "GPU process isn't usable. Goodbye." unless these are set
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-dev-shm-usage');

const { DIRS } = require('../src/main/core/paths');

let gotErrors = [];

async function main() {
  // engine-side contract checks (real java.js module, not mocked)
  const j = require('../src/main/core/java');
  check('parseJavaVersion: temurin 25 stderr blob', j.parseJavaVersion('openjdk version "25.0.4.1" 2026-01-20\nOpenJDK Runtime Environment Temurin-25.0.4.1+1') === 25);
  check('parseJavaVersion: legacy 1.8', j.parseJavaVersion('java version "1.8.0_402"') === 8);
  check('parseJavaVersion: garbage -> 0', j.parseJavaVersion('nope') === 0);
  check('javaMajorFor: 26.1.2 -> 25', j.javaMajorFor('26.1.2') === 25);

  // discovery must at least run and return an array (CI box may have no java)
  const found = await j.discoverJavas({ fresh: true });
  check('discoverJavas returns an array', Array.isArray(found));
  if (found.length) {
    check('every discovered java has major >= 8', found.every(x => x.major >= 8), found.map(x => x.major).join(','));
    check('every discovered java has a source tag', found.every(x => ['system', 'neurax', 'override'].includes(x.source)));
  } else {
    check('empty discovery tolerated (CI without java)', true);
  }

  // ready-marker round-trip inside a fake runtime dir
  const fakeMajor = 90;
  const fakeExe = path.join(DIRS.runtimes, `java-${fakeMajor}`, 'jdk-fake-jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
  fs.writeFileSync(fakeExe, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  fs.writeFileSync(path.join(DIRS.runtimes, `java-${fakeMajor}`, 'jdk-fake-jre', 'release'), 'JAVA_VERSION="90"\n');
  fs.writeFileSync(path.join(DIRS.runtimes, `java-${fakeMajor}`, '.neurax-ready.json'), JSON.stringify({ major: fakeMajor, javaPath: fakeExe, installedAt: Date.now() }));
  // ensureJava must prefer the marker'd runtime fast path… but the fake java can't
  // report a real version, so it must NOT be trusted — this asserts the guard works
  let r = null, threw = false, errMsg = '';
  try { r = await j.ensureJava(fakeMajor); } catch (e) { threw = true; errMsg = e.message; }
  check('ensureJava refuses a fake/broken markered runtime (falls back or throws cleanly)',
    threw || r.path !== fakeExe, threw ? `threw cleanly: ${errMsg.slice(0, 60)}` : `picked ${path.basename(r.path)}`);
  try { fs.rmSync(path.join(DIRS.runtimes, `java-${fakeMajor}`), { recursive: true, force: true }); } catch {}

  // real app boot (same recipe as probe-dashboard.js: IPC wired manually, sandbox off)
  require('../src/main/ipc').register();
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(__dirname, '..', 'src', 'main', 'preload.js') },
  });
  gotErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) gotErrors.push(message);
  });
  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`load failed ${code}: ${desc}`)));
  });
  await new Promise(r => setTimeout(r, 3500));

  const boot = await win.webContents.executeJavaScript(
    `({ booted: typeof window.__neuraxMarkBooted === 'function',
        navbar: !!document.querySelector('#navbar'),
        page: document.querySelector('#page-host .page')?.dataset.page || null,
        overlay: !!document.getElementById('neurax-failsafe') })`);
  check('renderer booted (module graph alive, no failsafe overlay)', boot.booted && boot.navbar && !boot.overlay);
  check('home page rendered', boot.page === 'home');

  // drive the renderer through java:discover via the real preload bridge
  const bridge = await win.webContents.executeJavaScript(
    `(async () => {
      const r = await window.neurax.invoke('java:discover', { fresh: true });
      if (!r.ok) return { err: r.error };
      return { list: r.data.map(j => ({ major: j.major, source: j.source || 'legacy' })) };
    })()`);
  check('renderer java:discover round-trips through preload+ipc', !bridge.err, bridge.err || `${bridge.list.length} runtime(s)`);

  // open settings and confirm the Java section paints the list
  const nav = await win.webContents.executeJavaScript(
    `(async () => {
      document.querySelector('[data-nav="settings"]')?.click();
      await new Promise(r => setTimeout(r, 900));
      const page = document.querySelector('.page[data-page="settings"]');
      const chips = page ? [...page.querySelectorAll('.chip')].filter(c => /Java \\d/.test(c.textContent)) : [];
      const rescan = page ? [...page.querySelectorAll('button')].find(b => b.textContent.trim() === 'Rescan') : null;
      return { present: !!page, chips: chips.length, hasRescan: !!rescan };
    })()`);
  check('settings page renders', nav.present);
  check('settings shows discovered Java chips', nav.chips >= 1, `${nav.chips} chip(s)`);
  check('Rescan button present', nav.hasRescan);

  check('zero renderer console errors', gotErrors.length === 0, gotErrors.slice(0, 3).join(' | ') || 'clean');
}

console.log('probe: waiting for app ready');
app.whenReady().then(() => {
  console.log('probe: entering main');
  return main();
})
  .catch(e => { check('probe completed without crash', false, e.message); })
  .finally(() => {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n${pass}/${results.length} checks passed`);
    app.exit(pass === results.length ? 0 : 1);
  });
