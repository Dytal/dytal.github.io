// msa-browser.js — v4.1 DEFAULT Microsoft login: the SYSTEM DEFAULT BROWSER.
//
// This is the method modern launchers use (Prism, ATLauncher, …) and it fixes
// the "sometimes I get an error" class of failures from the old embedded
// window: Microsoft actively degrades sign-in inside embedded webviews, while
// the user's own browser supports everything — saved sessions, 2FA, passkeys,
// security keys, captive-portal-free redirects.
//
// Flow (OAuth2 Authorization Code + PKCE, RFC 7636):
//   1. spin up a ONE-SHOT HTTP server on 127.0.0.1:<random free port>
//   2. open the v2 authorize endpoint in the default browser with an S256
//      code_challenge + a random state (CSRF guard)
//   3. the user signs in; Microsoft redirects to http://localhost:<port>/?code=…
//   4. the loopback page answers "you can close this tab" and the code is
//      exchanged WITH the PKCE verifier for tokens (auth.loginWithBrowserCode)
//   5. XBL → XSTS → Minecraft services chain runs as usual in auth.js
//
// No Electron imports at module scope (probe-able in plain Node); electron is
// required lazily ONLY to call shell.openExternal, with a graceful manual-URL
// fallback if opening the browser fails.
'use strict';
const http = require('http');
const crypto = require('crypto');
const auth = require('./auth');
const logger = require('./logger');

const TIMEOUT_MS = 3 * 60 * 1000; // user has 3 minutes to finish in the browser

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Neurax Launcher — signed in</title></head>
<body style="margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#0b0e13;color:#e8f2ee;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:40px">
<div style="font-size:52px;margin-bottom:12px">&#10004;</div>
<h1 style="font-size:22px;margin:0 0 8px">Signed in to Microsoft</h1>
<p style="color:#8fa8a0;margin:0">All good — you can close this tab and return to <b style="color:#34d399">Neurax Launcher</b>.</p>
</div></body></html>`;

const failPage = (msg) => `<!doctype html><html><head><meta charset="utf-8"><title>Neurax Launcher — sign-in problem</title></head>
<body style="margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#0b0e13;color:#e8f2ee;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:40px;max-width:520px">
<div style="font-size:52px;margin-bottom:12px">&#9888;</div>
<h1 style="font-size:20px;margin:0 0 8px">Sign-in did not complete</h1>
<p style="color:#8fa8a0;margin:0;word-break:break-word">${String(msg).replace(/[<>&]/g, '')}</p>
<p style="color:#8fa8a0;margin:12px 0 0">Close this tab and try again in Neurax Launcher.</p>
</div></body></html>`;

let active = null; // currently running browser login (single at a time)

function openExternal(url) {
  try {
    const { shell } = require('electron');
    if (shell && typeof shell.openExternal === 'function') return shell.openExternal(url);
  } catch {}
  return Promise.reject(new Error('shell unavailable'));
}

/** Abort an in-progress browser login (renderer Cancel button / new login). */
function cancelActive(reason) {
  const a = active;
  if (!a) return false;
  try { a.settle(() => a.reject(new Error(reason || 'Login cancelled.'))); } catch {}
  return true;
}

/**
 * Run the full browser login. Resolves with the Minecraft account.
 * @param {{clientId?: string, broadcast?: (stage:string, message:string)=>void}} opts
 */
function openMicrosoftBrowserLogin(opts = {}) {
  const { broadcast } = opts;
  return new Promise((resolve, reject) => {
    // v4.2 GUARD — the built-in Minecraft app id (00000000402b5328) has NO
    // localhost redirect registered; Microsoft rejects the flow with
    // "redirect_uri is not valid" (the v4.1.0 default bug). The system-browser
    // loopback flow therefore REQUIRES the owner's own Azure client id
    // (Settings.msClientId, set via NX Admin → Device & login IDs) with
    // http://localhost registered as a public-client redirect.
    const customCid = String(opts.clientId || '').trim();
    if (!customCid) {
      logger.auth.warn('MSA browser login refused: no custom Azure client id (the built-in Minecraft app id does not allow localhost redirects)');
      setImmediate(() => reject(new Error(
        'Browser sign-in needs your own Azure app id — the built-in Minecraft app id does not allow localhost redirects '
        + '(Microsoft: "redirect_uri is not valid"). Use the device-code sign-in (the default) or the sign-in window instead, '
        + 'or register a free Azure app with http://localhost as a public-client redirect and set it in NX Admin → Device & login IDs.'
      )));
      return;
    }
    const cid = customCid;

    if (active) cancelActive('A new sign-in was started.');

    let settled = false;
    let server = null;
    let timer = null;
    const { verifier, challenge } = auth.pkcePair();
    const state = crypto.randomBytes(16).toString('hex');

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (active && active.settle === settle) active = null;
      try { if (timer) clearTimeout(timer); } catch {}
      try { if (server) server.close(() => {}); } catch {}
      try { fn(); } catch {}
    };
    active = { settle, reject, close: cancelActive };

    const run = async () => {
      // 1. one-shot loopback server on a random free port
      server = http.createServer((req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://localhost');
          const code = u.searchParams.get('code');
          const errDesc = u.searchParams.get('error_description') || u.searchParams.get('error');
          const stateOk = u.searchParams.get('state') === state;
          const good = !!(code && stateOk);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(good ? SUCCESS_PAGE : failPage(errDesc || (stateOk ? 'No authorization code arrived.' : 'Security check failed (state mismatch).')));
          if (!good) {
            settle(() => reject(new Error(errDesc || 'Microsoft sign-in did not complete.')));
            return;
          }
          settle(async () => {
            try {
              broadcast?.('browser', 'Sign-in approved in your browser — connecting to Minecraft services…');
              const account = await auth.loginWithBrowserCode({
                code, verifier, clientId: cid, redirectUri,
              });
              broadcast?.('done', account.name);
              resolve(account);
            } catch (e) {
              logger.auth.error('MSA browser login failed after code: ' + e.message);
              reject(e);
            }
          });
        } catch (e) {
          settle(() => reject(e));
        }
      });
      server.on('error', (e) => settle(() => reject(new Error('Could not start the local sign-in listener: ' + e.message))));

      await new Promise((res, rej) => {
        server.once('listening', res);
        server.once('error', rej);
        server.listen(0, '127.0.0.1');
      });
      const port = server.address().port;
      const redirectUri = `http://localhost:${port}/`;

      // 2. authorize URL (PKCE S256 + state)
      const url = auth.browserAuthorizeUrl({ clientId: cid, redirectUri, challenge, state });

      // 3. open the user's OWN browser
      let opened = false;
      try { await openExternal(url); opened = true; } catch {}
      if (opened) {
        broadcast?.('browser', 'Your default browser just opened — finish the Microsoft sign-in THERE, then come back here.');
      } else {
        broadcast?.('browser', 'Could not open a browser automatically. Open this URL manually and sign in: ' + url);
      }
      logger.auth.info(`MSA browser login started (loopback :${port}, client ${cid === auth.LIVE_CLIENT_ID ? 'built-in' : 'custom'})`);

      // 4. hard timeout so nothing hangs forever
      timer = setTimeout(() => {
        settle(() => reject(new Error('Sign-in timed out — nothing arrived at the local listener within 3 minutes. Try again.')));
      }, TIMEOUT_MS);
    };

    run().catch((e) => settle(() => reject(e)));
  });
}

module.exports = { openMicrosoftBrowserLogin, cancelActive };
