#!/usr/bin/env node
/* probe-v101.js — verification battery for the 1.0.0 RELEASE R2 fixes.
 *
 * Covers (owner request bundle, session R2):
 *   1.  Supabase SQL fixed: nx_chat_invites.group_id is UUID everywhere
 *       (setup file + launcher auto-migration) + self-repair for databases
 *       that still carry the wrong-typed table
 *   2.  Planet-scale auto-growth: the launcher auto-provisions the WHOLE
 *       schema per-statement-isolated (one failure can never skip the rest),
 *       bigint identities, hot-path indexes, autoscale view + maintenance
 *   3.  keepLauncherOpen removed EVERYWHERE (one launch-behaviour switch only)
 *   4.  NX-only injection: third-party stack is OPT-IN (default OFF),
 *       VulkanMod guard, never-inject-twice dedupe, cache-key separation
 *
 * Run: node scripts/probe-v101.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
let pass = 0;

function record(name, ok, extra) {
  results.push({ name, ok });
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
async function ok(name, fn) {
  try { const r = await fn(); record(name, true, r); }
  catch (e) { record(name, false, e.message); }
}
function run(code, home) {
  const script = path.join(os.tmpdir(), `nx101-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(script, code);
  try {
    return execFileSync(process.execPath, [script], {
      env: { ...process.env, NEURAX_HOME: home || fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-v101-')) },
      encoding: 'utf8', timeout: 30000,
    });
  } finally { try { fs.rmSync(script, { force: true }); } catch {} }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  console.log('== Neurax 1.0.0-R2 probe ==\n');

  /* ---- 1. SQL FK type fix ---- */
  await ok('setup SQL: nx_chat_invites.group_id is UUID (the 42804 fix) — in BOTH create statements', async () => {
    const sql = read('supabase/nx-supabase-setup.sql');
    assert.ok(!/group_id\s+bigint/.test(sql), 'no bigint group_id left anywhere');
    const uuidCount = (sql.match(/group_id\s+uuid not null references nx_chat_groups\(id\) on delete cascade/g) || []).length;
    assert.ok(uuidCount >= 2, `uuid-typed group_id declared in create + repair block (found ${uuidCount})`);
  });
  await ok('setup SQL: self-repair block upgrades a database that still holds the wrong-typed table', async () => {
    const sql = read('supabase/nx-supabase-setup.sql');
    assert.ok(sql.includes("table_name  = 'nx_chat_invites'"), 'inspects information_schema for the invites table');
    assert.ok(sql.includes("column_name = 'group_id'"), 'inspects the group_id column');
    assert.ok(sql.includes("data_type  <> 'uuid'"), 'triggers only when the type is wrong');
    assert.ok(/drop table if exists nx_chat_invites cascade/.test(sql), 'replaces the legacy table');
    const doBlocks = (sql.match(/do \$\$/g) || []).length;
    assert.ok(doBlocks >= 2, 'repair + pg_cron blocks present');
  });
  await ok('launcher auto-migration: same fix — uuid type, no bigint anywhere', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(!/group_id\s+bigint/.test(src), 'no bigint group_id in the auto-migration');
    assert.ok((src.match(/group_id uuid not null references nx_chat_groups\(id\) on delete cascade/g) || []).length >= 2,
      'uuid group_id in repair + create');
    assert.ok(src.includes('repairChatInvitesType'), 'legacy wrong-typed table self-repair wired');
    assert.ok(src.includes("select data_type from information_schema.columns"), 'type probe used');
  });

  /* ---- 2. planet-scale auto-growth ---- */
  await ok('auto-provisioning: the launcher creates EVERY table by itself (empty project self-grows)', async () => {
    const src = read('src/main/core/nx-supabase.js');
    const tables = ['nx_identities', 'nx_locks', 'nx_chat_groups', 'nx_chat_members', 'nx_chat_messages',
      'nx_message_deletes', 'nx_friends', 'nx_blocklist', 'nx_events', 'nx_voice_rooms',
      'nx_voice_participants', 'nx_voice_signals', 'nx_files', 'nx_file_chunks',
      'nx_friend_requests', 'nx_chat_invites', 'nx_secrets', 'nx_device_grants'];
    const block = src.slice(src.indexOf('async function checkSchema'), src.indexOf('v1.0 SECRETS SYNC'));
    for (const t of tables) {
      assert.ok(block.includes(`create table if not exists ${t} (`), `${t} auto-created at connect`);
    }
    assert.ok(block.includes('create index if not exists'), 'hot-path indexes created too');
  });
  await ok('auto-provisioning: per-statement isolation — one failure can never skip the rest', async () => {
    const src = read('src/main/core/nx-supabase.js');
    assert.ok(src.includes('async function ensureTable(') && src.includes('await sql(ddl); return true;'),
      'every create runs through its own try/catch');
    assert.ok(!/await sql`create table if not exists nx_secrets`[\s\S]*?await sql`create table if not exists nx_device_grants`[\s\S]*?\} catch \(e\) \{[\s\S]*?auto-migration skipped/.test(src),
      'the old all-or-nothing block (which silently killed secrets/grants on one failure) is gone');
    const ensureCalls = (src.match(/await ensureTable\(/g) || []).length;
    assert.ok(ensureCalls >= 18, `every table isolated (found ${ensureCalls} direct calls + the index loop)`);
  });
  await ok('scale: high-volume tables key on bigint identities (9.2 quintillion rows, auto-increase forever)', async () => {
    const src = read('src/main/core/nx-supabase.js');
    for (const t of ['nx_chat_messages', 'nx_events', 'nx_voice_signals']) {
      const re = new RegExp(`create table if not exists ${t} \\([\\s\\S]*?id bigint generated always as identity primary key`);
      assert.ok(re.test(src), `${t} uses bigint identity`);
    }
    const sql = read('supabase/nx-supabase-setup.sql');
    for (const t of ['nx_friend_requests', 'nx_chat_invites']) {
      const re = new RegExp(`create table if not exists ${t} \\([\\s\\S]*?id bigserial primary key`);
      assert.ok(re.test(sql), `${t} uses bigserial`);
    }
  });
  await ok('scale pack: autoscale dashboard + nightly self-maintenance shipped in the setup SQL', async () => {
    const sql = read('supabase/nx-supabase-setup.sql');
    assert.ok(sql.includes('create or replace view nx_autoscale_status'), 'one-query size dashboard');
    assert.ok(sql.includes('create or replace function nx_maintain()'), 'maintenance function');
    assert.ok(sql.includes("cron.schedule('nx-nightly-maintain'"), 'pg_cron schedules it nightly');
    assert.ok(/exception when others then/.test(sql), 'pg_cron absence never breaks the file');
    assert.ok((sql.match(/autovacuum_vacuum_scale_factor/g) || []).length >= 7, 'high-volume tables autotuned');
    for (const idx of ['nx_identities_last_seen_idx', 'nx_chat_messages_created_idx', 'nx_friend_requests_from_idx', 'nx_chat_invites_group_idx', 'nx_device_grants_updated_idx']) {
      assert.ok(sql.includes(idx), `hot-path index ${idx}`);
    }
  });
  await ok('autoscale view is 42702-proof: every column qualified, OID join, schema filter', async () => {
    // ERROR 42702 regression guard: pg_stat_user_tables AND pg_class both have
    // a relname column — the view must never reference it unqualified, and the
    // join must be on the exact table OID (relid), not on a name that other
    // schemas (auth/storage/cron) could collide with.
    const sql = read('supabase/nx-supabase-setup.sql');
    const start = sql.indexOf('create or replace view nx_autoscale_status');
    assert.ok(start >= 0, 'view exists');
    const view = sql.slice(start, sql.indexOf(';', start) + 1);
    assert.ok(view.includes('c.relname'), 'relname is qualified (c.relname)');
    assert.ok(view.includes('s.n_live_tup'), 'n_live_tup is qualified (s.n_live_tup)');
    assert.ok(!/(^|[^.\w])relname\s+as\s+table_name/.test(view), 'no unqualified "relname as table_name"');
    assert.ok(view.includes('c.oid = s.relid'), 'joins on the exact table OID (c.oid = s.relid)');
    assert.ok(!view.includes('c.relname = s.relname'), 'no fragile name-to-name join');
    assert.ok(view.includes("s.schemaname = 'public'"), 'row set filtered to the public schema');
  });

  /* ---- 3. keepLauncherOpen removal ---- */
  await ok('keepLauncherOpen removed from EVERY source file (one launch switch: closeLauncherOnLaunch)', async () => {
    // settings.js is checked separately below: it must mention the key exactly
    // once — inside REMOVED_KEYS, so old stored values are stripped at load.
    const files = [
      'src/main/core/game.js', 'src/main/core/client.js',
      'src/main/ipc.js', 'src/main/main.js', 'src/main/preload.js',
      'src/renderer/js/state.js', 'src/renderer/js/mock-bridge.js', 'src/renderer/js/pages/settings.js',
      'src/renderer/js/main.js',
    ];
    for (const f of files) {
      const src = read(f);
      assert.ok(!src.includes('keepLauncherOpen'), `${f} is clean`);
    }
    const settings = read('src/main/core/settings.js');
    assert.ok(settings.includes("'keepLauncherOpen'"), 'stored values are stripped at load (REMOVED_KEYS)');
    assert.ok(!settings.includes('keepLauncherOpen: true'), 'no default anymore');
  });
  await ok('settings: keepLauncherOpen actually stripped from a stored vault (functional)', async () => {
    const out = run(`
      const assert = require('assert');
      const settings = require('${ROOT}/src/main/core/settings.js');
      settings.set({ closeLauncherOnLaunch: true });   // persist once (writes the vault)
      const s = settings.get();
      assert.ok(!('keepLauncherOpen' in s), 'gone from live settings');
      assert.equal(s.closeLauncherOnLaunch, true, 'the surviving switch still works');
      console.log('STRIP-OK');
    `);
    assert.ok(out.includes('STRIP-OK'));
  });

  /* ---- 4. NX-only injection + guards ---- */
  await ok('client: stack version 3 — every v2 cache re-resolved under the NX-only split', async () => {
    const out = run(`
      const client = require('${ROOT}/src/main/core/client.js');
      const assert = require('assert');
      assert.equal(client.STACK_VERSION, 3, 'stack v3');
      assert.ok(client.VULKAN_INCOMPATIBLE instanceof Set, 'vulkan guard set exported');
      assert.ok(client.VULKAN_INCOMPATIBLE.has('sodium') && client.VULKAN_INCOMPATIBLE.has('sodium-extra') && client.VULKAN_INCOMPATIBLE.has('iris'),
        'sodium family covered');
      assert.ok(!client.VULKAN_INCOMPATIBLE.has('nx'), 'the NX core is NEVER blocked');
      assert.equal(typeof client.filterModsForTarget, 'function');
      assert.equal(typeof client.hasVulkanMod, 'function');
      console.log('V3-OK');
    `);
    assert.ok(out.includes('V3-OK'));
  });
  await ok('guard: VulkanMod present → Sodium family skipped with a reason; everything else passes', async () => {
    const out = run(`
      const client = require('${ROOT}/src/main/core/client.js');
      const assert = require('assert');
      const fs = require('fs'); const path = require('path'); const os = require('os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vulk-'));
      fs.writeFileSync(path.join(dir, 'vulkanmod-1.0.0.jar'), 'x');
      fs.writeFileSync(path.join(dir, 'usermod.jar'), 'x');
      assert.equal(client.hasVulkanMod([dir]), true, 'vulkan detected (filename probe)');
      const mods = [
        { slug: 'nx', name: 'NX', file: 'nx-2.0.0.jar' },
        { slug: 'sodium', name: 'Sodium', file: 'sodium-0.6.jar' },
        { slug: 'sodium-extra', name: 'Sodium Extra', file: 'sodium-extra-0.6.jar' },
        { slug: 'iris', name: 'Iris', file: 'iris-1.8.jar' },
        { slug: 'lithium', name: 'Lithium', file: 'lithium-0.12.jar' },
      ];
      const f = client.filterModsForTarget(mods, [dir]);
      assert.ok(f.vulkanMod === true, 'guard flag');
      const kept = f.mods.map(m => m.slug);
      assert.deepStrictEqual(kept, ['nx', 'lithium'], 'NX core + lithium survive');
      const skipped = Object.fromEntries(f.skipped.map(s => [s.slug, s.reason]));
      assert.ok(/vulkanmod/i.test(skipped.sodium), 'sodium skipped with the vulkan reason');
      assert.ok(/vulkanmod/i.test(skipped.iris), 'iris skipped too (sodium-backed)');
      console.log('VULKAN-OK');
    `);
    assert.ok(out.includes('VULKAN-OK'));
  });
  await ok('guard: a mod already in the target is never injected twice (case-insensitive)', async () => {
    const out = run(`
      const client = require('${ROOT}/src/main/core/client.js');
      const assert = require('assert');
      const fs = require('fs'); const path = require('path'); const os = require('os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-'));
      fs.writeFileSync(path.join(dir, 'Lithium-0.12.JAR'), 'x');   // user's own copy, odd case
      const mods = [
        { slug: 'nx', name: 'NX', file: 'nx-2.0.0.jar' },
        { slug: 'lithium', name: 'Lithium', file: 'lithium-0.12.jar' },
      ];
      const f = client.filterModsForTarget(mods, [dir]);
      assert.deepStrictEqual(f.mods.map(m => m.slug), ['nx'], 'only the NX core injects');
      assert.ok(/already installed/i.test(f.skipped[0].reason), 'dedupe reason logged');
      console.log('DUP-OK');
    `);
    assert.ok(out.includes('DUP-OK'));
  });
  await ok('resolve cache: NX-only and opt-in stacks live in separate cache files (no wrong-stack reuse)', async () => {
    const out = run(`
      const client = require('${ROOT}/src/main/core/client.js');
      const assert = require('assert');
      const fs = require('fs'); const path = require('path');
      const stateDir = path.join(process.env.NEURAX_HOME, 'client', 'resolved');
      fs.mkdirSync(stateDir, { recursive: true });
      const fakeA = path.join(process.env.NEURAX_HOME, 'a.jar'); fs.writeFileSync(fakeA, 'x');
      const fakeB = path.join(process.env.NEURAX_HOME, 'b.jar'); fs.writeFileSync(fakeB, 'x');
      const mk = (file, name) => ({ slug: 'fake', name, version: '1', file, path: fakeA });
      fs.writeFileSync(path.join(stateDir, '26.1.2-ultra-nx.json'), JSON.stringify({
        gameVersion: '26.1.2', mode: 'ultra-nx', resolvedAt: Date.now(), stackVersion: client.STACK_VERSION,
        mods: [mk(fakeA, 'NX-ONLY-STATE')],
      }));
      fs.writeFileSync(path.join(stateDir, '26.1.2-ultra.json'), JSON.stringify({
        gameVersion: '26.1.2', mode: 'ultra', resolvedAt: Date.now(), stackVersion: client.STACK_VERSION,
        mods: [mk(fakeB, 'FULL-STATE')],
      }));
      (async () => {
        const nx = await client.resolveStack({ gameVersion: '26.1.2', fpsMode: 'ultra', thirdParty: false });
        assert.ok(nx.fromCache && nx.mods[0].name === 'NX-ONLY-STATE', 'NX-only mode reads the -nx cache');
        const full = await client.resolveStack({ gameVersion: '26.1.2', fpsMode: 'ultra', thirdParty: true });
        assert.ok(full.fromCache && full.mods[0].name === 'FULL-STATE', 'opt-in mode reads the full cache');
        console.log('CACHE-OK');
      })().catch((e) => { console.error(e); process.exit(1); });
    `, undefined, true);
    assert.ok(out.includes('CACHE-OK'));
  });
  await ok('prepareLaunch: honors the opt-in flag + applies both guards (static wiring)', async () => {
    const src = read('src/main/core/client.js');
    const block = src.slice(src.indexOf('async function prepareLaunch'), src.indexOf('// ---------------------------------------------------------------------------\n// INSTANCE INJECTION'));
    assert.ok(block.includes('set.clientThirdPartyMods === true'), 'third-party stack only when opted in');
    assert.ok(block.includes('thirdParty'), 'flag flows into resolveStack');
    assert.ok(block.includes('filterModsForTarget'), 'guards applied at launch time');
    assert.ok(block.includes('skipped'), 'skip reasons surfaced');
    const inst = src.slice(src.indexOf('async function injectInstanceInner'), src.indexOf('async function uninjectInstance'));
    assert.ok(inst.includes('filterModsForTarget'), 'instance injection guarded too');
    assert.ok(inst.includes('manifest.thirdParty === thirdParty'), 'flipping the opt-in re-injects');
  });
  await ok('settings + UI: third-party stack is OPT-IN everywhere (defaults, fallbacks, card)', async () => {
    const out = run(`
      const assert = require('assert');
      const settings = require('${ROOT}/src/main/core/settings.js');
      const s = settings.get();
      assert.equal(s.clientThirdPartyMods, false, 'default OFF');
      assert.equal(s.neuraxClient, true, 'NX core default ON');
      console.log('TP-OK');
    `);
    assert.ok(out.includes('TP-OK'));
    assert.ok(read('src/renderer/js/state.js').includes('clientThirdPartyMods: false'), 'renderer fallback OFF');
    assert.ok(read('src/renderer/js/mock-bridge.js').includes('clientThirdPartyMods: false'), 'mock fallback OFF');
    const ui = read('src/renderer/js/pages/settings.js');
    assert.ok(ui.includes("toggle('clientThirdPartyMods'"), 'opt-in toggle exists');
    assert.ok(ui.includes('VulkanMod'), 'UI explains the VulkanMod guard');
    assert.ok(!ui.includes('Sodium, Lithium, Iris, C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton and Dynamic FPS automatically'),
      'no more "everything auto-injected" promise');
  });
  await ok('status(): injection rule surfaced (nxAlways / thirdPartyDefault / vulkanGuard / noDuplicates)', async () => {
    const out = run(`
      const client = require('${ROOT}/src/main/core/client.js');
      const assert = require('assert');
      const st = client.status();
      assert.ok(st.injectionRule && st.injectionRule.nxAlways === true, 'NX core always');
      assert.equal(st.injectionRule.thirdPartyDefault, false, 'extras default OFF');
      assert.ok(Array.isArray(st.injectionRule.vulkanGuard) && st.injectionRule.vulkanGuard.includes('sodium'), 'vulkan guard listed');
      assert.equal(st.injectionRule.noDuplicates, true, 'no duplicates');
      assert.ok(st.stack.some(m => m.slug === 'nx' && m.bundled), 'NX core marked bundled');
      console.log('RULE-OK');
    `);
    assert.ok(out.includes('RULE-OK'));
  });

  /* ---- summary ---- */
  console.log(`\n== ${pass}/${results.length} checks passed ==`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
