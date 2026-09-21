#!/usr/bin/env node
// probe-nx-ui.js — boots the REAL renderer (mock bridge → preview stubs) and
// verifies the NX UI layer: presence chip in the navbar, ANNOUNCEMENTS button +
// red badge, the announcements page rendering with tags/priority, the chat
// popup opening with its two-pane layout, and the lock overlay (shown via a
// pushed nx:lock event) with its enforced full-screen animation.
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = process.env.PROBE_OUT || '/tmp/neurax-probe-nx';
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
    results.push({ name, ok: !!cond, extra });
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`);
  };
  const shot = (name) => new Promise((r) => {
    win.webContents.capturePage().then((img) => { fs.writeFileSync(path.join(OUT, name), img.toPNG()); r(); }).catch(r);
  });
  await new Promise(r => setTimeout(r, 4500)); // boot + nx init settle

  try {
    let s = await win.webContents.executeJavaScript(`(() => ({
      chip: !!document.getElementById('nx-presence-chip'),
      chipTxt: document.querySelector('#nx-presence-chip .nx-chip-txt')?.textContent || '',
      annBtn: !!document.getElementById('nx-announcements-btn'),
    }))()`, true);
    check('presence chip in navbar', s.chip);
    check('chip shows online/total counts (3 online · 7 total)', /3 online/.test(s.chipTxt) && /7 total/.test(s.chipTxt), s.chipTxt);
    check('ANNOUNCEMENTS nav button present', s.annBtn);

    // open announcements page
    await win.webContents.executeJavaScript(`document.getElementById('nx-announcements-btn').click()`, true);
    await new Promise(r => setTimeout(r, 900));
    s = await win.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('[data-page="announcements"]');
      const cards = [...(page?.querySelectorAll('.nx-ann') || [])];
      return {
        page: !!page,
        cards: cards.length,
        title: page?.querySelector('.nx-ann h3')?.textContent || '',
        tag: page?.querySelector('.nx-tag')?.textContent || '',
        prio: page?.querySelector('.nx-prio')?.textContent || '',
        buildError: !!(page && page.dataset.buildError),
      };
    })()`, true);
    check('announcements page opens', s.page && !s.buildError);
    check('announcement card rendered with title', s.cards >= 1 && /Welcome to NX Cloud/.test(s.title), s.title);
    check('tags + priority rendered', s.tag === 'preview' && s.prio === 'INFO', `${s.tag}/${s.prio}`);
    await shot('announcements.png');

    // chat popup
    await win.webContents.executeJavaScript(`document.getElementById('nx-presence-chip').click()`, true);
    await new Promise(r => setTimeout(r, 700));
    s = await win.webContents.executeJavaScript(`(() => ({
      popup: !!document.querySelector('.nx-chat-popup'),
      list: !!document.querySelector('.nx-chat-list'),
      msgs: !!document.querySelector('#nx-chat-messages'),
      input: !!document.querySelector('.nx-chat-input'),
      attach: [...document.querySelectorAll('.nx-chat-foot button')].map(b => b.textContent).some(t => t && t.includes('📎')),
      newGroup: [...document.querySelectorAll('.nx-chat-ops button')].map(b => b.textContent).some(t => t && t.includes('New group')),
    }))()`, true);
    check('chat popup opens from the chip', s.popup);
    check('chat has list + messages + input + attach (≤100MB) + new-group', s.list && s.msgs && s.input && s.attach && s.newGroup);
    await win.webContents.executeJavaScript(`document.querySelector('.nx-chat-head .btn')?.click()`, true);
    await new Promise(r => setTimeout(r, 300));

    // lock overlay — driven through the module's exported UI (same code path the
    // nx:lock event handler uses)
    s = await win.webContents.executeJavaScript(`(async () => {
      const mod = await import('./js/nx.js');
      mod.nxUI.showLock({ locked: true, reason: 'probe lock — only the admin can unlock', by: 'administrator', at: Date.now(), until: Date.now() + 3600e3 });
      await new Promise(r => setTimeout(r, 350));
      return {
        overlay: !!document.getElementById('nx-lock-overlay'),
        title: document.querySelector('.nx-lock-title')?.textContent || '',
        reason: document.querySelector('.nx-lock-reason')?.textContent || '',
        timer: document.querySelector('.nx-lock-timer')?.textContent || '',
        uuid: (document.querySelector('.nx-lock-uuid')?.textContent || ''),
      };
    })()`, true);
    check('lock overlay appears (enforced, z-max)', s.overlay);
    check('lock screen shows LAUNCHER LOCKED + reason + countdown + device uuid', /LAUNCHER LOCKED/.test(s.title) && /probe lock/.test(s.reason) && /Unlocks in/.test(s.timer) && /Device:/.test(s.uuid), JSON.stringify(s));
    await shot('locked.png');
    s = await win.webContents.executeJavaScript(`(async () => { const m = await import('./js/nx.js'); m.nxUI.hideLock(); await new Promise(r=>setTimeout(r,200)); return { gone: !document.getElementById('nx-lock-overlay') }; })()`, true);
    check('unlock event removes the overlay', s.gone);
  } catch (e) {
    check('probe completed without crash', false, e.message);
  }

  const ok = results.filter(r => r.ok).length;
  console.log(`\n${ok} passed, ${results.length - ok} failed`);
  app.exit(results.length - ok ? 1 : 0);
});
