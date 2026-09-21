// nx-supabase.js — NX Cloud transport that talks DIRECTLY to the owner's
// Supabase Postgres database (no relay server needed).
//
//  - Same capabilities as the self-hosted nx-cloud server, so NOTHING is lost:
//    device identity + UUID recovery after reinstall, presence, remote lock
//    with unlock timers, announcements (badge on create/update, silent
//    delete), group chat with invites (Microsoft players only) and file
//    sharing up to 100MB (4MB bytea chunks, streamed — memory safe).
//  - AUTO-REFRESH: one sync tick every 5 SECONDS pushes the heartbeat + pulls
//    locks / announcements / chat deltas / presence. The UI updates live.
//  - OFFLINE GRACE: when the database is unreachable the launcher keeps the
//    last known announcements/chats on screen (cached on disk), queues sent
//    messages, and retries silently — nothing breaks, the chip turns grey.
//  - IPv6 FALLBACK: db.*.supabase.co is IPv6-only. If the direct host is
//    unreachable the client discovers the project's Supavisor session pooler
//    (IPv4) across EVERY cluster generation (aws-0 / aws-1 / aws-2) and region
//    — in PARALLEL — and caches the working host. A one-shot HTTPS probe of
//    the project's public API gate classifies total failure as "project
//    paused" vs "this network can't reach it" so the user always knows what
//    to fix, and a schema check says when nx-supabase-setup.sql was not run.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { DIRS } = require('./paths');
const logger = require('./logger');

const TICK_MS = 5000;              // "auto update every 5 seconds"
const ONLINE_WINDOW_S = 15;        // heartbeat considered online within 15s
const CHUNK = 4 * 1024 * 1024;     // 4MB file chunks
const MAX_FILE = 100 * 1024 * 1024;// 100MB hard cap

const POOL_REGIONS = [
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1',
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'me-south-1', 'me-central-1', 'af-south-1', 'il-central-1',
];
// Supavisor cluster generations: older projects live on aws-0, projects
// created 2025+ are often provisioned on aws-1 (e.g. aws-1-eu-west-1) —
// sweeping only aws-0 yields "tenant/user not found" for those. Try them all.
const POOL_PREFIXES = ['aws-0', 'aws-1', 'aws-2'];

let broadcast = () => {};
let onLock = () => {};            // enforcement stays in nx-cloud.js
let sql = null;                   // live postgres.js client
let conn = { via: null, host: null, ok: false, error: null, at: 0 };
let state = {
  uuid: null,
  connected: false,
  online: 0, total: 0,
  announcements: [],
  chats: [],                      // { id, name, kind, myRole, starred, members:[{uuid,name,type,head}] }
  messages: {},                   // chatId -> last max id pulled
  locked: null,
  blocked: null,                  // v4: blocklist row hitting THIS device/account
  friends: [],                    // v4: [{ uuid, name, type, starred, online, lastSeen }]
  pending: { friendRequests: [], chatInvites: [] }, // v1.0: incoming invites awaiting accept/reject
  pendingSig: '',
  inviteSeen: [],                 // v1.0: outcome events already notified (bounded)
  voiceRooms: {},                 // v4: chatId -> { roomId, participants:[{uuid,name,muted}] }
  lastError: null,
  serverOffset: 0,
  skinUploadedAt: 0,
  profileHash: '',
  queue: [],                      // messages queued while offline
};

const OFFLINE_CACHE = path.join(DIRS.cache, 'nx-offline.json');

/* ------------------------------------------------------------- persistence */
function saveCache() {
  try {
    fs.mkdirSync(DIRS.cache, { recursive: true });
    fs.writeFileSync(OFFLINE_CACHE, JSON.stringify({
      at: Date.now(), announcements: state.announcements, chats: state.chats, queue: state.queue,
    }));
  } catch {}
}
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(OFFLINE_CACHE, 'utf8'));
    if (Date.now() - (c.at || 0) < 14 * 24 * 3600e3) {
      state.announcements = c.announcements || [];
      state.chats = c.chats || [];
      state.queue = c.queue || [];
    }
  } catch {}
}

/* ------------------------------------------------------------- connection */
function parseUrl(u) {
  try {
    const url = new URL(u.trim());
    return {
      host: url.hostname, port: Number(url.port || 5432), database: url.pathname.replace(/^\//, '') || 'postgres',
      user: decodeURIComponent(url.username || 'postgres'), password: decodeURIComponent(url.password || ''),
    };
  } catch { return null; }
}
function projectRef(p) {
  const m = String(p.host || '').match(/^db\.([a-z0-9]{20})\.supabase\.(co|com|net)$/i);
  return m ? m[1] : null;
}
let postgresMod = null;
async function openClient(p, userOverride) {
  if (!postgresMod) postgresMod = (await import('../vendor/postgres/src/index.js')).default;
  const opt = {
    host: p.host, port: p.port, database: p.database,
    user: userOverride || p.user, password: p.password,
    ssl: 'require', max: 2, idle_timeout: 25, connect_timeout: 10, prepare: false,
  };
  if (/^(127\.|localhost|::1)/i.test(p.host)) { delete opt.ssl; opt.max = 1; }
  return postgresMod(opt);
}

async function tryConnect(p, userOverride) {
  const client = await openClient(p, userOverride);
  const t0 = Date.now();
  await client`select 1`;
  return { client, ms: Date.now() - t0 };
}

/** Build the IPv4 pooler candidate list: the previously-discovered host
 *  first (instant reconnect), then every resolvable
 *  <prefix>-<region>.pooler.supabase.com across ALL cluster generations.
 *  Repairs cache values mangled by the pre-3.1.1 aws-0-only sweeper. */
async function poolerCandidates(saved) {
  const out = [];
  const seen = new Set();
  const push = (h) => {
    h = String(h || '').trim().split(':')[0].replace(/^aws-0-aws-/, 'aws-');
    if (!h || !/^[a-z0-9.-]+\.pooler\.supabase\.com$/i.test(h)) return;
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  };
  push(saved);
  const pairs = [];
  for (const pre of POOL_PREFIXES) for (const r of POOL_REGIONS) pairs.push(`${pre}-${r}.pooler.supabase.com`);
  try {
    const ok = await Promise.all(pairs.map(async (h) => {
      try { await dns.lookup(h, { family: 4 }); return h; } catch { return null; }
    }));
    ok.filter(Boolean).forEach(push);
  } catch {}
  return out;
}

/** HTTPS probe of the project's public API gate — works over IPv4 and
 *  explains WHY every SQL route failed: 401/200 → the project itself is
 *  online (so it is this network/firewall), 404/5xx → project paused or
 *  deleted, no answer → unknown. */
async function gateStatus(ref) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(`https://${ref}.supabase.co/rest/v1/`, { signal: ctl.signal });
    clearTimeout(t);
    if (res.status === 401 || res.status === 200) return 'active';
    if (res.status === 404 || res.status >= 500) return 'paused';
    return 'active';
  } catch { return 'unknown'; }
}

let schemaOk = false;
/** After a successful SQL connect: are the NX tables there? v1.0-R2 — the
 *  launcher now AUTO-PROVISIONS THE ENTIRE SCHEMA (every table + index,
 *  correct types), so a brand-new empty Supabase project grows its whole
 *  database BY ITSELF the first time any device connects — zero manual SQL,
 *  and rows auto-increase on bigint identities at 100M+ device scale.
 *  Every statement is ISOLATED: one failure (permissions, partial legacy
 *  schema…) can no longer skip the rest — the previous all-or-nothing block
 *  silently killed nx_secrets/nx_device_grants whenever the old wrong-typed
 *  nx_chat_invites create failed, which quietly disabled the owner-key cloud
 *  sync. If even the base table is missing afterwards the UI tells the user
 *  to run supabase/nx-supabase-setup.sql. */
async function ensureTable(name, ddl) {
  try { await sql(ddl); return true; }
  catch (e) {
    logger.nx?.warn?.(`NX auto-provision: ${name} skipped (${String(e.message).split('\n')[0]})`);
    return false;
  }
}

/** Detect a legacy nx_chat_invites whose group_id is NOT uuid (old builds
 *  declared bigint → error 42804) and replace it with the correct table.
 *  Rows cannot be preserved: a bigint group_id can never hold a group uuid,
 *  so the wrong-typed table is necessarily empty or junk. */
async function repairChatInvitesType() {
  try {
    const cols = await sql`select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'nx_chat_invites' and column_name = 'group_id' limit 1`;
    if (cols.length && String(cols[0].data_type) !== 'uuid') {
      logger.nx?.warn?.('NX auto-provision: legacy nx_chat_invites has a non-uuid group_id — replacing it with the correct table.');
      await sql`drop table if exists nx_chat_invites cascade`;
      await ensureTable('nx_chat_invites (repaired)', sql`create table nx_chat_invites (
        id bigserial primary key,
        group_id uuid not null references nx_chat_groups(id) on delete cascade,
        from_uuid uuid not null,
        to_uuid uuid not null,
        status text not null default 'pending',
        created_at timestamptz default now(),
        updated_at timestamptz default now(),
        unique (group_id, to_uuid))`);
    }
  } catch (e) {
    logger.nx?.warn?.(`NX auto-provision: invite-table repair skipped (${String(e.message).split('\n')[0]})`);
  }
}

async function checkSchema() {
  try {
    await sql`select 1 from nx_identities limit 1`;
    // ---- repair first: a legacy wrong-typed invites table blocks its own create
    await repairChatInvitesType();
    // ---- v4 base tables (fresh empty Supabase projects get EVERYTHING here)
    await ensureTable('nx_identities', sql`create table if not exists nx_identities (
      uuid uuid primary key default gen_random_uuid(),
      fingerprint text unique not null,
      device_name text default '',
      platform text default '',
      app_version text default '',
      player_name text default '',
      player_uuid text default '',
      player_type text default 'offline',
      skin_head text default '',
      instances jsonb default '[]'::jsonb,
      game_running boolean default false,
      created_at timestamptz not null default now(),
      last_seen timestamptz not null default now())`);
    await ensureTable('nx_locks', sql`create table if not exists nx_locks (
      uuid uuid primary key references nx_identities(uuid) on delete cascade,
      locked boolean not null default false,
      reason text not null default '',
      locked_by text not null default 'admin',
      locked_until timestamptz,
      updated_at timestamptz not null default now())`);
    await ensureTable('nx_chat_groups', sql`create table if not exists nx_chat_groups (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      created_by uuid,
      kind text not null default 'group',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now())`);
    await ensureTable('nx_chat_members', sql`create table if not exists nx_chat_members (
      group_id uuid not null references nx_chat_groups(id) on delete cascade,
      member_uuid uuid not null references nx_identities(uuid) on delete cascade,
      role text not null default 'member',
      starred boolean not null default false,
      joined_at timestamptz not null default now(),
      primary key (group_id, member_uuid))`);
    await ensureTable('nx_chat_messages', sql`create table if not exists nx_chat_messages (
      id bigint generated always as identity primary key,
      group_id uuid not null references nx_chat_groups(id) on delete cascade,
      sender_uuid uuid,
      sender_name text not null default '',
      sender_type text not null default 'offline',
      kind text not null default 'text',
      body text not null default '',
      file_id uuid,
      file_name text not null default '',
      file_size bigint not null default 0,
      deleted_for_everyone boolean not null default false,
      edited_at timestamptz,
      deleted_at timestamptz,
      created_at timestamptz not null default now())`);
    await ensureTable('nx_message_deletes', sql`create table if not exists nx_message_deletes (
      message_id bigint not null references nx_chat_messages(id) on delete cascade,
      member_uuid uuid not null references nx_identities(uuid) on delete cascade,
      deleted_at timestamptz not null default now(),
      primary key (message_id, member_uuid))`);
    await ensureTable('nx_friends', sql`create table if not exists nx_friends (
      owner_uuid uuid not null references nx_identities(uuid) on delete cascade,
      friend_uuid uuid not null references nx_identities(uuid) on delete cascade,
      starred boolean not null default false,
      created_at timestamptz not null default now(),
      primary key (owner_uuid, friend_uuid))`);
    await ensureTable('nx_blocklist', sql`create table if not exists nx_blocklist (
      id uuid primary key default gen_random_uuid(),
      kind text not null,
      value text not null,
      label text not null default '',
      reason text not null default '',
      created_by text not null default 'owner',
      created_at timestamptz not null default now(),
      unique (kind, value))`);
    await ensureTable('nx_events', sql`create table if not exists nx_events (
      id bigint generated always as identity primary key,
      at timestamptz not null default now(),
      kind text not null,
      actor text not null default '',
      device_uuid uuid,
      details jsonb not null default '{}'::jsonb)`);
    await ensureTable('nx_voice_rooms', sql`create table if not exists nx_voice_rooms (
      id uuid primary key default gen_random_uuid(),
      chat_id uuid not null references nx_chat_groups(id) on delete cascade,
      created_by uuid,
      active boolean not null default true,
      created_at timestamptz not null default now())`);
    await ensureTable('nx_voice_participants', sql`create table if not exists nx_voice_participants (
      room_id uuid not null references nx_voice_rooms(id) on delete cascade,
      uuid uuid not null references nx_identities(uuid) on delete cascade,
      name text not null default '',
      muted boolean not null default false,
      joined_at timestamptz not null default now(),
      last_seen timestamptz not null default now(),
      primary key (room_id, uuid))`);
    await ensureTable('nx_voice_signals', sql`create table if not exists nx_voice_signals (
      id bigint generated always as identity primary key,
      room_id uuid not null,
      from_uuid uuid not null,
      to_uuid uuid not null,
      payload jsonb not null,
      created_at timestamptz not null default now())`);
    await ensureTable('nx_files', sql`create table if not exists nx_files (
      id uuid primary key default gen_random_uuid(),
      file_name text not null default '',
      file_size bigint not null default 0,
      mime text not null default 'file',
      chunks integer not null default 0,
      created_by uuid,
      created_at timestamptz not null default now())`);
    await ensureTable('nx_file_chunks', sql`create table if not exists nx_file_chunks (
      file_id uuid not null references nx_files(id) on delete cascade,
      idx integer not null,
      data bytea not null,
      primary key (file_id, idx))`);
    // ---- v1.0 invitation / secrets / device-grant tables (uuid group_id!)
    await ensureTable('nx_friend_requests', sql`create table if not exists nx_friend_requests (
      id bigserial primary key,
      from_uuid uuid not null,
      to_uuid uuid not null,
      status text not null default 'pending',
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      unique (from_uuid, to_uuid))`);
    await ensureTable('nx_chat_invites', sql`create table if not exists nx_chat_invites (
      id bigserial primary key,
      group_id uuid not null references nx_chat_groups(id) on delete cascade,
      from_uuid uuid not null,
      to_uuid uuid not null,
      status text not null default 'pending',
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      unique (group_id, to_uuid))`);
    await ensureTable('nx_secrets', sql`create table if not exists nx_secrets (
      name text primary key,
      value text not null default '',
      updated_at timestamptz default now())`);
    await ensureTable('nx_device_grants', sql`create table if not exists nx_device_grants (
      uuid uuid primary key,
      player_name text not null default '',
      key_hash text not null default '',
      granted_at timestamptz default now(),
      updated_at timestamptz default now())`);
    // ---- hot-path indexes (planet-scale lookups) — failures never fatal
    const IDX = [
      ['nx_friend_requests_to_idx', 'create index if not exists nx_friend_requests_to_idx on nx_friend_requests (to_uuid, status)'],
      ['nx_friend_requests_from_idx', 'create index if not exists nx_friend_requests_from_idx on nx_friend_requests (from_uuid, status)'],
      ['nx_chat_invites_to_idx', 'create index if not exists nx_chat_invites_to_idx on nx_chat_invites (to_uuid, status)'],
      ['nx_chat_invites_group_idx', 'create index if not exists nx_chat_invites_group_idx on nx_chat_invites (group_id, status)'],
      ['nx_chat_messages_group_idx', 'create index if not exists nx_chat_messages_group_idx on nx_chat_messages (group_id, id)'],
      ['nx_chat_members_member_idx', 'create index if not exists nx_chat_members_member_idx on nx_chat_members (member_uuid)'],
      ['nx_identities_last_seen_idx', 'create index if not exists nx_identities_last_seen_idx on nx_identities (last_seen desc)'],
      ['nx_events_at_idx', 'create index if not exists nx_events_at_idx on nx_events (at desc)'],
      ['nx_voice_signals_to_idx', 'create index if not exists nx_voice_signals_to_idx on nx_voice_signals (to_uuid, id)'],
      ['nx_device_grants_updated_idx', 'create index if not exists nx_device_grants_updated_idx on nx_device_grants (updated_at desc)'],
    ];
    for (const [name, stmt] of IDX) await ensureTable(`index ${name}`, sql(stmt));
    schemaOk = true;
    await syncOwnerSecrets(); // v1.0 — Supabase is the source of truth for the owner key
  } catch (e) {
    schemaOk = false;
    logger.nx?.warn?.(`NX cloud tables missing (${String(e.message).split('\n')[0]}) — run supabase/nx-supabase-setup.sql in the Supabase SQL editor, then press Reconnect.`);
  }
}

/* --------------------------------------------------------- v1.0 SECRETS SYNC
   The owner asked for the launcher to keep ALL keys and important info in
   Supabase and FETCH/USE/UPDATE them as it goes — instead of relying on what
   a PC happens to have saved. The owner key is a single row (nx_secrets):
   • the row is missing            → the launcher seeds it (canonical key)
   • the row holds the current key → nothing to do
   • the row holds a NEWER key     → the launcher ADOPTS it (sealed locally)
                                     — the cloud is the source of truth.
   Never throws; a failed sync simply retries on the next reconnect. */
let secretsSynced = false;
async function syncOwnerSecrets() {
  if (secretsSynced || !sql) return;
  try {
    const rows = await sql`select value from nx_secrets where name = 'owner_key' limit 1`;
    const keys = require('./nx-admin-keys');
    const canonical = require('./nx-canonical');
    if (!rows.length || !String(rows[0].value || '').trim()) {
      await sql`insert into nx_secrets (name, value) values ('owner_key', ${canonical.OWNER_KEY}) on conflict (name) do nothing`;
      logger.nx?.info?.('Owner key seeded into NX Cloud (nx_secrets.owner_key).');
    } else {
      const cloudKey = String(rows[0].value).trim();
      if (cloudKey.length >= 12 && cloudKey !== keys.ADMIN_KEY) {
        keys.rotate({ adminKey: cloudKey, unlockPasskey: cloudKey }); // sealed locally + live
        logger.nx?.info?.('Owner key synced FROM NX Cloud (Supabase) — the local sealed key vault was updated.');
      }
    }
    secretsSynced = true;
  } catch (e) {
    logger.nx?.debug?.(`owner key sync: ${String(e.message).split('\n')[0]}`);
  }
}

/** Mirror a device grant (uuid + key hash + timestamp) into the cloud. */
async function syncDeviceGrant(info) {
  if (!sql || !state.uuid) return { ok: false };
  try {
    await sql`
      insert into nx_device_grants (uuid, player_name, key_hash, granted_at)
      values (${state.uuid}, ${state.playerName || ''}, ${info.keyHash || ''}, now())
      on conflict (uuid) do update set
        player_name = excluded.player_name, key_hash = excluded.key_hash,
        granted_at = excluded.granted_at, updated_at = now()`;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** Connect: direct first, then ONE parallel IPv4 session-pooler sweep across
 *  every Supavisor cluster generation (aws-0/aws-1/aws-2) x region. */
async function connect(settings) {
  conn = { via: null, host: null, ok: false, error: null, at: Date.now() };
  lastDiscoverAt = Date.now();
  const raw = (settings.nxSupabaseUrl || '').trim();
  if (!raw) { conn.error = 'No Supabase connection string configured.'; return false; }
  const p = parseUrl(raw);
  if (!p) { conn.error = 'Connection string is not a valid postgres:// URL.'; return false; }
  const ref0 = projectRef(p);

  // 0) cached pooler host (IPv4) — instant path for every boot after the
  //    first successful discovery; skips the hopeless IPv6 direct attempt
  const savedHost = String(settings.nxSupabasePooler || '').trim().split(':')[0].replace(/^aws-0-aws-/, 'aws-');
  if (savedHost && ref0 && /^[a-z0-9.-]+\.pooler\.supabase\.com$/i.test(savedHost)) {
    let client;
    try {
      client = await openClient({ ...p, host: savedHost, port: 5432 }, `postgres.${ref0}`);
      await client`select 1`;
      if (sql) { try { await sql.end({ timeout: 1 }); } catch {} }
      sql = client;
      conn = { via: 'pooler', host: savedHost, ok: true, error: null, at: Date.now() };
      logger.nx?.debug?.(`supabase via cached pooler ${savedHost}`);
      await checkSchema();
      return true;
    } catch (e) {
      try { await client?.end({ timeout: 1 }); } catch {}
      logger.nx?.debug?.(`cached pooler ${savedHost} failed: ${e.message}`);
    }
  }

  // 1) direct (IPv6 on Supabase; plain on custom hosts / local tests)
  let directErr = '';
  try {
    const { client } = await tryConnect(p);
    if (sql) { try { await sql.end({ timeout: 1 }); } catch {} }
    sql = client;
    conn = { via: 'direct', host: p.host, ok: true, error: null, at: Date.now() };
    await checkSchema();
    return true;
  } catch (e) {
    directErr = e.message;
    conn.error = e.message;
    logger.nx?.debug?.(`supabase direct connect failed: ${e.message}`);
  }

  // 2) session pooler (IPv4) — parallel sweep, first success takes the socket
  const ref = ref0;
  if (!ref) return false;
  const user = `postgres.${ref}`;
  const cands = await poolerCandidates(settings.nxSupabasePooler);
  const done = await Promise.all(cands.map(async (host) => {
    let client;
    const t0 = Date.now();
    try {
      client = await openClient({ ...p, host, port: 5432 }, user);
      await client`select 1`;
      return { ok: true, host, client, ms: Date.now() - t0 };
    } catch (e) {
      try { await client?.end({ timeout: 1 }); } catch {}
      return { ok: false, host, err: e.message };
    }
  }));
  const win = done.find((d) => d.ok);
  if (win) {
    for (const d of done) if (d.ok && d !== win) { try { await d.client.end({ timeout: 1 }); } catch {} }
    if (sql) { try { await sql.end({ timeout: 1 }); } catch {} }
    sql = win.client;
    conn = { via: 'pooler', host: win.host, ok: true, error: null, at: Date.now() };
    try { require('./settings').set({ nxSupabasePooler: win.host }); } catch {}
    logger.nx?.info?.(`Supabase reachable via IPv4 session pooler ${win.host} (${win.ms}ms, ${done.length} hosts swept)`);
    await checkSchema();
    return true;
  }
  // 3) everything failed — classify so the user knows WHAT to fix
  const gs = await gateStatus(ref);
  conn.error = gs === 'active'
    ? `Project is online but unreachable from this network (direct: ${directErr}; ${done.length} IPv4 pooler hosts tried)`
    : gs === 'paused'
      ? 'Project looks PAUSED — open the Supabase dashboard, restore it, then press Reconnect'
      : `Unreachable (direct: ${directErr}; ${done.length} IPv4 pooler hosts tried)`;
  logger.nx?.warn?.(`Supabase discovery failed — ${conn.error}`);
  return false;
}

/** Test a connection string from the Settings page (same multi-cluster sweep). */
async function testConnection(url) {
  const p = parseUrl(String(url || '').trim());
  if (!p) return { ok: false, error: 'Not a valid postgres:// URL' };
  try {
    const { client, ms } = await tryConnect(p);
    await client.end({ timeout: 1 });
    return { ok: true, via: 'direct', ms };
  } catch (e) {
    const ref = projectRef(p);
    if (!ref) return { ok: false, error: e.message };
    const user = `postgres.${ref}`;
    const cands = await poolerCandidates('');
    const done = await Promise.all(cands.map(async (host) => {
      let client;
      const t0 = Date.now();
      try {
        client = await openClient({ ...p, host, port: 5432 }, user);
        await client`select 1`;
        const ms2 = Date.now() - t0;
        try { await client.end({ timeout: 1 }); } catch {}
        return { ok: true, host, ms: ms2 };
      } catch (er) {
        try { await client?.end({ timeout: 1 }); } catch {}
        return { ok: false, host, err: er.message };
      }
    }));
    const win = done.find((d) => d.ok);
    if (win) return { ok: true, via: `pooler (${win.host})`, ms: win.ms };
    const gs = await gateStatus(ref);
    return { ok: false, error: gs === 'active'
      ? `Project is online but unreachable from this network (direct: ${e.message}; ${done.length} pooler hosts tried)`
      : gs === 'paused'
        ? 'Project looks PAUSED — restore it in the Supabase dashboard'
        : `Direct: ${e.message} — and no IPv4 pooler responded` };
  }
}

/* ------------------------------------------------------------ registration */
function instanceFingerprintKey(instances) {
  return crypto.createHash('sha1').update(JSON.stringify(instances || [])).digest('hex').slice(0, 10);
}

/** Register/recover this device. Returns { uuid, recovered }. Never throws. */
async function register(identity, profile, appVersion) {
  const fp = identity.fingerprint;
  const rows = await sql`select uuid from nx_identities where fingerprint = ${fp} limit 1`;
  let uuid = rows.length ? String(rows[0].uuid) : null;
  let recovered = false;
  if (!uuid) {
    // try to claim with the local file's uuid hint (keeps identity stable even
    // before the cloud ever saw this device)
    if (identity.uuid) {
      const clash = await sql`select fingerprint from nx_identities where uuid = ${identity.uuid} limit 1`;
      if (!clash.length) {
        await sql`insert into nx_identities (uuid, fingerprint) values (${identity.uuid}, ${fp})`;
        uuid = identity.uuid;
      }
    }
    if (!uuid) {
      const ins = await sql`insert into nx_identities (fingerprint) values (${fp}) returning uuid`;
      uuid = String(ins[0].uuid);
    }
  }
  recovered = uuid !== identity.uuid;
  state.uuid = uuid;
  await pushProfile(profile, appVersion, true);
  await sql`insert into nx_locks (uuid, locked) values (${uuid}, false) on conflict (uuid) do nothing`;
  return { uuid, recovered };
}

async function pushProfile(profile, appVersion, force = false) {
  if (!state.uuid || !sql) return;
  // v4.1 GUARD: profileProvider() is async — a caller that forgets to await it
  // would push an EMPTY profile (player_name='', type='offline') and wipe the
  // identity row. That exact bug made every "lock account X" / chat invite
  // answer "No Microsoft player found". Fail loudly instead of corrupting.
  if (profile && typeof profile.then === 'function') {
    throw new Error('pushProfile received an unawaited profile Promise (engine bug)');
  }
  // heartbeat FIRST — last_seen must advance every tick or presence goes stale
  await sql`update nx_identities set last_seen = now(), game_running = ${!!profile.gameRunning} where uuid = ${state.uuid}`;
  const h = instanceFingerprintKey([profile.instances, profile.player, appVersion]);
  if (!force && h === state.profileHash) return;
  const inst = JSON.stringify(profile.instances || []);
  // v4.1: the hash is remembered ONLY after the UPDATE actually succeeded —
  // before, a transient failure froze the row on stale data forever.
  await sql`
    update nx_identities set
      device_name = ${profile.deviceName || ''}, platform = ${process.platform},
      app_version = ${appVersion || ''},
      player_name = ${profile.player?.name || ''}, player_uuid = ${profile.player?.uuid || ''},
      player_type = ${profile.player?.type === 'msa' ? 'msa' : 'offline'},
      instances = ${inst}::jsonb
    where uuid = ${state.uuid}`;
  state.profileHash = h;
}

/* ------------------------------------------------------------------ v4.1
   MOJANG FALLBACK — resolve a Minecraft username to its canonical UUID via
   the public Mojang API. Used when the player has no (fresh) nx_identities
   row, so the owner can block a Microsoft account even if that player never
   opened this launcher, and chat can detect renamed players by uuid. */
async function mojangLookup(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 16 || !/^[A-Za-z0-9_]+$/.test(n)) return null;
  try {
    const { request } = require('./net');
    const res = await request('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(n), {
      method: 'GET', timeout: 15000,
    });
    if (res.status !== 200 || !res.buffer || !res.buffer.length) return null; // 204/404 = unknown name
    const data = JSON.parse(res.buffer.toString('utf8'));
    if (!data || !data.id) return null;
    const dashed = String(data.id).replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5').toLowerCase();
    return { uuid: dashed, name: data.name || n };
  } catch { return null; }
}

async function pushSkinHead(headDataUrl) {
  if (!state.uuid || !sql || !headDataUrl) return;
  await sql`update nx_identities set skin_head = ${headDataUrl} where uuid = ${state.uuid}`;
  state.skinUploadedAt = Date.now();
}

/* ------------------------------------------------------------------- sync */
function ms(v) { return v ? new Date(v).getTime() : null; }
/** postgres.js quirk: jsonb comes back as a STRING on INSERT..RETURNING — normalize. */
function asJson(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

async function syncTick(profile, appVersion) {
  if (!sql) return;
  const now = Date.now();
  const wasConnected = state.connected;

  // heartbeat + profile delta
  await pushProfile(profile, appVersion);
  if (profile.player && now - state.skinUploadedAt > 10 * 60e3) {
    // own head refresh (10 min) — keeps the admin panel + chat faces current
    try {
      const heads = require('./skin-heads');
      const own = await heads.headDataUrl({ uuid: profile.player.uuid, name: profile.player.name });
      if (own) await pushSkinHead(own);
    } catch {}
  }

  // presence counts
  const pres = await sql`
    select count(*) filter (where last_seen > now() - interval '15 seconds') as online,
           count(*) as total
    from nx_identities`;
  const online = Number(pres[0].online), total = Number(pres[0].total);
  if (online !== state.online || total !== state.total) {
    state.online = online; state.total = total;
    emit('nx:presence', { connected: true, online, total });
  }

  // lock state (timer-aware)
  const lockRows = await sql`select locked, reason, locked_by, locked_until from nx_locks where uuid = ${state.uuid}`;
  let lock = null;
  if (lockRows.length && lockRows[0].locked) {
    const until = ms(lockRows[0].locked_until);
    if (!until || until > Date.now()) {
      lock = { reason: lockRows[0].reason || 'Locked by the administrator.', by: lockRows[0].locked_by || 'admin', until, at: Date.now() };
    }
  }
  if (JSON.stringify(lock) !== JSON.stringify(state.locked)) {
    state.locked = lock;
    onLock(lock);
  }

  // v4 BLOCKLIST enforcement — a blocked ACCOUNT is force-logged-out on every
  // device; a blocked DEVICE is locked out entirely. Routed through the same
  // lock pipeline (LOCKED screen + Minecraft quit + local mirror) with a
  // blocked=true marker so the UI can show the right reason.
  try {
    const block = await findMyBlock();
    if (block) {
      const sig = JSON.stringify(block);
      if (sig !== JSON.stringify(state.blocked)) {
        state.blocked = block;
        onLock({
          blocked: true, kind: block.kind,
          reason: (block.kind === 'msa-account' ? 'ACCOUNT BLOCKED' : 'DEVICE BLOCKED') +
            ' by the owner' + (block.reason ? ' — ' + block.reason : '.') +
            (block.kind === 'msa-account' ? ' Sign out is required; this account cannot use Neurax on any device.' : ''),
          by: 'owner', until: null, at: Date.now(),
        });
        logEvent('block-enforced', { kind: block.kind });
      }
    } else if (state.blocked) {
      state.blocked = null;
      onLock(null); // block lifted — release the overlay (real locks stay via nx_locks)
    }
  } catch {}

  // v4 friends list (cheap single join) — keeps heads/online flags current
  try { await friendsList(); } catch {}

  // announcements (small table — pull all, badge logic is client-side by updatedAt)
  const ann = await sql`select id, title, body, tags, priority, pinned, style, created_at, updated_at from nx_announcements order by pinned desc, updated_at desc`;
  const list = ann.map((a) => ({
    id: String(a.id), title: a.title, body: a.body || '', tags: a.tags || [],
    priority: a.priority || 'info', pinned: !!a.pinned, style: asJson(a.style) || {},
    createdAt: ms(a.created_at), updatedAt: ms(a.updated_at),
  }));
  if (JSON.stringify(list) !== JSON.stringify(state.announcements)) {
    state.announcements = list;
    emit('nx:announcements', { announcements: list });
  }

  // my chats (groups I'm a member of)
  const chats = await loadChats();

  // detect NEW memberships (invited / added while we were offline)
  const known = new Set(state.chats.map((c) => c.id));
  let added = false;
  for (const c of chats) if (!known.has(c.id)) added = true;

  state.chats = chats;
  if (added) emit('nx:chat', { event: 'new-chat' });

  // new messages for every chat I'm in (delta since last pull)
  for (const c of chats) {
    const since = state.messages[c.id] || 0;
    if (c.lastId <= since) continue;
    state.messages[c.id] = c.lastId;
    emit('nx:chat', { event: 'message', message: { chatId: c.id, lastId: c.lastId } });
  }

  // flush queued messages from offline periods
  while (state.queue.length) {
    const q = state.queue[0];
    try { await sendText(q.chatId, q.text, q.name); state.queue.shift(); }
    catch { break; } // still offline — keep the rest queued
  }

  // v1.0 INVITATIONS — pending friend requests + group invites (live badge +
  // accept/reject), and outcomes of MY requests (accepted/rejected toasts).
  try {
    const fr = await sql`
      select r.id, r.from_uuid, r.created_at, i.player_name, i.player_type, i.last_seen,
             (i.last_seen > now() - interval '15 seconds') as online
      from nx_friend_requests r join nx_identities i on i.uuid = r.from_uuid
      where r.to_uuid = ${state.uuid} and r.status = 'pending'
      order by r.created_at desc limit 50`;
    const ci = await sql`
      select v.id, v.group_id, v.from_uuid, v.created_at, g.name as group_name,
             i.player_name, i.player_type, i.last_seen,
             (i.last_seen > now() - interval '15 seconds') as online
      from nx_chat_invites v
      join nx_chat_groups g on g.id = v.group_id
      join nx_identities i on i.uuid = v.from_uuid
      where v.to_uuid = ${state.uuid} and v.status = 'pending'
      order by v.created_at desc limit 50`;
    const friendRequests = fr.map((r) => ({
      kind: 'friend', id: Number(r.id), uuid: String(r.from_uuid), name: r.player_name || 'Player',
      online: !!r.online, lastSeen: ms(r.last_seen), at: ms(r.created_at),
    }));
    const chatInvites = ci.map((r) => ({
      kind: 'chat', id: Number(r.id), chatId: String(r.group_id), groupName: r.group_name || 'Group chat',
      uuid: String(r.from_uuid), name: r.player_name || 'Player', online: !!r.online,
      lastSeen: ms(r.last_seen), at: ms(r.created_at),
    }));
    const sig = JSON.stringify([friendRequests, chatInvites]);
    if (sig !== state.pendingSig) {
      state.pendingSig = sig;
      state.pending = { friendRequests, chatInvites };
      emit('nx:invites', { friendRequests, chatInvites });
    }
    // outcomes of MY outgoing requests — notify exactly once per row
    const mine = await sql`
      select id, to_uuid, status, updated_at from nx_friend_requests
      where from_uuid = ${state.uuid} and status <> 'pending' and updated_at > now() - interval '10 minutes'
      order by updated_at desc limit 20`;
    for (const r of mine) {
      const key = `fr:${r.id}:${r.status}`;
      if (state.inviteSeen.includes(key)) continue;
      state.inviteSeen.unshift(key);
      const who = await sql`select player_name from nx_identities where uuid = ${r.to_uuid} limit 1`;
      emit('nx:inviteOutcome', { kind: 'friend', status: r.status, name: who.length ? who[0].player_name : 'A player' });
    }
    const mineC = await sql`
      select v.id, v.status, v.updated_at, g.name as group_name from nx_chat_invites v
      join nx_chat_groups g on g.id = v.group_id
      where v.from_uuid = ${state.uuid} and v.status <> 'pending' and v.updated_at > now() - interval '10 minutes'
      order by v.updated_at desc limit 20`;
    for (const r of mineC) {
      const key = `ci:${r.id}:${r.status}`;
      if (state.inviteSeen.includes(key)) continue;
      state.inviteSeen.unshift(key);
      emit('nx:inviteOutcome', { kind: 'chat', status: r.status, name: r.group_name || 'A group chat' });
    }
    if (state.inviteSeen.length > 200) state.inviteSeen = state.inviteSeen.slice(0, 200);
  } catch (e) { logger.nx?.debug?.(`invite sync: ${String(e.message).split('\n')[0]}`); }

  state.connected = true;
  state.lastError = null;
  conn.ok = true; conn.at = now;
  if (!wasConnected) emit('nx:presence', { connected: true, online, total });

  // v4 live voice-room scan for the chat UI badge (emit-on-change inside)
  try { await scanVoiceRooms(); } catch {}
}

function emit(event, payload) { try { broadcast(event, payload); } catch {} }

/* -------------------------------------------------------------------- chat */
function msgRow(r) {
  const killed = !!r.deleted_for_everyone;
  return {
    id: Number(r.id), chatId: String(r.group_id),
    from: r.sender_uuid ? String(r.sender_uuid) : '',
    fromName: r.sender_name || 'Player',
    fromType: r.sender_type || 'offline',
    type: killed ? 'text' : (r.kind || 'text'),
    text: killed ? '' : (r.body || ''),
    deleted: killed,
    editedAt: ms(r.edited_at),
    fileId: (!killed && r.file_id) ? String(r.file_id) : null,
    fileName: (!killed && r.file_name) || '',
    fileSize: killed ? 0 : Number(r.file_size || 0),
    at: ms(r.created_at),
  };
}

async function assertMember(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const ok = await sql`select 1 from nx_chat_members where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  if (!ok.length) throw new Error('You are not a member of this chat.');
}

async function chatList() {
  return { chats: state.chats, friends: state.friends, connected: state.connected };
}

/** Shared chat loader: my chats + members (with roles) + my role/starred.
 *  Used by the 5s tick AND the snappy immediate refresh after actions. */
async function loadChats() {
  const grp = await sql`
    select g.id, g.name, g.created_by, g.kind,
           m.role as my_role, m.starred as my_starred,
           (select count(*) from nx_chat_members m2 where m2.group_id = g.id) as member_count,
           (select max(id) from nx_chat_messages m3 where m3.group_id = g.id) as last_id
    from nx_chat_groups g
    join nx_chat_members m on m.group_id = g.id and m.member_uuid = ${state.uuid}
    order by g.updated_at desc, g.created_at asc`;
  const chats = grp.map((g) => ({
    id: String(g.id), name: g.name, createdBy: String(g.created_by || ''), kind: g.kind === 'dm' ? 'dm' : 'group',
    myRole: g.my_role || 'member', starred: !!g.my_starred,
    memberCount: Number(g.member_count), lastId: Number(g.last_id || 0),
  }));
  if (chats.length) {
    const ids = chats.map((c) => c.id);
    const mem = await sql`
      select m.group_id, m.role, i.uuid, i.player_name, i.player_type, i.last_seen,
             (i.last_seen > now() - interval '15 seconds') as online
      from nx_chat_members m join nx_identities i on i.uuid = m.member_uuid
      where m.group_id in ${sql(ids)}`;
    for (const c of chats) {
      c.members = mem.filter((r) => String(r.group_id) === c.id)
        .map((r) => ({
          uuid: String(r.uuid), name: r.player_name || 'Player', type: r.player_type || 'offline',
          role: r.role || 'member', online: !!r.online,
        }));
    }
  } else for (const c of chats) c.members = [];
  return chats;
}

async function chatCreate(name) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the group a name.');
  const ins = await sql`insert into nx_chat_groups (name, created_by, kind) values (${clean}, ${state.uuid}, 'group') returning id`;
  const id = String(ins[0].id);
  await sql`insert into nx_chat_members (group_id, member_uuid, role) values (${id}, ${state.uuid}, 'owner') on conflict do nothing`;
  await refreshChats();
  return { chatId: id };
}

async function refreshChats() {
  // piggyback on the next tick — but do a minimal immediate pull for snappy UI
  const chats = await loadChats();
  state.chats = chats;
  return chats;
}

/**
 * Resolve a friend reference (NX device UUID or exact Microsoft player name)
 * to an identity row. Only MICROSOFT players are chat-eligible (requirement).
 * Shared by INVITE, DM creation and friend adding. Returns the row.
 */
async function resolveMsaTarget(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('Enter a UUID or a player name.');
  if (input.toLowerCase() === String(state.uuid).toLowerCase()) throw new Error("That's this device — you are already in the chat.");

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
    || /^[0-9a-f]{32}$/i.test(input.replace(/-/g, ''));
  let target = null;
  if (isUuid) {
    const raw = input.replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const rows = await sql`
      select uuid, player_name, player_type from nx_identities
      where uuid = ${raw} and player_type = 'msa' limit 1`;
    target = rows[0] || null;
    if (!target) {
      const any = await sql`select uuid, player_name, player_type from nx_identities where uuid = ${raw} limit 1`;
      if (any.length) throw new Error(`Device ${any[0].player_name || input.slice(0, 8)} has no Microsoft player logged in — only Microsoft players can be invited.`);
    }
  } else {
    const rows = await sql`
      select uuid, player_name, player_type from nx_identities
      where lower(player_name) = lower(${input}) and player_type = 'msa'
      order by last_seen desc limit 1`;
    target = rows[0] || null;
    if (!target) {
      // v4.1 second chance: the row may exist under an OLD name — match the
      // canonical Mojang uuid of that name against player_uuid
      const mj = await mojangLookup(input);
      if (mj) {
        const byUuid = await sql`
          select uuid, player_name, player_type from nx_identities
          where player_uuid = ${mj.uuid} and player_type = 'msa'
          order by last_seen desc limit 1`;
        if (byUuid.length) target = byUuid[0];
      }
    }
    if (!target) {
      const any = await sql`select uuid, player_name from nx_identities where lower(player_name) = lower(${input}) limit 1`;
      if (any.length) throw new Error(`"${any[0].player_name}" is an offline player — only Microsoft players can be invited.`);
      const mj = await mojangLookup(input);
      if (mj) {
        throw new Error(`"${mj.name}" is a real Microsoft/Minecraft account (${mj.uuid.slice(0, 8)}…) but it has not signed in to Neurax Launcher on any device yet, so there is nothing to invite. Ask them to open Neurax and sign in once.`);
      }
    }
  }
  if (!target) throw new Error(`No Microsoft player found for "${input}". They must open the Neurax launcher and sign in once to appear.`);
  return target;
}

async function chatInvite(chatId, ref) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await assertMember(chatId);
  const target = await resolveMsaTarget(ref);
  // already a member? nothing to invite
  const member = await sql`select 1 from nx_chat_members where group_id = ${chatId} and member_uuid = ${target.uuid} limit 1`;
  if (member.length) throw new Error(`${target.player_name || 'That player'} is already in this chat.`);
  // v1.0 — invites are now REQUESTS the target ACCEPTS or REJECTS
  await sql`
    insert into nx_chat_invites (group_id, from_uuid, to_uuid, status)
    values (${chatId}, ${state.uuid}, ${target.uuid}, 'pending')
    on conflict (group_id, to_uuid) do update set status = 'pending', updated_at = now()`;
  await sql`update nx_chat_groups set updated_at = now() where id = ${chatId}`;
  await refreshChats();
  // nudge the invited device immediately
  emit('nx:chat', { event: 'message', message: { chatId, invited: true } });
  return { uuid: String(target.uuid), name: target.player_name || 'Player', pending: true };
}

/* ---- v1.0 INVITATIONS — accept / reject + live notifications ---- */
async function invitesList() {
  return { pending: state.pending, connected: state.connected };
}

async function inviteRespond({ id, accept }) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const rows = await sql`select * from nx_chat_invites where id = ${Number(id)} and to_uuid = ${state.uuid} limit 1`;
  if (!rows.length) throw new Error('That invite no longer exists.');
  const inv = rows[0];
  if (inv.status !== 'pending') throw new Error('That invite was already handled.');
  if (accept) {
    await sql`update nx_chat_invites set status = 'accepted', updated_at = now() where id = ${Number(id)}`;
    await sql`insert into nx_chat_members (group_id, member_uuid) values (${inv.group_id}, ${state.uuid}) on conflict do nothing`;
    await sql`update nx_chat_groups set updated_at = now() where id = ${inv.group_id}`;
    await refreshChats();
    return { ok: true, accepted: true, chatId: String(inv.group_id) };
  }
  await sql`update nx_chat_invites set status = 'rejected', updated_at = now() where id = ${Number(id)}`;
  return { ok: true, accepted: false };
}

async function chatLeave(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`delete from nx_chat_members where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  await sql`update nx_chat_groups set updated_at = now() where id = ${chatId}`;
  await refreshChats();
  return { ok: true };
}

/* ===================================================================== v4
   DIRECT MESSAGES — chat with any friend WITHOUT creating a group first.
   A DM is a chat row with kind='dm' holding exactly you + the friend; the
   display name on the friend's side is YOUR player name (set below). */
async function chatDM(ref) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const target = await resolveMsaTarget(ref);
  if (String(target.uuid) === String(state.uuid)) throw new Error("That's you.");
  // find an existing 1:1 chat with exactly the two of us
  const found = await sql`
    select g.id from nx_chat_groups g
    join nx_chat_members a on a.group_id = g.id and a.member_uuid = ${state.uuid}
    join nx_chat_members b on b.group_id = g.id and b.member_uuid = ${target.uuid}
    where g.kind = 'dm'
      and (select count(*) from nx_chat_members m where m.group_id = g.id) = 2
    limit 1`;
  let chatId;
  if (found.length) {
    chatId = String(found[0].id);
  } else {
    const myName = state.playerName || 'Player';
    const ins = await sql`
      insert into nx_chat_groups (name, created_by, kind)
      values (${myName}, ${state.uuid}, 'dm') returning id`;
    chatId = String(ins[0].id);
    await sql`insert into nx_chat_members (group_id, member_uuid, role) values (${chatId}, ${state.uuid}, 'owner') on conflict do nothing`;
    await sql`insert into nx_chat_members (group_id, member_uuid, role) values (${chatId}, ${target.uuid}, 'member') on conflict do nothing`;
    // nudge the friend immediately
    emit('nx:chat', { event: 'message', message: { chatId, invited: true } });
  }
  await refreshChats();
  return { chatId, uuid: String(target.uuid), name: target.player_name || 'Player' };
}

/* ---- group management: delete / rename / roles / kick (owner & admins) ---- */
async function myRoleIn(chatId) {
  const r = await sql`select role from nx_chat_members where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  return r.length ? (r[0].role || 'member') : null;
}

async function assertChatManager(chatId) {
  const role = await myRoleIn(chatId);
  if (!role) throw new Error('You are not a member of this chat.');
  if (role !== 'owner' && role !== 'admin') throw new Error('Only the group owner or an admin can do that.');
  return role;
}

async function chatDelete(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const role = await myRoleIn(chatId);
  if (role !== 'owner') throw new Error('Only the group owner can delete this chat.');
  // cascade wipes members + messages + tombstones
  await sql`delete from nx_chat_groups where id = ${chatId}`;
  await refreshChats();
  return { ok: true };
}

async function chatRename(chatId, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the chat a name.');
  await assertChatManager(chatId);
  await sql`update nx_chat_groups set name = ${clean}, updated_at = now() where id = ${chatId}`;
  await refreshChats();
  return { ok: true };
}

async function chatSetRole(chatId, memberUuid, role) {
  const want = String(role || '').toLowerCase();
  if (!['admin', 'member'].includes(want)) throw new Error('Role must be admin or member.');
  const myRole = await assertChatManager(chatId);
  if (myRole !== 'owner') throw new Error('Only the group owner can manage admins.');
  if (String(memberUuid) === String(state.uuid)) throw new Error("You can't change your own role.");
  const r = await sql`select role from nx_chat_members where group_id = ${chatId} and member_uuid = ${memberUuid}`;
  if (!r.length) throw new Error('That player is not a member of this chat.');
  if (r[0].role === 'owner') throw new Error('The owner role cannot be changed.');
  await sql`update nx_chat_members set role = ${want} where group_id = ${chatId} and member_uuid = ${memberUuid}`;
  await refreshChats();
  return { ok: true };
}

async function chatKick(chatId, memberUuid) {
  const myRole = await assertChatManager(chatId);
  if (String(memberUuid) === String(state.uuid)) throw new Error('Use Leave to exit the chat yourself.');
  const r = await sql`select role from nx_chat_members where group_id = ${chatId} and member_uuid = ${memberUuid}`;
  if (!r.length) throw new Error('That player is not a member of this chat.');
  if (r[0].role === 'owner') throw new Error('The owner cannot be kicked.');
  if (r[0].role === 'admin' && myRole !== 'owner') throw new Error('Only the owner can remove an admin.');
  await sql`delete from nx_chat_members where group_id = ${chatId} and member_uuid = ${memberUuid}`;
  await sql`update nx_chat_groups set updated_at = now() where id = ${chatId}`;
  await refreshChats();
  return { ok: true };
}

async function chatStar(chatId, starred) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`update nx_chat_members set starred = ${!!starred} where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  await refreshChats();
  return { ok: true };
}

/* ---- messages: edit / delete for me / delete for everyone ---- */
async function msgOwned(id) {
  const r = await sql`select id, group_id, sender_uuid, kind, deleted_for_everyone from nx_chat_messages where id = ${Number(id)}`;
  if (!r.length) throw new Error('Message not found (it may already be gone).');
  return r[0];
}

async function msgEdit(id, text) {
  const m = await msgOwned(id);
  if (String(m.sender_uuid) !== String(state.uuid)) throw new Error('You can only edit your own messages.');
  if (m.deleted_for_everyone) throw new Error('That message was deleted.');
  if (m.kind !== 'text') throw new Error('Only text messages can be edited.');
  const clean = String(text || '').slice(0, 4000);
  if (!clean.trim()) throw new Error('The message cannot be empty.');
  await sql`update nx_chat_messages set body = ${clean}, edited_at = now() where id = ${Number(id)}`;
  return { ok: true, chatId: String(m.group_id) };
}

async function msgDeleteForMe(id) {
  const m = await msgOwned(id);
  await sql`insert into nx_message_deletes (message_id, member_uuid) values (${Number(id)}, ${state.uuid}) on conflict do nothing`;
  return { ok: true, chatId: String(m.group_id) };
}

async function msgDeleteForEveryone(id) {
  const m = await msgOwned(id);
  if (String(m.sender_uuid) !== String(state.uuid)) throw new Error('You can only delete your own messages for everyone.');
  if (m.deleted_for_everyone) return { ok: true, chatId: String(m.group_id) };
  await sql`
    update nx_chat_messages set deleted_for_everyone = true, deleted_at = now(),
      body = '', file_id = null, file_name = '', file_size = 0
    where id = ${Number(id)}`;
  return { ok: true, chatId: String(m.group_id) };
}

/* ===================================================================== v4
   FRIENDS — add/star/remove any Microsoft player; one click opens a DM. */
async function friendsList() {
  if (!state.uuid || !sql) { return { friends: state.friends }; }
  const rows = await sql`
    select f.friend_uuid, f.starred, i.player_name, i.player_type, i.skin_head, i.last_seen,
           (i.last_seen > now() - interval '15 seconds') as online
    from nx_friends f join nx_identities i on i.uuid = f.friend_uuid
    where f.owner_uuid = ${state.uuid}
    order by f.starred desc, i.player_name asc`;
  state.friends = rows.map((r) => ({
    uuid: String(r.friend_uuid), name: r.player_name || 'Player', type: r.player_type || 'offline',
    starred: !!r.starred, online: !!r.online, lastSeen: ms(r.last_seen),
  }));
  return { friends: state.friends };
}

async function friendAdd(ref) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const target = await resolveMsaTarget(ref);
  const existing = await sql`select 1 from nx_friends where owner_uuid = ${state.uuid} and friend_uuid = ${target.uuid} limit 1`;
  if (existing.length) {
    await friendsList();
    return { uuid: String(target.uuid), name: target.player_name || 'Player', already: true };
  }
  // mutual shortcut: if THEY already sent us a pending request, accept it now
  const reverse = await sql`select id from nx_friend_requests where from_uuid = ${target.uuid} and to_uuid = ${state.uuid} and status = 'pending' limit 1`;
  if (reverse.length) {
    await sql`update nx_friend_requests set status = 'accepted', updated_at = now() where id = ${reverse[0].id}`;
    await sql`insert into nx_friends (owner_uuid, friend_uuid) values (${state.uuid}, ${target.uuid}) on conflict do nothing`;
    await sql`insert into nx_friends (owner_uuid, friend_uuid) values (${target.uuid}, ${state.uuid}) on conflict do nothing`;
    await friendsList();
    return { uuid: String(target.uuid), name: target.player_name || 'Player', accepted: true };
  }
  // v1.0 — friend adding is now a REQUEST the other player accepts or rejects
  await sql`
    insert into nx_friend_requests (from_uuid, to_uuid, status)
    values (${state.uuid}, ${target.uuid}, 'pending')
    on conflict (from_uuid, to_uuid) do update set status = 'pending', updated_at = now()`;
  emit('nx:chat', { event: 'message', message: { friendRequest: true, from: state.uuid, name: state.playerName } });
  await friendsList();
  return { uuid: String(target.uuid), name: target.player_name || 'Player', pending: true };
}

async function friendRespond({ id, accept }) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const rows = await sql`select * from nx_friend_requests where id = ${Number(id)} and to_uuid = ${state.uuid} limit 1`;
  if (!rows.length) throw new Error('That friend request no longer exists.');
  const req = rows[0];
  if (req.status !== 'pending') throw new Error('That friend request was already handled.');
  if (accept) {
    await sql`update nx_friend_requests set status = 'accepted', updated_at = now() where id = ${Number(id)}`;
    await sql`insert into nx_friends (owner_uuid, friend_uuid) values (${state.uuid}, ${req.from_uuid}) on conflict do nothing`;
    await sql`insert into nx_friends (owner_uuid, friend_uuid) values (${req.from_uuid}, ${state.uuid}) on conflict do nothing`;
    await friendsList();
    return { ok: true, accepted: true, uuid: String(req.from_uuid) };
  }
  await sql`update nx_friend_requests set status = 'rejected', updated_at = now() where id = ${Number(id)}`;
  return { ok: true, accepted: false };
}

async function friendRemove(uuid) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`delete from nx_friends where owner_uuid = ${state.uuid} and friend_uuid = ${String(uuid)}`;
  await friendsList();
  return { ok: true };
}

async function friendStar(uuid, starred) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`update nx_friends set starred = ${!!starred} where owner_uuid = ${state.uuid} and friend_uuid = ${String(uuid)}`;
  await friendsList();
  return { ok: true };
}

/* ===================================================================== v4
   BLOCKLIST — the owner locks a MICROSOFT ACCOUNT or a DEVICE out of the
   launcher entirely. A blocked account is refused at login on EVERY device
   and force-logged-out where it is already signed in (checked every 5s tick). */
async function blockList() {
  const rows = await sql`select id, kind, value, label, reason, created_by, created_at from nx_blocklist order by created_at desc`;
  return rows.map((r) => ({
    id: String(r.id), kind: r.kind, value: r.value, label: r.label || '',
    reason: r.reason || '', createdBy: r.created_by || 'owner', createdAt: ms(r.created_at),
  }));
}

async function blockAdd({ kind, value, reason, label }) {
  const k = String(kind || '').trim();
  const v = String(value || '').trim();
  if (!['msa-account', 'device'].includes(k)) throw new Error('Block kind must be msa-account or device.');
  if (!v) throw new Error('Give the account name / UUID or device UUID to block.');
  // msa-account: accept a player name → normalize to BOTH uuid + name rows so
  // the block sticks even if they rename later. v4.1: if the player has no
  // fresh launcher row, the name is resolved through the public Mojang API —
  // the login gate matches blocks by uuid/name at SIGN-IN time, so a block
  // created this way still locks the account out on every device.
  if (k === 'msa-account' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) && !/^[0-9a-f]{32}$/i.test(v.replace(/-/g, ''))) {
    const rows = await sql`select uuid from nx_identities where lower(player_name) = lower(${v}) and player_type = 'msa' order by last_seen desc limit 1`;
    let uuid = rows.length ? String(rows[0].uuid) : null;
    let via = rows.length ? 'launcher' : null;
    let resolved = v;
    if (!uuid) {
      // renamed players: match the canonical uuid, not just the current name
      const mj = await mojangLookup(v);
      if (mj) {
        const byMj = await sql`select uuid from nx_identities where player_uuid = ${mj.uuid} and player_type = 'msa' order by last_seen desc limit 1`;
        uuid = byMj.length ? String(byMj[0].uuid) : mj.uuid;
        via = byMj.length ? 'launcher' : 'mojang';
        resolved = mj.name;
      }
    }
    if (!uuid) {
      const anyRow = await sql`select uuid from nx_identities where lower(player_name) = lower(${v}) limit 1`;
      if (anyRow.length) throw new Error(`"${v}" is signed in as an OFFLINE player on some device — only Microsoft accounts can be account-locked. Block that device by UUID instead, or ask them to sign in with Microsoft.`);
      throw new Error(`"${v}" could not be verified as a Minecraft account (not in NX Cloud, Mojang lookup failed). Check the spelling.`);
    }
    await sql`insert into nx_blocklist (kind, value, label, reason) values ('msa-account', ${uuid}, ${String(label || resolved).slice(0, 80)}, ${String(reason || '').slice(0, 200)}) on conflict (kind, value) do update set reason = excluded.reason, label = excluded.label`;
    await sql`insert into nx_blocklist (kind, value, label, reason) values ('msa-account', ${String(v).toLowerCase()}, ${String(label || resolved).slice(0, 80)}, ${String(reason || '').slice(0, 200)}) on conflict (kind, value) do nothing`;
    logEvent('block-add', { kind: k, value: v, via: via || 'mojang' });
    return { ok: true, value: uuid, name: resolved, via: via || 'mojang' };
  }
  const norm = k === 'device' ? v.replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : (/^[0-9a-f]{32}$/i.test(v.replace(/-/g, '')) ? v.replace(/-/g, '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : v.toLowerCase());
  await sql`insert into nx_blocklist (kind, value, label, reason) values (${k}, ${norm}, ${String(label || v).slice(0, 80)}, ${String(reason || '').slice(0, 200)}) on conflict (kind, value) do update set reason = excluded.reason, label = excluded.label`;
  logEvent('block-add', { kind: k, value: v });
  return { ok: true, value: norm };
}

async function blockRemove(id) {
  await sql`delete from nx_blocklist where id = ${String(id)}`;
  logEvent('block-remove', { id: String(id) });
  return { ok: true };
}

/** The block row (if any) hitting this device uuid / player. */
async function findMyBlock() {
  if (!state.uuid || !sql) return null;
  const rows = await sql`
    select id, kind, value, reason from nx_blocklist
    where (kind = 'device' and value = ${state.uuid})
       or (kind = 'msa-account' and (
            value = ${String(state.playerUuid || '').toLowerCase()}
         or value = ${String(state.playerName || '').toLowerCase()}))
    limit 1`;
  return rows.length ? { id: String(rows[0].id), kind: rows[0].kind, reason: rows[0].reason || 'Blocked by the owner.' } : null;
}

/** Login gate: called by auth.js before a Microsoft login is accepted. */
async function loginGate(account) {
  if (!sql || !account || account.type !== 'msa') return { allowed: true };
  const rows = await sql`
    select id, reason from nx_blocklist
    where kind = 'msa-account' and (
      value = ${String(account.uuid || '').toLowerCase()} or value = ${String(account.name || '').toLowerCase()})
    limit 1`;
  if (rows.length) {
    logEvent('login-blocked', { name: account.name, uuid: account.uuid });
    return { allowed: false, reason: rows[0].reason || 'Blocked by the owner.' };
  }
  return { allowed: true };
}

async function chatMessages(chatId, since = 0) {
  await assertMember(chatId);
  const rows = await sql`
    select m.id, m.group_id, m.sender_uuid, m.sender_name, m.sender_type, m.kind, m.body,
           m.file_id, m.file_name, m.file_size, m.created_at, m.deleted_for_everyone, m.edited_at
    from nx_chat_messages m
    where m.group_id = ${chatId} and m.id > ${Number(since) || 0}
      and not exists (
        select 1 from nx_message_deletes d
        where d.message_id = m.id and d.member_uuid = ${state.uuid})
    order by m.id asc limit 300`;
  const msgs = rows.map(msgRow);
  if (msgs.length) state.messages[chatId] = msgs[msgs.length - 1].id;
  return { messages: msgs };
}

async function sendText(chatId, text, fromNameOverride) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await assertMember(chatId);
  const clean = String(text || '').slice(0, 4000);
  const ins = await sql`
    insert into nx_chat_messages (group_id, sender_uuid, sender_name, sender_type, kind, body)
    values (${chatId}, ${state.uuid}, ${fromNameOverride || state.playerName || ''}, ${state.playerType || 'offline'}, 'text', ${clean})
    returning id`;
  await sql`update nx_chat_groups set updated_at = now() where id = ${chatId}`;
  return { id: Number(ins[0].id) };
}

/** File send: 4MB chunks streamed from disk — a 100MB upload never balloons RAM. */
async function chatSendFile({ chatId, filePath, kind, onProgress, fromNameOverride }) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await assertMember(chatId);
  const st = fs.statSync(filePath);
  if (st.size > MAX_FILE) throw new Error('Files are limited to 100MB');
  if (st.size === 0) throw new Error('That file is empty.');
  const name = path.basename(filePath);
  const mime = kind || (/\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : /\.(mp4|mkv|webm|mov|avi)$/i.test(name) ? 'video' : 'file');

  const meta = await sql`
    insert into nx_files (file_name, file_size, mime, chunks, created_by)
    values (${name}, ${st.size}, ${mime}, ${Math.ceil(st.size / CHUNK)}, ${state.uuid}) returning id`;
  const fileId = String(meta[0].id);

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, st.size));
    for (let idx = 0, at = 0; at < st.size; idx++, at += CHUNK) {
      const len = Math.min(CHUNK, st.size - at);
      const slice = len === buf.length ? buf : Buffer.alloc(len);
      fs.readSync(fd, slice, 0, len, at);
      await sql`insert into nx_file_chunks (file_id, idx, data) values (${fileId}, ${idx}, ${slice})`;
      onProgress && onProgress(Math.min(at + len, st.size), st.size);
    }
  } catch (e) {
    try { await sql`delete from nx_files where id = ${fileId}`; } catch {}
    throw e;
  } finally { fs.closeSync(fd); }

  await sql`
    insert into nx_chat_messages (group_id, sender_uuid, sender_name, sender_type, kind, body, file_id, file_name, file_size)
    values (${chatId}, ${state.uuid}, ${fromNameOverride || state.playerName || ''}, ${state.playerType || 'offline'}, ${mime}, '', ${fileId}, ${name}, ${st.size})
    returning id`;
  return { fileId, name, size: st.size };
}

async function downloadFile({ fileId, fileName, destDir, onProgress }) {
  const meta = await sql`select file_name, file_size, chunks from nx_files where id = ${fileId}`;
  if (!meta.length) throw new Error('File not found (it may have been removed).');
  const name = fileName || meta[0].file_name || 'file';
  const dest = path.join(destDir || path.join(DIRS.root, 'downloads'), name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  const total = Number(meta[0].chunks) || 1;
  for (let i = 0; i < total; i++) {
    const c = await sql`select data from nx_file_chunks where file_id = ${fileId} and idx = ${i}`;
    if (!c.length) throw new Error('File data is incomplete (chunk ' + i + ' missing).');
    out.write(Buffer.from(c[0].data));
    onProgress && onProgress(i + 1, total);
  }
  await new Promise((res) => out.end(res));
  return dest;
}

/* ------------------------------------------------------------ announcements */
function annRow(a) {
  return {
    id: String(a.id), title: a.title, body: a.body || '', tags: a.tags || [],
    priority: a.priority || 'info', pinned: !!a.pinned, style: asJson(a.style) || {},
    createdAt: ms(a.created_at), updatedAt: ms(a.updated_at),
  };
}
async function annCreate({ title, body, tags, priority, pinned, style }) {
  const clean = String(title || '').trim();
  if (!clean) throw new Error('The announcement needs a title.');
  const tagArr = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [];
  const ins = await sql`
    insert into nx_announcements (title, body, tags, priority, pinned, style)
    values (${clean.slice(0, 120)}, ${String(body || '').slice(0, 4000)}, ${tagArr},
            ${['info', 'important', 'critical'].includes(priority) ? priority : 'info'},
            ${!!pinned}, ${JSON.stringify(style || {})}::jsonb)
    returning *`;
  return annRow(ins[0]);
}
async function annUpdate(id, patch) {
  const cur = await sql`select * from nx_announcements where id = ${id}`;
  if (!cur.length) throw new Error('Announcement not found.');
  const a = cur[0];
  const title = patch.title !== undefined ? String(patch.title).trim().slice(0, 120) || a.title : a.title;
  const body = patch.body !== undefined ? String(patch.body).slice(0, 4000) : a.body;
  const tags = patch.tags !== undefined ? (Array.isArray(patch.tags) ? patch.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : a.tags) : a.tags;
  const priority = patch.priority !== undefined ? (['info', 'important', 'critical'].includes(patch.priority) ? patch.priority : a.priority) : a.priority;
  const pinned = patch.pinned !== undefined ? !!patch.pinned : a.pinned;
  const style = patch.style !== undefined ? JSON.stringify(patch.style || {}) : JSON.stringify(a.style || {});
  const upd = await sql`
    update nx_announcements set title = ${title}, body = ${body}, tags = ${tags},
      priority = ${priority}, pinned = ${pinned}, style = ${style}::jsonb, updated_at = now()
    where id = ${id} returning *`;
  return annRow(upd[0]);
}
async function annDelete(id) {
  // deleting is SILENT: no updated_at bump anywhere → no red badge (requirement)
  await sql`delete from nx_announcements where id = ${id}`;
  return { ok: true };
}

/* ======================================================================= v4
   ACTIVITY FEED — "see everything that happens on my launcher". One small row
   per meaningful action (login, logout, game start/stop, lock, block…).
   Fire-and-forget: logging can never break the action it describes. */
function logEvent(kind, details = {}, actor) {
  if (!sql) return;
  const payload = { kind: String(kind).slice(0, 40), actor: String(actor || state.playerName || '').slice(0, 60), details };
  Promise.resolve()
    .then(() => sql`
      insert into nx_events (kind, actor, device_uuid, details)
      values (${payload.kind}, ${payload.actor}, ${state.uuid}, ${JSON.stringify(details || {})}::jsonb)`)
    .catch(() => {});
}

async function eventsList(limit = 150) {
  const rows = await sql`
    select e.id, e.at, e.kind, e.actor, e.device_uuid, e.details,
           i.player_name as device_player
    from nx_events e left join nx_identities i on i.uuid = e.device_uuid
    order by e.id desc limit ${Math.min(Math.max(Number(limit) || 150, 1), 500)}`;
  return rows.map((r) => ({
    id: Number(r.id), at: ms(r.at), kind: r.kind, actor: r.actor || '',
    deviceUuid: r.device_uuid ? String(r.device_uuid) : null,
    devicePlayer: r.device_player || '',
    details: asJson(r.details) || {},
  }));
}

/* ======================================================================= v4
   VOICE CALLS — rooms per chat + WebRTC signaling mailbox. The AUDIO itself
   is peer-to-peer (renderer RTCPeerConnection, STUN only); the database only
   stores who is in the room and carries offer/answer/ICE envelopes. */
async function voiceJoin(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await assertMember(chatId);
  // leave any stale participations (crash / closed launcher mid-call)
  await sql`
    delete from nx_voice_participants p using nx_voice_rooms r
    where p.room_id = r.id and p.uuid = ${state.uuid} and (r.chat_id <> ${chatId} or r.active = false)`;
  // find or create the room for this chat
  const room = await sql`select id from nx_voice_rooms where chat_id = ${chatId} and active = true order by created_at desc limit 1`;
  let roomId;
  if (room.length) roomId = String(room[0].id);
  else {
    const ins = await sql`insert into nx_voice_rooms (chat_id, created_by) values (${chatId}, ${state.uuid}) returning id`;
    roomId = String(ins[0].id);
    logEvent('voice-start', { chatId });
  }
  await sql`
    insert into nx_voice_participants (room_id, uuid, name, joined_at, last_seen)
    values (${roomId}, ${state.uuid}, ${state.playerName || 'Player'}, now(), now())
    on conflict (room_id, uuid) do update set last_seen = now(), name = ${state.playerName || 'Player'}`;
  const parts = await voiceParticipants(roomId);
  return { roomId, selfId: state.uuid, participants: parts };
}

async function voiceParticipants(roomId) {
  const rows = await sql`
    select uuid, name, muted from nx_voice_participants
    where room_id = ${roomId} and last_seen > now() - interval '15 seconds'
    order by joined_at asc`;
  return rows.map((r) => ({ uuid: String(r.uuid), name: r.name || 'Player', muted: !!r.muted }));
}

/** Voice heartbeat + signaling poll (renderer calls this ~every 1.2s while in a call). */
async function voiceTick({ roomId, since }) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`update nx_voice_participants set last_seen = now() where room_id = ${roomId} and uuid = ${state.uuid}`;
  const parts = await voiceParticipants(roomId);
  const sigs = await sql`
    select id, from_uuid, payload from nx_voice_signals
    where room_id = ${roomId} and to_uuid = ${state.uuid} and id > ${Number(since) || 0}
    order by id asc limit 60`;
  let maxId = Number(since) || 0;
  const out = sigs.map((s) => { maxId = Math.max(maxId, Number(s.id)); return { id: Number(s.id), from: String(s.from_uuid), payload: asJson(s.payload) }; });
  if (out.length) await sql`delete from nx_voice_signals where room_id = ${roomId} and to_uuid = ${state.uuid} and id <= ${maxId}`;
  return { participants: parts, signals: out, cursor: maxId };
}

async function voiceSignal({ roomId, to, payload }) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`insert into nx_voice_signals (room_id, from_uuid, to_uuid, payload) values (${String(roomId)}, ${state.uuid}, ${String(to)}, ${JSON.stringify(payload || {})}::jsonb)`;
  return { ok: true };
}

async function voiceUpdate({ roomId, muted }) {
  if (!state.uuid) return { ok: false };
  await sql`update nx_voice_participants set muted = ${!!muted}, last_seen = now() where room_id = ${String(roomId)} and uuid = ${state.uuid}`;
  return { ok: true };
}

async function voiceLeave({ roomId }) {
  if (!state.uuid) return { ok: false };
  await sql`delete from nx_voice_participants where room_id = ${String(roomId)} and uuid = ${state.uuid}`;
  const left = await sql`select count(*) as n from nx_voice_participants where room_id = ${String(roomId)}`;
  if (!Number(left[0].n)) await sql`update nx_voice_rooms set active = false where id = ${String(roomId)}`;
  return { ok: true };
}

/** Called from syncTick: active voice rooms across MY chats → the UI shows a
 *  live "voice" badge + one-click join. Only emits when something changed. */
async function scanVoiceRooms() {
  if (!state.chats.length) {
    if (Object.keys(state.voiceRooms).length) { state.voiceRooms = {}; emit('nx:voice', { rooms: {} }); }
    return;
  }
  const ids = state.chats.map((c) => c.id);
  const rows = await sql`
    select r.id as room_id, r.chat_id, p.uuid, p.name, p.muted
    from nx_voice_rooms r join nx_voice_participants p on p.room_id = r.id
    where r.active = true and r.chat_id in ${sql(ids)}
      and p.last_seen > now() - interval '15 seconds'
    order by p.joined_at asc`;
  const rooms = {};
  for (const r of rows) {
    const chatId = String(r.chat_id);
    (rooms[chatId] = rooms[chatId] || { roomId: String(r.room_id), chatId, participants: [] })
      .participants.push({ uuid: String(r.uuid), name: r.name || 'Player', muted: !!r.muted });
  }
  if (JSON.stringify(rooms) !== JSON.stringify(state.voiceRooms)) {
    state.voiceRooms = rooms;
    emit('nx:voice', { rooms });
  }
}

/* -------------------------------------------------------------------- admin */
async function adminList() {
  const rows = await sql`
    select i.uuid, i.device_name, i.player_name, i.player_type, i.player_uuid, i.app_version,
           i.instances, i.game_running, i.last_seen,
           (i.last_seen > now() - interval '15 seconds') as online,
           coalesce(l.locked, false) as locked, l.reason as lock_reason, l.locked_until,
           exists (select 1 from nx_blocklist b where (b.kind = 'device' and b.value = i.uuid::text)
              or (b.kind = 'msa-account' and (b.value = i.player_uuid::text or b.value = lower(i.player_name)))) as blocked
    from nx_identities i left join nx_locks l on l.uuid = i.uuid
    order by i.last_seen desc`;
  return rows.map((r) => ({
    uuid: String(r.uuid), deviceName: r.device_name || '', playerName: r.player_name || '',
    playerType: r.player_type || 'offline', playerUuid: r.player_uuid || '', appVersion: r.app_version || '',
    instances: asJson(r.instances) || [], gameRunning: !!r.game_running,
    lastSeen: ms(r.last_seen), online: !!r.online,
    locked: !!r.locked, lockReason: r.lock_reason || '', lockedUntil: ms(r.locked_until),
    blocked: !!r.blocked,
  }));
}
async function adminLock(uuid, { reason, minutes } = {}) {
  await sql`
    insert into nx_locks (uuid, locked, reason, locked_by, locked_until, updated_at)
    values (${uuid}, true, ${String(reason || 'Locked by the administrator.').slice(0, 200)}, 'admin',
            ${minutes ? new Date(Date.now() + Number(minutes) * 60000).toISOString() : null}, now())
    on conflict (uuid) do update set locked = true, reason = excluded.reason,
      locked_by = 'admin', locked_until = excluded.locked_until, updated_at = now()`;
  return { ok: true };
}
async function adminUnlock(uuid) {
  await sql`
    insert into nx_locks (uuid, locked, reason, locked_by, locked_until, updated_at)
    values (${uuid}, false, '', 'admin', null, now())
    on conflict (uuid) do update set locked = false, reason = '', locked_until = null, updated_at = now()`;
  return { ok: true };
}

/** Head for another player: cloud-uploaded row first, then Mojang, then generated. */
async function skinHeadFor({ uuid, name }) {
  const heads = require('./skin-heads');
  let cloudHead = null;
  if (uuid && sql) {
    try {
      const rows = await sql`select skin_head from nx_identities where uuid = ${uuid} and skin_head <> '' limit 1`;
      if (rows.length) cloudHead = rows[0].skin_head;
    } catch {}
  }
  return heads.headDataUrl({ uuid, name, cloudHead });
}

/* ---------------------------------------------------------------- lifecycle */
let tickTimer = null;
let tickInflight = false;
let profileProvider = () => ({});
let identityProvider = () => ({}); // v4.1: captured from start() opts ("optsIdentity" was an undefined ReferenceError)
let appVersion = '';
let lastDiscoverAt = 0;
const DISCOVER_COOLDOWN = 45000; // full (direct + region scan) at most every 45s while offline

/** Register/heartbeat error message — distinguishes "run the SQL file" from
 *  genuine failures so the user always knows which fix applies. */
const regErr = (e) => (schemaOk ? (e?.message || String(e))
  : 'Tables missing — open supabase/nx-supabase-setup.sql, run it in the Supabase SQL editor, then restart the launcher.');

async function start(opts) {
  broadcast = opts.broadcast || broadcast;
  onLock = opts.onLock || onLock;
  profileProvider = opts.profileProvider || profileProvider;
  identityProvider = opts.identity || identityProvider;
  appVersion = opts.appVersion || '';
  loadCache();

  const settings = require('./settings').get();
  const connected = await connect(settings);
  if (connected) {
    try {
      const id = await opts.identity();
      const profile = await profileProvider(); // v4.1: was an unawaited Promise → empty identity rows
      const r = await register(id, profile, appVersion);
      logger.nx?.info?.(`NX Supabase link established as ${r.uuid}${r.recovered ? ' (recovered device UUID)' : ''} via ${conn.via}`);
      emit('nx:presence', { connected: true, online: state.online, total: state.total });
    } catch (e) {
      logger.nx?.warn?.(`NX Supabase register failed: ${regErr(e)}`);
      state.lastError = regErr(e);
    }
  } else {
    logger.nx?.warn?.(`Supabase unreachable (${conn.error}) — running on cached data, retrying every ${TICK_MS / 1000}s.`);
  }

  clearInterval(tickTimer);
  tickTimer = setInterval(async () => {
    if (tickInflight) return;
    tickInflight = true;
    try {
      if (!sql) {
        // fast path: retry ONLY the cached pooler host (one cheap attempt per
        // tick) so a drop comes back within seconds instead of a full sweep
        const s = require('./settings').get();
        const savedHost = (s.nxSupabasePooler || '').trim();
        if (savedHost && Date.now() - lastDiscoverAt > TICK_MS) {
          const p = parseUrl((s.nxSupabaseUrl || '').trim());
          const ref = p && projectRef(p);
          if (p && ref) {
            lastDiscoverAt = Date.now();
            let client;
            try {
              client = await openClient({ ...p, host: savedHost, port: 5432 }, `postgres.${ref}`);
              await client`select 1`;
              sql = client;
              conn = { via: 'pooler', host: savedHost, ok: true, error: null, at: Date.now() };
              logger.nx?.info?.(`Supabase back online via cached pooler ${savedHost}`);
            } catch (e) { try { await client?.end({ timeout: 1 }); } catch {} }
          }
        }
        // backoff: a failed full discovery (direct + every pooler cluster) is
        // slow — never hammer the network every 5s; full sweep at most every 45s
        if (!sql) {
          const cooled = Date.now() - lastDiscoverAt > DISCOVER_COOLDOWN;
          if (!cooled) { markOffline(); return; }
          lastDiscoverAt = Date.now();
          const ok = await connect(require('./settings').get());
          if (!ok) { markOffline(); return; }
        }
      }
      // the boot register may never have succeeded (device was offline at
      // startup) — run it as soon as a connection exists so presence, locks
      // and chat are tied to this device's uuid
      if (sql && !state.uuid) {
        try {
          const id = await opts.identity(); // v4.1: was "optsIdentity" (ReferenceError)
          const r = await register(id, await profileProvider(), appVersion);
          logger.nx?.info?.(`NX Supabase registered as ${r.uuid} (late) via ${conn.via}`);
          emit('nx:presence', { connected: true, online: state.online, total: state.total });
        } catch (e) {
          logger.nx?.warn?.(`NX Supabase register failed: ${regErr(e)}`);
          state.lastError = regErr(e);
        }
      }
      // reachable database but the SQL file was never run — keep the socket,
      // show the precise fix instead of tearing the connection down forever
      if (sql && !schemaOk) {
        await checkSchema();
        if (!schemaOk) {
          state.connected = true;
          state.lastError = regErr(new Error('schema missing'));
          return;
        }
      }
      try {
        await syncTick(await profileProvider(), appVersion); // v4.1: provider is async — await it
      } catch (e) {
        // connection went bad mid-tick → drop client, reconnect next tick
        logger.nx?.debug?.('sync tick failed: ' + e.message);
        try { await sql.end({ timeout: 1 }); } catch {}
        sql = null;
        markOffline(e.message);
      }
    } finally { tickInflight = false; }
  }, TICK_MS);

  return publicState();
}

/* -------------------------------------------------------------------- v4.1
   OWNER TOOLS — identity rebind + forced profile push.

   rebindCloudIdentity(uuid, fingerprint): the owner re-identified this device
   from the admin panel. The fingerprint mapping is MOVED to the new uuid (the
   old row is tombstoned, not deleted — history and chat membership survive),
   so the next register() adopts the owner-chosen identity.

   forceProfilePush(): clears the push cache and pushes the CURRENT profile
   immediately — called the moment a Microsoft login completes so the cloud
   row shows the fresh player name/uuid/type without waiting for a tick. */
async function rebindCloudIdentity(uuid, fingerprint) {
  if (!sql) throw new Error('NX Cloud is not connected — cannot rebind identity.');
  const u = String(uuid || '').toLowerCase();
  const fp = String(fingerprint || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)) throw new Error('New Launcher ID must be a UUID.');
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error('New Device ID must be a 64-character fingerprint.');
  const olds = await sql`select uuid from nx_identities where fingerprint = ${fp} and uuid <> ${u}`;
  for (const r of olds) {
    await sql`update nx_identities set fingerprint = ${'rotated-' + String(r.uuid)} where uuid = ${String(r.uuid)}`;
  }
  const me = await sql`select uuid from nx_identities where uuid = ${u} limit 1`;
  if (me.length) await sql`update nx_identities set fingerprint = ${fp} where uuid = ${u}`;
  else await sql`insert into nx_identities (uuid, fingerprint) values (${u}, ${fp})`;
  await sql`insert into nx_locks (uuid, locked) values (${u}, false) on conflict (uuid) do nothing`;
  const prevUuid = state.uuid;
  state.uuid = u;
  state.blocked = null; // re-evaluated on the next tick for the NEW identity
  state.profileHash = null;
  logEvent('identity-rebind', { from: String(prevUuid || ''), to: u });
  return { ok: true, uuid: u, moved: olds.map((r) => String(r.uuid)) };
}

async function forceProfilePush() {
  state.profileHash = null;
  if (!state.uuid || !sql) return { ok: false, reason: 'not-connected' };
  try {
    await pushProfile(await profileProvider(), appVersion, true);
    return { ok: true, uuid: state.uuid };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function markOffline(err) {
  const was = state.connected;
  state.connected = false;
  state.lastError = err || conn.error || 'offline';
  conn.ok = false;
  if (was) emit('nx:presence', { connected: false, online: state.online, total: state.total });
}

async function stop() {
  clearInterval(tickTimer);
  saveCache();
  if (sql) { try { await sql.end({ timeout: 1 }); } catch {} sql = null; }
}

function publicState() {
  return {
    mode: 'supabase',
    connected: state.connected,
    via: conn.via, viaHost: conn.host,
    online: state.online, total: state.total,
    uuid: state.uuid,
    locked: state.locked,
    announcements: state.announcements,
    friends: state.friends,
    pending: state.pending,
    voiceRooms: state.voiceRooms,
    lastError: state.lastError,
    needsSchema: state.connected && !schemaOk,
    queued: state.queue.length,
  };
}

/* --------------------------------------------------------------- ipc surface
   CONVENTION: every api method takes ONE payload object (mirrors the IPC
   payloads) — nx-cloud.js forwards renderer payloads verbatim. */
const api = {
  status: () => publicState(),
  testConnection,
  async refresh() {
    if (sql) { try { await syncTick(await profileProvider(), appVersion); } catch (e) { markOffline(e.message); } }
    else await connect(require('./settings').get());
    return publicState();
  },
  async reconnect(url) {
    if (url !== undefined) require('./settings').set({ nxSupabaseUrl: String(url || '').trim() });
    await stop();
    return start({ broadcast, onLock, profileProvider, appVersion, identity: identityProvider });
  },
  // v4.1: owner tools
  forceProfilePush,
  rebindCloudIdentity: (p) => rebindCloudIdentity(p.uuid, p.fingerprint),
  mojangLookup: (p) => mojangLookup(p && p.name),
  chatList,
  chatCreate: (p) => chatCreate(p.name),
  chatDM: (p) => chatDM(p.ref),
  chatInvite: (p) => chatInvite(p.chatId, p.ref),
  chatLeave: (p) => chatLeave(p.chatId),
  chatDelete: (p) => chatDelete(p.chatId),
  chatRename: (p) => chatRename(p.chatId, p.name),
  chatSetRole: (p) => chatSetRole(p.chatId, p.memberUuid, p.role),
  chatKick: (p) => chatKick(p.chatId, p.memberUuid),
  chatStar: (p) => chatStar(p.chatId, p.starred),
  chatMessages: (p) => chatMessages(p.chatId, p.since || 0),
  msgEdit: (p) => msgEdit(p.id, p.text),
  msgDeleteForMe: (p) => msgDeleteForMe(p.id),
  msgDeleteForEveryone: (p) => msgDeleteForEveryone(p.id),
  friendsList,
  friendAdd: (p) => friendAdd(p.ref),
  friendRemove: (p) => friendRemove(p.uuid),
  friendStar: (p) => friendStar(p.uuid, p.starred),
  // v1.0 — invitations with accept/reject
  invitesList,
  friendRespond: (p) => friendRespond(p),
  inviteRespond: (p) => inviteRespond(p),
  syncDeviceGrant,
  blockList,
  blockAdd: (p) => blockAdd(p),
  blockRemove: (p) => blockRemove(p.id),
  loginGate: (p) => loginGate(p.account),
  eventsList: (p) => eventsList(p && p.limit),
  logEvent: (p) => { logEvent(p.kind, p.details, p.actor); return { ok: true }; },
  voiceJoin: (p) => voiceJoin(p.chatId),
  voiceTick: (p) => voiceTick(p),
  voiceSignal: (p) => voiceSignal(p),
  voiceUpdate: (p) => voiceUpdate(p),
  voiceLeave: (p) => voiceLeave(p),
  chatSend: async ({ chatId, text }) => {
    if (!state.connected || !sql) {
      // OFFLINE GRACE: queue and tell the UI it will go out later
      state.queue.push({ chatId, text, name: state.playerName || '', at: Date.now() });
      if (state.queue.length > 200) state.queue.shift();
      saveCache();
      throw new Error('Offline — message queued and will send when the connection returns.');
    }
    return sendText(chatId, text);
  },
  chatSendFile,
  downloadFile,
  annCreate,
  annUpdate: (p) => annUpdate(p.id, p.patch || p),
  annDelete: (p) => annDelete(p.id),
  adminList,
  adminLock: (p) => adminLock(p.uuid, { reason: p.reason, minutes: p.minutes }),
  adminUnlock: (p) => adminUnlock(p.uuid),
  skinHeadFor,
  flushQueue: async () => {
    const out = [];
    while (state.queue.length) {
      const q = state.queue[0];
      try { await sendText(q.chatId, q.text, q.name); state.queue.shift(); out.push(q); }
      catch { break; }
    }
    if (out.length) saveCache();
    return { sent: out.length, left: state.queue.length };
  },
};

let optsIdentity = () => null;

module.exports = {
  start, stop, api, publicState,
  setIdentityProvider(fn) { optsIdentity = fn; },
  setPlayer(n, type, playerUuid) {
    if (n !== undefined) state.playerName = n;
    if (type !== undefined) state.playerType = type === 'msa' ? 'msa' : 'offline';
    if (playerUuid !== undefined) state.playerUuid = String(playerUuid || '').toLowerCase();
  },
  _state: state, // probe access
};
