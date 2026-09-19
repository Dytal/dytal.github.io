#!/usr/bin/env node
// probe-nx-supabase-ui.js — boots the REAL renderer (mock bridge) and verifies
// the v3.1 NX UI: admin bar → passphrase unlock → announcement editor, the
// devices & locks panel, the INVITE modal, the chat popup with player-head
// rows, and the Settings page Supabase card + head avatar (no full-skin PNG).
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe-nx-supabase-ui';
fs.mkdirSync(OUT, { recursive: true });

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond });
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
  };
  const shot = (name) => new Promise((r) => {
    win.webContents.capturePage().then((img) => { fs.writeFileSync(path.join(OUT, name), img.toPNG()); r(); }).catch(r);
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await new Promise((r) => setTimeout(r, 4500));

  try {
    /* ---------- 1. boot + chip ---------- */
  console.log("STEP 1");
    let s = await js(`(() => ({
      chip: !!document.getElementById('nx-presence-chip'),
      txt: document.querySelector('#nx-presence-chip .nx-chip-txt')?.textContent || '',
      err: window.__bootError || null,
    }))()`);
    check('renderer boots with presence chip', s.chip && !s.err, s.err || 'no chip');
    check('chip shows online/total', /3 online/.test(s.txt) && /7 total/.test(s.txt), s.txt);

    /* ---------- 2. announcements page + admin unlock ---------- */
  console.log("STEP 2");
    await js(`document.getElementById('nx-announcements-btn').click()`);
    await new Promise((r) => setTimeout(r, 900));
  console.log("STEP 3");
    s = await js(`(() => {
      const page = document.querySelector('[data-page="announcements"]');
      return {
        page: !!page,
        adminBar: !!page?.querySelector('.nx-admin-bar'),
        adminBtn: [...(page?.querySelectorAll('.nx-admin-bar button') || [])].map((b) => b.textContent),
        cards: page?.querySelectorAll('.nx-ann').length || 0,
      };
    })()`);
    check('announcements page with admin bar', s.page && s.adminBar);
    check('NX Admin unlock button present', s.adminBtn.some((t) => /NX Admin/.test(t)), JSON.stringify(s.adminBtn));
    check('announcement card renders (preview data)', s.cards >= 1);

    // unlock admin (mock accepts any pass)
  console.log("STEP 4");
    await js(`(() => { const b = [...document.querySelectorAll('.nx-admin-bar button')].find((x) => /NX Admin/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
  console.log("STEP 5");
    s = await js(`(() => ({ modal: !!document.querySelector('.modal'), passInput: !!document.querySelector('.modal input[type="password"]') }))()`);
    check('admin passphrase modal opens', s.modal && s.passInput);
  console.log("STEP 6");
    await js(`(() => { const i = document.querySelector('.modal input[type="password"]'); i.value = 'anish-test'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  console.log("STEP 7");
    await js(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => /Unlock/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 500));
  console.log("STEP 8");
    s = await js(`(() => {
      const bar = document.querySelector('.nx-admin-bar');
      return { open: bar?.classList.contains('open'), btns: [...(bar?.querySelectorAll('button') || [])].map((b) => b.textContent) };
    })()`);
    check('admin unlocked (NX ADMIN bar open)', s.open, JSON.stringify(s.btns));
    check('New announcement + Devices & locks buttons appear', s.btns.some((t) => /New announcement/.test(t)) && s.btns.some((t) => /Devices & locks/.test(t)), JSON.stringify(s.btns));

    /* ---------- 3. announcement editor form ---------- */
  console.log("STEP 9");
    await js(`(() => { const b = [...document.querySelectorAll('.nx-admin-bar button')].find((x) => /New announcement/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
  console.log("STEP 10");
    s = await js(`(() => {
      const m = document.querySelector('.modal');
      return {
        open: !!m,
        title: m?.querySelector('h2')?.textContent || '',
        inputs: m?.querySelectorAll('input.input, textarea.input, select.input').length || 0,
        colorInputs: m?.querySelectorAll('input[type="color"]').length || 0,
        publishBtn: [...(m?.querySelectorAll('button') || [])].some((b) => /Publish/.test(b.textContent)),
      };
    })()`);
    check('announcement editor modal (title/tags/priority/style)', s.open && s.inputs >= 3 && s.colorInputs >= 2, `inputs=${s.inputs} colors=${s.colorInputs}`);
    check('Publish button fires the badge semantics', s.publishBtn);
  console.log("STEP 11");
    await js(`(() => { const i = document.querySelector('.modal input.input'); i.value = 'Probe Announcement'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  console.log("STEP 12");
    await js(`(() => { const b = [...document.querySelectorAll('.modal button')].find((x) => /Publish/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 500));
  console.log("STEP 13");
    s = await js(`(() => ({ modalGone: !document.querySelector('.modal') }))()`);
    check('publish submits and closes (mock ok)', s.modalGone);

    /* ---------- 4. devices & locks panel ---------- */
  console.log("STEP 14");
    await js(`(() => { const b = [...document.querySelectorAll('.nx-admin-bar button')].find((x) => /Devices & locks/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 500));
  console.log("STEP 15");
    s = await js(`(() => ({ devModal: [...document.querySelectorAll('.modal h2')].some((h) => /Devices & locks/.test(h.textContent)) }))()`);
    check('devices & locks panel opens', s.devModal);
  console.log("STEP 16");
    await js(`[...document.querySelectorAll('.modal-backdrop')].forEach((m) => m.remove()); true`); // close devices panel
    await new Promise((r) => setTimeout(r, 200));

    /* ---------- 5. chat popup + invite modal ---------- */
  console.log("STEP 17");
    await js(`document.getElementById('nx-presence-chip').click()`);
    await new Promise((r) => setTimeout(r, 600));
  console.log("STEP 18");
    s = await js(`(() => ({
      popup: !!document.querySelector('.nx-chat-popup'),
      invite: [...document.querySelectorAll('.nx-chat-ops button')].map((b) => b.textContent),
      opsCount: document.querySelectorAll('.nx-chat-ops button').length,
    }))()`);
    check('chat popup opens with ops', s.popup && s.opsCount >= 3, JSON.stringify(s.invite));
    // select the demo chat so INVITE has an active group
  console.log("STEP 19");
    await js(`(() => { document.querySelector('.nx-chat-row')?.click(); })()`);
    await new Promise((r) => setTimeout(r, 700));
  console.log("STEP 20");
    s = await js(`(() => ({ msgs: document.querySelectorAll('.nx-msg').length, heads: document.querySelectorAll('.nx-msg-ava').length, names: [...(document.querySelectorAll('.nx-msg-name') || [])].map((n) => n.textContent) }))()`);
    check('demo chat renders message rows with heads + names', s.msgs >= 2 && s.heads >= 2, JSON.stringify(s));
  console.log("STEP 21");
    await js(`(() => { const b = [...document.querySelectorAll('.nx-chat-ops button')].find((x) => /Invite/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
  console.log("STEP 22");
    s = await js(`(() => {
      const m = document.querySelector('.modal');
      return {
        title: m?.querySelector('h2')?.textContent || '',
        input: m?.querySelector('input.input') ? true : false,
        hint: m?.querySelector('.modal-sub')?.textContent || '',
        inviteBtn: [...(m?.querySelectorAll('button') || [])].some((b) => /Invite/.test(b.textContent)),
      };
    })()`);
    check('INVITE modal with UUID/name input', s.title && s.input && s.inviteBtn, s.title);
    check('invite hint explains Microsoft-only rule', /Microsoft/i.test(s.hint), s.hint);
  console.log("STEP 23");
    await js(`(() => {
      const b = [...document.querySelectorAll('.modal button')].find((x) => /Invite/.test(x.textContent));
      b && b.click();
    })()`);
    await new Promise((r) => setTimeout(r, 500));
  console.log("STEP 24");
    s = await js(`(() => ({ err: document.querySelector('.modal .hint')?.textContent || '' }))()`);
    check('empty invite shows validation error', /Enter a UUID/.test(s.err), s.err);
  console.log("STEP 25");
    await js(`[...document.querySelectorAll('.modal-backdrop')].forEach((m) => m.remove()); true`);
  console.log("STEP 26");
    await js(`(() => { const b = [...document.querySelectorAll('.nx-chat-head button')].find((x) => /Close/.test(x.textContent)); b && b.click(); })()`);
    await new Promise((r) => setTimeout(r, 250));

    /* ---------- 6. settings page: supabase card + head avatar ---------- */
  console.log("STEP 27");
    await js(`(() => { document.querySelector('[data-nav="settings"]')?.click(); })()`);
    await new Promise((r) => setTimeout(r, 900));
  console.log("STEP 28");
    s = await js(`(() => {
      const page = document.querySelector('[data-page="settings"]');
      const labels = [...(page?.querySelectorAll('.label') || [])].map((l) => l.textContent);
      const supaInput = [...(page?.querySelectorAll('input') || [])].find((i) => /supabase\.co/i.test(i.value || ''));
      const fullSkinImg = [...(page?.querySelectorAll('.account-chip img') || [])].some((i) => /assets[/]skins|minecraft[.]net|crafatar/.test(i.src || ''));
      return {
        page: !!page,
        supaLabel: labels.some((l) => /NX Cloud/.test(l)),
        adminLabel: [...(page?.querySelectorAll('b') || [])].some((b) => /Admin panel/.test(b.textContent)),
        oldPassRow: [...(page?.querySelectorAll('b') || [])].some((b) => /Administrator passphrase/.test(b.textContent)),
        supaInput: !!supaInput,
        fullSkinImg,
        accountChip: !!page?.querySelector('.account-chip'),
      };
    })()`);
    check('settings page shows NX Cloud card', s.page && s.supaLabel);
    check('cloud connection inputs are HIDDEN (background mode)', !s.supaInput, 'Supabase URL input should not exist in Settings anymore');
    check('admin panel row present (fixed passkey model)', s.adminLabel);
    check('old user-settable passphrase row is REMOVED', !s.oldPassRow);
    check('account avatar is NOT the full skin PNG', !s.fullSkinImg);
    check('account chip renders (head or fallback)', s.accountChip);
  console.log("STEP 29");
    await shot('settings.png');

    /* ---------- 7. announcements page head fallback ---------- */
  console.log("STEP 30");
    await js(`document.getElementById('nx-announcements-btn').click()`);
    await new Promise((r) => setTimeout(r, 500));
  console.log("STEP 31");
    s = await js(`(() => ({ adminBar: !!document.querySelector('.nx-admin-bar.open') }))()`);
    check('admin session persists across navigation', s.adminBar);
  console.log("STEP 32");
    await shot('announcements-admin.png');
  } catch (e) {
    check('probe completed without crash', false, e.message.slice(0, 200));
    try { console.log('CRASH AT:', e.message.slice(0, 300)); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n================ UI RESULT: ${passed}/${results.length} PASS ================`);
  app.exit(passed === results.length ? 0 : 1);
});
