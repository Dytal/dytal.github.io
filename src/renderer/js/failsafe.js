// failsafe.js — anti-black-screen watchdog (plain script, runs BEFORE any module).
// If ANY module fails to load (bad import, missing export, syntax error) or the
// renderer throws before the UI boots, paint a visible error screen so the user
// never sees a silent black window again.
(function () {
  'use strict';
  var booted = false;
  var shown = false;

  window.__neuraxMarkBooted = function () { booted = true; };

  // explicit report path used by main.js start() catch — works even after boot
  window.reportStartupError = function (err) {
    var msg = (err && err.stack) ? err.stack : String(err);
    overlay('Neurax — startup error', msg);
  };

  function overlay(title, detail) {
    if (shown) {
      var pre = document.getElementById('neurax-failsafe-detail');
      if (pre && detail) pre.textContent += '\n\n---\n\n' + detail;
      return;
    }
    shown = true;
    try {
      var host = document.getElementById('app') || document.body;
      var box = document.createElement('div');
      box.id = 'neurax-failsafe';
      box.style.cssText =
        'position:fixed;inset:0;z-index:999999;background:#0b0e13;color:#e5e9f0;' +
        'font:14px/1.55 "Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:28px;';
      var inner = document.createElement('div');
      inner.style.cssText =
        'max-width:760px;width:100%;background:#141a23;border:1px solid #2a3445;border-radius:14px;padding:26px 28px;' +
        'box-shadow:0 18px 60px rgba(0,0,0,.5);';
      var h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'font-size:17px;font-weight:700;color:#ff6b6b;margin-bottom:10px;';
      var p = document.createElement('div');
      p.textContent = 'The interface failed to start. Please send the details below to support / paste them in the chat.';
      p.style.cssText = 'color:#9aa7b8;margin-bottom:14px;';
      var pre = document.createElement('pre');
      pre.id = 'neurax-failsafe-detail';
      pre.textContent = detail || '(no details)';
      pre.style.cssText =
        'white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid #223;color:#cde3f8;' +
        'border-radius:10px;padding:14px 16px;max-height:46vh;overflow:auto;font:12px/1.5 Consolas,monospace;user-select:text;cursor:text;';
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:10px;margin-top:16px;justify-content:flex-end;';
      var btn = document.createElement('button');
      btn.textContent = 'Copy details';
      btn.style.cssText =
        'background:#2f6df6;border:none;color:#fff;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;';
      btn.onclick = function () {
        try { navigator.clipboard.writeText(pre.textContent); btn.textContent = 'Copied!'; }
        catch (e) { btn.textContent = 'Select & copy manually'; }
      };
      var reload = document.createElement('button');
      reload.textContent = 'Reload launcher';
      reload.style.cssText =
        'background:transparent;border:1px solid #3a4658;color:#cfe0f5;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;';
      reload.onclick = function () { location.reload(); };
      row.appendChild(reload); row.appendChild(btn);
      inner.appendChild(h); inner.appendChild(p); inner.appendChild(pre); inner.appendChild(row);
      box.appendChild(inner);
      host.appendChild(box);
    } catch (e) { /* last resort */ }
  }

  window.addEventListener('error', function (ev) {
    if (booted) return; // runtime errors after boot are handled by toasts/app logic
    var msg = (ev && ev.message) ? ev.message : String(ev);
    var src = (ev && ev.filename) ? (ev.filename + ' @ line ' + (ev.lineno || '?')) : '(unknown file)';
    overlay('Neurax — startup error', msg + '\n' + src + (ev && ev.error && ev.error.stack ? '\n\n' + ev.error.stack : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    if (booted) return;
    var r = ev && ev.reason;
    overlay('Neurax — startup error', (r && r.stack) ? r.stack : String(r));
  });

  // If nothing threw but the UI also never booted (hung import etc.), surface it.
  // Two anti-false-positive guards (fixed the random "did not finish loading" bug):
  //   1. If the navbar exists, the app IS alive — slow data loading is NOT a boot
  //      failure, so the watchdog must stay silent.
  //   2. Grace period raised 15s → 30s for slow disks / antivirus first-scans.
  setTimeout(function () {
    if (booted || shown) return;
    if (document.getElementById('navbar') || (document.getElementById('page-host') || {}).childNodes?.length) return;
    overlay('Neurax — still starting…',
      'The interface did not finish loading within 30 seconds.\n' +
      'This usually means a file from the latest patch is missing or was not extracted.\n' +
      'Try: re-extract the patch over the neurax-launcher folder, then reload.');
  }, 30000);
})();
