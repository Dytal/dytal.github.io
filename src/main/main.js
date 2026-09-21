// main.js — Electron entry. 1200x800 default window, resizable/maximizable/fullscreen,
// no console windows anywhere (windowsHide enforced globally), logs popup window.
'use strict';
const { app, BrowserWindow, shell, Menu, globalShortcut, session } = require('electron');
const path = require('path');

/* ---- v4 LOW-VRAM / LOW-RAM ENGINE TUNING --------------------------------
   Built for small GPUs (e.g. 400MB shared VRAM). UI animations stay fully
   GPU-composited — we only drop capabilities the launcher NEVER uses
   (WebGL/3D contexts, accelerated canvas, MSAA buffers) and cap Chromium's
   memory pools. Measured effect: dramatically lower VRAM + a hard RAM ceiling
   on renderer heaps, zero visual difference. */
app.commandLine.appendSwitch('enable-low-end-device-mode');   // Chromium low-end profile: small tiles, tight GPU/image caches
app.commandLine.appendSwitch('renderer-process-limit', '2');  // main + logs window share up to 2 renderers
app.commandLine.appendSwitch('disable-webgl');                // launcher renders no 3D — WebGL contexts are the #1 VRAM hog
app.commandLine.appendSwitch('disable-webgl2');
app.commandLine.appendSwitch('disable-3d-apis');
app.commandLine.appendSwitch('disable-accelerated-2d-canvas'); // no <canvas> in the UI either
app.commandLine.appendSwitch('gpu-rasterization-msaa-sample-count', '0'); // kills MSAA render targets (big VRAM saver)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=16'); // renderer heap ceiling → RAM stays predictable

// Ensure no child process can ever open a console window on Windows (java, installers, etc.)
// ⚠ These wrappers MUST normalize arguments exactly like Node does, otherwise calls
// like exec(cmd, cb) / execFile(file, options, cb) break with
// ERR_INVALID_ARG_TYPE: The "callback" argument must be of type function.
// That bug used to crash MCLC's Java check (child.exec) at launch.
const cp = require('child_process');
const isWin = process.platform === 'win32';
const origSpawn = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  // supports spawn(cmd, options), spawn(cmd, args, options)
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const o = { ...args };
    if (isWin && o.windowsHide !== false) o.windowsHide = true;
    return origSpawn.call(this, cmd, o);
  }
  const o = { ...(opts || {}) };
  if (isWin && o.windowsHide !== false) o.windowsHide = true;
  return origSpawn.call(this, cmd, args, o);
};
const origExecFile = cp.execFile;
cp.execFile = function (file, args, options, callback) {
  // mirror Node's normalizeExecFileArgs for every call form, then inject windowsHide
  let a = args, o = options, cb = callback;
  if (Array.isArray(a)) {
    a = a.slice();
  } else if (a != null && typeof a === 'object') {
    cb = o; o = a; a = null;
  } else if (typeof a === 'function') {
    cb = a; o = null; a = null;
  }
  if (typeof o === 'function') { cb = o; o = null; }
  if (o != null && typeof o !== 'object') throw new TypeError('options argument must be an object');
  o = { ...(o || {}) };
  if (isWin && o.windowsHide !== false) o.windowsHide = true;
  return origExecFile.call(this, file, a, o, cb);
};

const { ensureDirs, DIRS } = require('./core/paths');
const settingsMod = require('./core/settings');
const logger = require('./core/logger');
const auth = require('./core/auth');
const game = require('./core/game');
const servers = require('./core/servers');
const identity = require('./core/device-identity');
const nxCloud = require('./core/nx-cloud');
const nxInject = require('./core/nx-inject');
const crashDoctor = require('./core/crash-doctor');

// Never die silently: log unexpected main-process errors (file + stderr).
process.on('uncaughtException', (err) => {
  try { logger.core.error('Uncaught main-process error: ' + (err.stack || err.message)); } catch (_) {}
  console.error('[neurax] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  try { logger.core.error('Unhandled rejection: ' + (err && err.stack || String(err))); } catch (_) {}
});

let mainWindow = null;
let logsWindow = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureDirs();
    settingsMod.load();
    Menu.setApplicationMenu(null); // no default menu (no terminal shortcuts)

    // v4: microphone permission for NX voice chat (own window only) — everything
    // else keeps the default deny so voice never silently fails on Windows.
    try {
      const ses = session.defaultSession;
      ses.setPermissionRequestHandler((wc, permission, cb) => {
        try {
          const ours = wc && wc.getURL ? wc.getURL().startsWith('file://') : false;
          cb(permission === 'media' && ours);
        } catch { cb(false); }
      });
      ses.setPermissionCheckHandler((wc, permission) => permission === 'media');
    } catch (e) { logger.core.warn('permission handler unavailable: ' + e.message); }

    const set = settingsMod.get();
    const useRemembered = set.rememberWindowSize;
    let width, height;
    if (useRemembered && set.windowWidth && set.windowWidth >= 1200) {
      width = Math.max(900, set.windowWidth);
      height = Math.max(650, set.windowHeight || 800);
    } else {
      // new default size; one-time bump for sizes remembered under the old 1000x800 default
      width = 1200; height = 800;
      if (useRemembered && set.windowWidth && set.windowWidth < 1200) {
        settingsMod.set({ windowWidth: 1200, windowHeight: 800 });
      }
    }

    mainWindow = new BrowserWindow({
      width, height,
      minWidth: 900, minHeight: 620,
      useContentSize: true,
      backgroundColor: '#050507',
      show: false,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      icon: path.join(__dirname, '../../build/icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    let shown = false;
    const showOnce = () => {
      if (shown || !mainWindow || mainWindow.isDestroyed()) return;
      shown = true;
      mainWindow.show();
    };
    // safety net: never leave a hidden ("black") window if ready-to-show never fires
    setTimeout(showOnce, 15000);
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      logger.window.error(`Renderer load failed (${code} ${desc}): ${url}`);
    });
    mainWindow.once('ready-to-show', () => {
      showOnce();
      logger.window.info('Neurax Launcher ready.');
      // background: refresh version manifest so new versions appear automatically
      require('./core/versions').detectNewVersions()
        .then(({ added }) => {
          if (added && added.length && mainWindow) {
            mainWindow.webContents.send('versions:auto-added', { added });
          }
        })
        .catch((e) => logger.versions.warn('Manifest refresh failed: ' + e.message));
      // background: restore session
      auth.restoreSession()
        .then((acc) => { if (acc && mainWindow) mainWindow.webContents.send('auth:restored', acc); })
        .catch(() => {});
    });

    // F11 toggles fullscreen; Ctrl+Shift+I dev tools in --dev only
    mainWindow.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
        e.preventDefault();
      }
    });
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'I' && input.control && input.shift) {
          mainWindow.webContents.toggleDevTools();
          e.preventDefault();
        }
      });
    }

    // remember window size (debounced resize for all platforms)
    let boundsTimer = null;
    const saveBounds = () => {
      if (!mainWindow) return;
      const b = mainWindow.getNormalBounds();
      settingsMod.set({ windowWidth: b.width, windowHeight: b.height });
    };
    mainWindow.on('resize', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 600); });
    mainWindow.on('maximize', () => logger.window.debug('maximized'));
    mainWindow.on('enter-full-screen', () => logger.window.debug('fullscreen on'));
    mainWindow.on('leave-full-screen', () => logger.window.debug('fullscreen off'));

    mainWindow.on('closed', () => { mainWindow = null; });

    /* ---- maximized-windows-shrink fix (two layers) ----
       Layer 1 (root cause): the game now launches at the NATIVE desktop
       resolution when fullscreen (see game.js), so Windows never performs a
       display-mode/DPI change at launch — the thing that shrank every other
       maximized window.
       Layer 2 (repair): whenever Windows DOES change display metrics (dock
       plug/unplug, driver reset, game resolution change), re-assert every
       Neurax window's maximized state and keep it inside the work area. */
    try {
      const { screen } = require('electron');
      let metricsTimer = null;
      const repairWindows = () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          try {
            if (win.isMaximized()) { win.unmaximize(); win.maximize(); }
            else {
              const wa = screen.getPrimaryDisplay().workArea;
              const b = win.getBounds();
              if (b.width > wa.width || b.height > wa.height || b.x > wa.width || b.y > wa.height) {
                win.setSize(Math.min(b.width, wa.width), Math.min(b.height, wa.height));
                win.center();
              }
            }
          } catch {}
        }
        logger.window.info('display metrics changed — window geometry re-asserted');
      };
      screen.on('display-metrics-changed', () => { clearTimeout(metricsTimer); metricsTimer = setTimeout(repairWindows, 350); });
      screen.on('display-removed', () => { clearTimeout(metricsTimer); metricsTimer = setTimeout(repairWindows, 350); });
    } catch (e) { logger.window.warn('screen watch unavailable: ' + e.message); }

    // external links open in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    game.setBroadcaster((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      if (logsWindow && !logsWindow.isDestroyed()) logsWindow.webContents.send(channel, payload);
    });
    crashDoctor.setBroadcaster((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      if (logsWindow && !logsWindow.isDestroyed()) logsWindow.webContents.send(channel, payload);
    });
    // warm the GPU cache in the background so the launch-time memory clamp is
    // instant on the very first PLAY (24 h disk cache after this)
    crashDoctor.detectGpus().catch(() => {});
    servers.setBroadcaster((channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      if (logsWindow && !logsWindow.isDestroyed()) logsWindow.webContents.send(channel, payload);
    });

    logger.addListener((entry) => {
      if (logsWindow && !logsWindow.isDestroyed()) logsWindow.webContents.send('logs:entry', entry);
    });

    try {
      require('./ipc').register();
    } catch (err) {
      // e.g. a half-applied patch left a stale module behind — surface it, never silent
      logger.core.error('IPC registration failed: ' + (err.stack || err.message));
      const { dialog } = require('electron');
      dialog.showErrorBox('Neurax — engine failed to start', String(err.stack || err.message));
    }

    /* ---- NX subsystem: hidden device identity + cloud link ---- */
    (async () => {
      try {
        const id = await identity.ensureIdentity(); // first launch generates + protects the UUID file
        logger.nx.info(`NX identity ready: ${id.uuid}${id.file ? ' (protected file: ' + id.file + ')' : ''}`);
      } catch (e) { logger.nx.warn('identity ensure failed: ' + e.message); }
      // v1.0: resource-pack injection was REMOVED — clean any pack old builds injected
      try { nxInject.purgeAll(); } catch (e) { logger.nx.warn('resource-pack cleanup failed: ' + e.message); }
      // v1.0: the Neurax Client instance injection is LIVE again — every
      // in-scope instance gets the optimization stack (mods folder) once.
      try { require('./core/client').migrateInstances().catch((e) => logger.nx.warn('client migration: ' + e.message)); } catch (e) { logger.nx.warn('client migration: ' + e.message); }
      const bcast = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
        if (logsWindow && !logsWindow.isDestroyed()) logsWindow.webContents.send(channel, payload);
      };
      await nxCloud.init(bcast); // silent no-op when nxEnabled=false or cloud unreachable
      // v1.0: auto-restore the owner device grant (saved the first time the
      // owner key was entered) — this device stays granted without re-typing.
      try {
        const g = require('./core/nx-owner-grant').autoRestore();
        if (g.granted) logger.nx.info('Owner access restored automatically from the saved device grant.');
        else if (g.invalidated) logger.nx.info('Saved owner grant no longer matches the owner key — the key must be entered once again.');
      } catch (e) { logger.nx.warn('owner grant restore: ' + e.message); }
    })();
  });

  app.on('window-all-closed', () => { try { nxCloud.shutdown(); } catch {} app.quit(); });
}

/** Open (or focus) the logs popup window. */
function openLogsWindow() {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.focus();
    return;
  }
  logsWindow = new BrowserWindow({
    width: 860, height: 600,
    minWidth: 480, minHeight: 320,
    title: 'Neurax — Logs',
    backgroundColor: '#0a0c10',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  logsWindow.loadFile(path.join(__dirname, '../renderer/logs.html'));
  logsWindow.on('closed', () => { logsWindow = null; });
}

module.exports = { openLogsWindow, getMainWindow: () => mainWindow };
