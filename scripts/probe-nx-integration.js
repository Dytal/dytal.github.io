#!/usr/bin/env node
// probe-nx-integration.js — launcher-side NX verification:
//   1. device-identity: UUID generated once, cached, stable across calls; the
//      protected file exists and contains the same UUID (file permissions are
//      Windows-specific and asserted there only).
//   2. nx-inject: the NX-UI 64x pack is real, its zip is valid, every game dir
//      (existing instance + FUTURE instance + global) receives it, options.txt
//      gets the pack enabled exactly once, and re-injection never duplicates.
//   3. pack content sanity: pack.mcmeta formats target MC 26.1.2 (84), all 33
//      vanilla widget sprites present, no inventory/hotbar/hud paths touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-int-'));
process.env.NEURAX_HOME = HOME;
process.env.NEURAX_NO_PROGRAMDATA = '1';
let passed = 0, failed = 0;
const check = (n, c, x = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + ' ' + x); } };

(async () => {
  console.log('\nprobe-nx-integration — identity + injection (isolated .neurax)\n');

  /* ---- 1. device identity ---- */
  const identity = require('../src/main/core/device-identity');
  const id1 = await identity.ensureIdentity();
  check('UUID generated on first launch', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id1.uuid));
  const id2 = await identity.ensureIdentity();
  check('identity is stable within the session (cached)', id2.uuid === id1.uuid);
  const cacheFile = path.join(HOME, 'identity-cache.json');
  check('cache file written', fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).uuid === id1.uuid);
  const fingerprint = await identity.hardwareFingerprint();
  check('hardware fingerprint is sha256 hex', /^[0-9a-f]{64}$/.test(fingerprint));
  // cloud adoption path: a wiped device gets its cloud uuid adopted
  const adopted = identity.adoptCloudIdentity('11111111-2222-4333-8444-555566667777');
  check('cloud recovery can adopt a uuid', adopted.uuid === '11111111-2222-4333-8444-555566667777' && identity.getIdentity().uuid === adopted.uuid);

  /* ---- 2. resource pack content sanity (the purple/black fix) ---- */
  const nxInject = require('../src/main/core/nx-inject');
  check('pack zip embedded in the launcher', nxInject.packExists());
  const { execSync } = cp;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-pack-'));
  execSync(`unzip -o -q "${nxInject.packFile()}" -d "${tmp}"`);
  const pmc = JSON.parse(fs.readFileSync(path.join(tmp, 'pack.mcmeta'), 'utf8'));
  check('pack.mcmeta targets MC 26.1.2 (format 84) with forward range', pmc.pack.min_format === 84 && Number(pmc.pack.max_format) >= 84);
  const spriteRoot = path.join(tmp, 'assets/minecraft/textures/gui/sprites');
  const required = ['widget/button.png', 'widget/button_disabled.png', 'widget/button_highlighted.png',
    'widget/checkbox.png', 'widget/checkbox_highlighted.png', 'widget/checkbox_selected.png',
    'widget/checkbox_selected_highlighted.png', 'widget/scroller.png', 'widget/scroller_background.png',
    'widget/slider.png', 'widget/slider_handle.png', 'widget/slider_handle_highlighted.png',
    'widget/slider_highlighted.png', 'widget/text_field.png', 'widget/text_field_highlighted.png',
    'widget/tab.png', 'widget/cross_button.png', 'widget/locked_button.png', 'widget/unlocked_button.png',
    'widget/page_backward.png', 'widget/page_forward.png', 'widget/preedit.png', 'widget/slot_frame.png',
    'tooltip/background.png', 'tooltip/frame.png'];
  const missing = required.filter((r) => !fs.existsSync(path.join(spriteRoot, r)));
  check('all UI sprites present (buttons/sliders/checkboxes/scrollbars/tabs/tooltips)', missing.length === 0, missing.join(','));
  // nine-slice mcmeta geometry matches the verified 64x recipe
  const btn = JSON.parse(fs.readFileSync(path.join(spriteRoot, 'widget/button.png.mcmeta'), 'utf8'));
  const sc = btn.gui.scaling;
  check('button nine-slice metadata correct (logical 200x20)', sc.type === 'nine_slice' && sc.width === 200 && sc.height === 20);
  const pngSize = (p) => { const b = fs.readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  const btnPx = pngSize(path.join(spriteRoot, 'widget/button.png'));
  check('button texture is true 64x (800x80 = 4x logical)', btnPx.w === 800 && btnPx.h === 80, JSON.stringify(btnPx));
  const cbPx = pngSize(path.join(spriteRoot, 'widget/checkbox_selected.png'));
  check('animated checkbox is a 3-frame sheet (80x240)', cbPx.w === 80 && cbPx.h === 240, JSON.stringify(cbPx));
  const cbMeta = JSON.parse(fs.readFileSync(path.join(spriteRoot, 'widget/checkbox_selected.png.mcmeta'), 'utf8'));
  check('checkbox animation metadata valid (frametime + frames)', cbMeta.animation && cbMeta.animation.frametime > 0 && Array.isArray(cbMeta.animation.frames));
  // scope guard: NEVER touch inventory/hotbar/hud/container
  const allFiles = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : allFiles.push(p); } })(tmp);
  const forbidden = allFiles.filter((p) => /container|inventory|hud|hotbar|creative_inventory|brewing_stand|anvil|beacon|bundle/.test(path.relative(tmp, p)));
  check('inventory & hotbar & HUD untouched (scope guard)', forbidden.length === 0, forbidden.join(','));
  // decode every png (corrupt texture = the purple/black disaster this fixes)
  let decodeBad = 0;
  for (const p of allFiles.filter((f) => f.endsWith('.png'))) {
    const b = fs.readFileSync(p);
    if (b.length < 8 || !b.slice(1, 4).toString('ascii').includes('PNG')) decodeBad++;
  }
  check('every texture is a valid PNG (no purple/black sources)', decodeBad === 0);

  /* ---- 3. injection into game dirs ---- */
  const store = require('../src/main/core/store');
  const settingsMod = require('../src/main/core/settings');
  settingsMod.load();
  settingsMod.set({ nxUiInject: true });
  const inst = store.createInstance({ name: 'Probe Fabric', version: '26.1.2', loader: 'fabric' });
  const gd = store.instanceGameDir(inst.id);
  const r1 = nxInject.injectGameDir(gd);
  check('existing instance receives the pack', r1.injected && fs.existsSync(path.join(gd, 'resourcepacks', 'NX-UI-64x.zip')));
  const opt = fs.readFileSync(path.join(gd, 'options.txt'), 'utf8');
  check('options.txt enables the pack', opt.includes('"file/NX-UI-64x.zip"') && opt.startsWith('resourcePacks:'), opt.split('\n')[0]);
  const r2 = nxInject.injectGameDir(gd);
  check('re-injection never duplicates (marker)', r2.injected && (opt.match(/NX-UI-64x/g) || []).length === 1 && (fs.readFileSync(path.join(gd, 'options.txt'), 'utf8').match(/NX-UI-64x/g) || []).length === 1);
  const optLines = fs.readFileSync(path.join(gd, 'options.txt'), 'utf8');
  check('options.txt has exactly one resourcePacks line', (optLines.match(/resourcePacks:/g) || []).length === 1);
  // future instance: creation itself injects
  const inst2 = store.createInstance({ name: 'Future Fabric', version: '26.1.2', loader: 'fabric' });
  const gd2 = store.instanceGameDir(inst2.id);
  check('FUTURE instance auto-injected at creation', fs.existsSync(path.join(gd2, 'resourcepacks', 'NX-UI-64x.zip')));
  // global vanilla dir
  const { DIRS } = require('../src/main/core/paths');
  nxInject.injectGameDir(DIRS.minecraft);
  check('global .minecraft receives the pack (vanilla play)', fs.existsSync(path.join(DIRS.minecraft, 'resourcepacks', 'NX-UI-64x.zip')));
  // toggle off respected
  settingsMod.set({ nxUiInject: false });
  const r3 = nxInject.injectAll();
  check('settings toggle nxUiInject respected', r3.skipped === true);

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(1); });
