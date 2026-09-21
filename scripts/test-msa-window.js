// test-msa-window.js — live test of the embedded Microsoft login window:
//  1. opens the real sign-in page (proves client id + redirect are accepted)
//  2. simulates the oauth code redirect to prove the interception + token exchange wiring
'use strict';
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const auth = require('../src/main/core/auth');
  const { openMicrosoftLogin } = require('../src/main/core/msa-window');

  console.log('AUTH_URL ' + auth.msaAuthorizeUrl(''));

  const p = openMicrosoftLogin({
    clientId: '',
    broadcast: (stage, message) => console.log(`STAGE ${stage}: ${message}`),
  });

  // wait for the login window: pick the window whose webContents is on login.live.com
  await new Promise(r => setTimeout(r, 3000));
  let loginWin = null;
  for (const w of BrowserWindow.getAllWindows()) {
    const u = w.webContents.getURL();
    if (u.includes('login.live.com')) { loginWin = w; break; }
  }
  if (!loginWin) { console.log('RESULT FAIL: login window not found'); app.quit(); return; }
  console.log('LOGIN_WINDOW_TITLE ' + JSON.stringify(loginWin.getTitle()));

  // wait for the Microsoft page to finish loading
  await new Promise(r => setTimeout(r, 7000));
  const html = await loginWin.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 400) : "(no body)"');
  console.log('PAGE_TEXT ' + JSON.stringify(html.slice(0, 200)));

  // now simulate Microsoft redirecting back with a (fake) code — the module must
  // intercept it and attempt the token exchange, which will fail with a MS error
  await loginWin.webContents.loadURL(
    'https://login.live.com/oauth20_desktop.srf?code=FAKE-CODE-FOR-WIRING-TEST&lc=1033').catch(() => {});

  const result = await Promise.race([
    p.then(a => ({ ok: true, account: a }), e => ({ ok: false, error: e.message })),
    new Promise(r => setTimeout(() => r({ ok: 'timeout' }), 30000)),
  ]);
  console.log('RESULT ' + JSON.stringify(result, null, 2));
  app.quit();
});
