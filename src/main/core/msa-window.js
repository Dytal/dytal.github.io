// msa-window.js — embedded Microsoft sign-in window (easiest login: no codes).
// Opens login.live.com with the official Minecraft MSA app id in a child window.
// The user signs in normally (email/password/2FA). When Microsoft redirects to the
// classic oauth20_desktop.srf page we intercept the URL, grab the ?code=..., close
// the window and finish the Minecraft authentication chain in auth.js.
'use strict';
const { BrowserWindow } = require('electron');
const auth = require('./auth');
const logger = require('./logger');

const REDIRECT_PREFIX = 'https://login.live.com/oauth20_desktop.srf';

let activeWin = null;

/** Close an in-progress popup login (user pressed Cancel in the launcher). */
function cancelActive() {
  try { if (activeWin && !activeWin.isDestroyed()) activeWin.close(); } catch {}
}

/**
 * Open the popup login window and run the whole login.
 * @param {{clientId?: string, broadcast?: (stage:string, message:string)=>void}} opts
 * @returns {Promise<object>} the Minecraft account
 */
function openMicrosoftLogin(opts = {}) {
  const { clientId, broadcast } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let win = null;

    const finish = async (url) => {
      if (settled) return;
      settled = true;
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const errDesc = u.searchParams.get('error_description');
      try { if (win && !win.isDestroyed()) win.close(); } catch {}
      if (err || !code) {
        reject(new Error(errDesc || err || 'Microsoft sign-in did not return an authorization code.'));
        return;
      }
      try {
        broadcast?.('code', 'Sign-in approved — connecting to Minecraft services…');
        const account = await auth.loginWithMsaCode(code, (clientId || '').trim() || auth.LIVE_CLIENT_ID);
        broadcast?.('done', account.name);
        resolve(account);
      } catch (e) {
        logger.auth.error('MSA popup login failed after code: ' + e.message);
        reject(e);
      }
    };

    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    try {
      const { getMainWindow } = require('../main'); // lazy: avoids module cycle
      const parent = typeof getMainWindow === 'function' ? getMainWindow() : null;

      win = new BrowserWindow({
        width: 480,
        height: 730,
        minWidth: 380,
        minHeight: 520,
        parent: parent && !parent.isDestroyed() ? parent : null,
        title: 'Sign in to your Microsoft account',
        backgroundColor: '#0b0e13',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false,
        },
      });
      activeWin = win;
      win.once('ready-to-show', () => win.show());

      // no nav away from the login flow — deny popups opened by the page
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      const checkUrl = (url, preventDefault) => {
        if (typeof url === 'string' && url.startsWith(REDIRECT_PREFIX)) {
          try { preventDefault?.(); } catch {}
          finish(url);
          return true;
        }
        return false;
      };
      win.webContents.on('will-redirect', (e, url) => { checkUrl(url, () => e.preventDefault()); });
      win.webContents.on('will-navigate', (e, url) => { checkUrl(url, () => e.preventDefault()); });
      win.webContents.on('did-navigate', (_e, url) => { checkUrl(url); });
      win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        // -3 ERR_ABORTED is triggered by our own preventDefault / window close — ignore
        if (code === -3 || settled) return;
        fail(`Could not load the Microsoft login page (${code} ${desc}). Check your internet connection. URL: ${url}`);
      });
      win.on('closed', () => {
        if (activeWin === win) activeWin = null;
        fail('Login cancelled — the Microsoft window was closed before sign-in completed.');
      });

      const url = auth.msaAuthorizeUrl((clientId || '').trim() || auth.LIVE_CLIENT_ID);
      broadcast?.('browser', 'Microsoft sign-in window opened — sign in there.');
      win.loadURL(url);
      logger.auth.info('MSA popup login window opened');
    } catch (e) {
      fail('Could not open the Microsoft sign-in window: ' + e.message);
    }
  });
}

module.exports = { openMicrosoftLogin, cancelActive };
