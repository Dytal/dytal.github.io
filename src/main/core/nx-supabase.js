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
  chats: [],                      // { id, name, members:[{uuid,name,type,head}] }
  messages: {},                   // chatId -> last max id pulled
  locked: null,
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
/** After a successful SQL connect: are the NX tables there? If not the UI
 *  must tell the user to run supabase/nx-supabase-setup.sql. */
async function checkSchema() {
  try {
    await sql`select 1 from nx_identities limit 1`;
    schemaOk = true;
  } catch (e) {
    schemaOk = false;
    logger.nx?.warn?.(`NX cloud tables missing (${String(e.message).split('\n')[0]}) — run supabase/nx-supabase-setup.sql in the Supabase SQL editor, then press Reconnect.`);
  }
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
  // heartbeat FIRST — last_seen must advance every tick or presence goes stale
  await sql`update nx_identities set last_seen = now(), game_running = ${!!profile.gameRunning} where uuid = ${state.uuid}`;
  const h = instanceFingerprintKey([profile.instances, profile.player, appVersion]);
  if (!force && h === state.profileHash) return;
  state.profileHash = h;
  const inst = JSON.stringify(profile.instances || []);
  await sql`
    update nx_identities set
      device_name = ${profile.deviceName || ''}, platform = ${process.platform},
      app_version = ${appVersion || ''},
      player_name = ${profile.player?.name || ''}, player_uuid = ${profile.player?.uuid || ''},
      player_type = ${profile.player?.type === 'msa' ? 'msa' : 'offline'},
      instances = ${inst}::jsonb
    where uuid = ${state.uuid}`;
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
  const grp = await sql`
    select g.id, g.name, g.created_by,
      (select count(*) from nx_chat_members m2 where m2.group_id = g.id) as members,
      (select max(id) from nx_chat_messages m3 where m3.group_id = g.id) as last_id
    from nx_chat_groups g
    join nx_chat_members m on m.group_id = g.id and m.member_uuid = ${state.uuid}
    order by g.created_at asc`;
  const chats = grp.map((g) => ({ id: String(g.id), name: g.name, createdBy: String(g.created_by || ''), memberCount: Number(g.members), lastId: Number(g.last_id || 0) }));

  // detect NEW memberships (invited / added while we were offline)
  const known = new Set(state.chats.map((c) => c.id));
  let added = false;
  for (const c of chats) if (!known.has(c.id)) added = true;

  // members of my chats (for heads + invite UX)
  if (chats.length) {
    const ids = chats.map((c) => c.id);
    const mem = await sql`
      select m.group_id, i.uuid, i.player_name, i.player_type
      from nx_chat_members m join nx_identities i on i.uuid = m.member_uuid
      where m.group_id in ${sql(ids)}`;
    for (const c of chats) {
      c.members = mem.filter((r) => String(r.group_id) === c.id)
        .map((r) => ({ uuid: String(r.uuid), name: r.player_name || 'Player', type: r.player_type || 'offline' }));
    }
  } else {
    for (const c of chats) c.members = [];
  }
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

  state.connected = true;
  state.lastError = null;
  conn.ok = true; conn.at = now;
  if (!wasConnected) emit('nx:presence', { connected: true, online, total });
}

function emit(event, payload) { try { broadcast(event, payload); } catch {} }

/* -------------------------------------------------------------------- chat */
function msgRow(r) {
  return {
    id: Number(r.id), chatId: String(r.group_id),
    from: r.sender_uuid ? String(r.sender_uuid) : '',
    fromName: r.sender_name || 'Player',
    fromType: r.sender_type || 'offline',
    type: r.kind || 'text',
    text: r.body || '',
    fileId: r.file_id ? String(r.file_id) : null,
    fileName: r.file_name || '',
    fileSize: Number(r.file_size || 0),
    at: ms(r.created_at),
  };
}

async function assertMember(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const ok = await sql`select 1 from nx_chat_members where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  if (!ok.length) throw new Error('You are not a member of this chat.');
}

async function chatList() {
  return { chats: state.chats, connected: state.connected };
}

async function chatCreate(name) {
  if (!state.uuid) throw new Error('Not registered yet.');
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the group a name.');
  const ins = await sql`insert into nx_chat_groups (name, created_by) values (${clean}, ${state.uuid}) returning id`;
  const id = String(ins[0].id);
  await sql`insert into nx_chat_members (group_id, member_uuid, role) values (${id}, ${state.uuid}, 'owner') on conflict do nothing`;
  await refreshChats();
  return { chatId: id };
}

async function refreshChats() {
  // piggyback on the next tick — but do a minimal immediate pull for snappy UI
  const grp = await sql`
    select g.id, g.name, g.created_by,
      (select count(*) from nx_chat_members m2 where m2.group_id = g.id) as members
    from nx_chat_groups g
    join nx_chat_members m on m.group_id = g.id and m.member_uuid = ${state.uuid}
    order by g.created_at asc`;
  const chats = grp.map((g) => ({ id: String(g.id), name: g.name, createdBy: String(g.created_by || ''), memberCount: Number(g.members) }));
  if (chats.length) {
    const ids = chats.map((c) => c.id);
    const mem = await sql`
      select m.group_id, i.uuid, i.player_name, i.player_type
      from nx_chat_members m join nx_identities i on i.uuid = m.member_uuid
      where m.group_id in ${sql(ids)}`;
    for (const c of chats) {
      c.members = mem.filter((r) => String(r.group_id) === c.id)
        .map((r) => ({ uuid: String(r.uuid), name: r.player_name || 'Player', type: r.player_type || 'offline' }));
    }
  } else for (const c of chats) c.members = [];
  state.chats = chats;
  return chats;
}

/**
 * INVITE — resolve a friend by NX device UUID or exact Microsoft player name.
 * Only MICROSOFT players can be invited (requirement). Returns { uuid, name }.
 */
async function chatInvite(chatId, ref) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await assertMember(chatId);
  const input = String(ref || '').trim();
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
      const any = await sql`select uuid, player_name from nx_identities where lower(player_name) = lower(${input}) limit 1`;
      if (any.length) throw new Error(`"${any[0].player_name}" is an offline player — only Microsoft players can be invited.`);
    }
  }
  if (!target) throw new Error(`No Microsoft player found for "${input}". They must open the Neurax launcher and sign in once to appear.`);

  await sql`insert into nx_chat_members (group_id, member_uuid) values (${chatId}, ${target.uuid}) on conflict do nothing`;
  await refreshChats();
  // nudge the invited device immediately
  emit('nx:chat', { event: 'message', message: { chatId, invited: true } });
  return { uuid: String(target.uuid), name: target.player_name || 'Player' };
}

async function chatLeave(chatId) {
  if (!state.uuid) throw new Error('Not registered yet.');
  await sql`delete from nx_chat_members where group_id = ${chatId} and member_uuid = ${state.uuid}`;
  await refreshChats();
  return { ok: true };
}

async function chatMessages(chatId, since = 0) {
  await assertMember(chatId);
  const rows = await sql`
    select id, group_id, sender_uuid, sender_name, sender_type, kind, body, file_id, file_name, file_size, created_at
    from nx_chat_messages where group_id = ${chatId} and id > ${Number(since) || 0}
    order by id asc limit 300`;
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

/* -------------------------------------------------------------------- admin */
async function adminList() {
  const rows = await sql`
    select i.uuid, i.device_name, i.player_name, i.player_type, i.player_uuid, i.app_version,
           i.instances, i.game_running, i.last_seen,
           (i.last_seen > now() - interval '15 seconds') as online,
           coalesce(l.locked, false) as locked, l.reason as lock_reason, l.locked_until
    from nx_identities i left join nx_locks l on l.uuid = i.uuid
    order by i.last_seen desc`;
  return rows.map((r) => ({
    uuid: String(r.uuid), deviceName: r.device_name || '', playerName: r.player_name || '',
    playerType: r.player_type || 'offline', playerUuid: r.player_uuid || '', appVersion: r.app_version || '',
    instances: asJson(r.instances) || [], gameRunning: !!r.game_running,
    lastSeen: ms(r.last_seen), online: !!r.online,
    locked: !!r.locked, lockReason: r.lock_reason || '', lockedUntil: ms(r.locked_until),
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
  appVersion = opts.appVersion || '';
  loadCache();

  const settings = require('./settings').get();
  const connected = await connect(settings);
  if (connected) {
    try {
      const id = opts.identity();
      const profile = profileProvider();
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
          const id = await optsIdentity();
          const r = await register(id, profileProvider(), appVersion);
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
        await syncTick(profileProvider(), appVersion);
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
    if (sql) { try { await syncTick(profileProvider(), appVersion); } catch (e) { markOffline(e.message); } }
    else await connect(require('./settings').get());
    return publicState();
  },
  async reconnect(url) {
    if (url !== undefined) require('./settings').set({ nxSupabaseUrl: String(url || '').trim() });
    await stop();
    return start({ broadcast, onLock, profileProvider, appVersion, identity: optsIdentity });
  },
  chatList,
  chatCreate: (p) => chatCreate(p.name),
  chatInvite: (p) => chatInvite(p.chatId, p.ref),
  chatLeave: (p) => chatLeave(p.chatId),
  chatMessages: (p) => chatMessages(p.chatId, p.since || 0),
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
  setPlayerName(n) { state.playerName = n; },
  setPlayerType(t) { state.playerType = t === 'msa' ? 'msa' : 'offline'; },
  _state: state, // probe access
};
