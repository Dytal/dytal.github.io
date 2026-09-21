// nx.js — NX Cloud UI: presence chip, group chat (player heads + invites),
// announcements tab with ADMIN panel (create/edit/delete + remote lock),
// offline-grace banner, and the remote LOCK screen.
// Talks to the engine through window.neurax (IPC). The engine picks the
// transport: Supabase direct (default, 5s auto-refresh) or the legacy
// self-hosted nx-cloud server.
import { el, fmtBytes, timeAgo } from './utils.js';
import { api, state } from './state.js';
import { toast } from './components/toast.js';
import { openModal, confirmModal } from './components/modal.js';
import { registerPage, navigate } from './router.js';
import { voiceCtl } from './nx-voice.js';

const $ = (s, r = document) => r.querySelector(s);

/* =================================================================
   presence state
================================================================= */
const nx = {
  presence: { connected: false, online: 0, total: 0 },
  announcements: [],
  locked: null,
  identity: null,
  admin: false, // admin panel unlocked (passphrase verified) for this session
  pending: { friendRequests: [], chatInvites: [] }, // v1.0 — invitations awaiting accept/reject
};

const SEEN_KEY = 'nxAnnouncementSeen';
function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch { return {}; } }
function markAllSeen() {
  const m = {};
  for (const a of nx.announcements) m[a.id] = a.updatedAt;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch {}
}
function unseenCount() {
  const m = seenMap();
  return nx.announcements.filter((a) => m[a.id] !== a.updatedAt).length;
}

/* =================================================================
   player heads — the WHOLE launcher shows the cropped 8x8 face (+hat),
   never the full skin PNG
================================================================= */
const headCache = new Map(); // key -> dataURL
const HEAD_CACHE_MAX = 300;  // v4: bounded cache — heads are tiny but the map must never grow forever
async function headFor(uuid, name) {
  const key = uuid || name || 'nx';
  if (headCache.has(key)) return headCache.get(key);
  let url = null;
  try { const r = await api.invoke('nx:skinHead', { uuid: uuid || '', name: name || '' }); url = r && r.url; } catch {}
  if (!url) return null;
  if (headCache.size >= HEAD_CACHE_MAX) headCache.delete(headCache.keys().next().value); // FIFO evict
  headCache.set(key, url);
  return url;
}
function headImg(uuid, name, cls = 'nx-msg-ava') {
  const img = el('img', { class: cls, alt: '', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' });
  headFor(uuid, name).then((u) => {
    if (u) img.src = u;
    else img.replaceWith(el('div', { class: cls + ' a-fallback', text: (name || '?')[0] }));
  }).catch(() => {});
  return img;
}

/* =================================================================
   presence chip (navbar)
================================================================= */
let chip = null;
function buildChip() {
  chip = el('button', { class: 'nx-chip', id: 'nx-presence-chip', title: 'NX Cloud — who is online · click to open chat' },
    el('span', { class: 'nx-chip-dot' }),
    el('span', { class: 'nx-chip-txt', text: 'NX · —' }),
  );
  chip.addEventListener('click', () => openChatPopup());
  return chip;
}
function updateChip() {
  if (!chip) return;
  const p = nx.presence;
  chip.classList.toggle('offline', !p.connected);
  chip.querySelector('.nx-chip-txt').textContent =
    p.connected ? `${p.online} online · ${p.total} total` : 'NX offline';
}

/* =================================================================
   announcements page + ADMIN panel
================================================================= */
const PRIO_LABEL = { info: 'INFO', important: 'IMPORTANT', critical: 'CRITICAL' };

function annCard(a, adminMode) {
  const color = a.style?.color || '#38e1ff';
  const banner = a.style?.banner || '#101828';
  const icon = a.style?.icon || 'spark';
  const prio = a.priority || 'info';
  const m = seenMap();
  const fresh = m[a.id] !== a.updatedAt;
  return el('article', { class: `nx-ann prio-${prio} ${fresh ? 'fresh' : ''}`, style: { '--nx-accent': color, '--nx-banner': banner } },
    el('div', { class: 'nx-ann-bar' }),
    el('div', { class: 'nx-ann-main' },
      // v4: the accent + banner THEME is now FULLY visible to every user —
      // a real banner strip carrying the owner's icon + accent styling.
      el('div', { class: 'nx-ann-banner' },
        el('span', { class: 'nx-ann-ico', text: ICON_GLYPHS[icon] || ICON_GLYPHS.spark }),
        el('span', { class: 'nx-ann-swatches' },
          el('i', { style: { background: banner }, title: 'Banner theme' }),
          el('i', { style: { background: color }, title: 'Accent theme' }),
        ),
        el('span', { class: 'nx-prio', text: PRIO_LABEL[prio] || prio }),
      ),
      el('header', {},
        el('h3', { text: a.title }),
        a.pinned ? el('span', { class: 'nx-pin', text: '📌 PINNED' }) : null,
        adminMode ? el('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          el('button', { class: 'btn small', text: 'Edit', onclick: () => annForm(a) }),
          el('button', {
            class: 'btn small danger ghost', text: 'Delete',
            onclick: async () => {
              const yes = await confirmModal({ title: 'Delete announcement', message: `"${a.title}" will be removed for everyone. Deleting is silent — no red badge fires.`, confirmLabel: 'Delete' });
              if (!yes) return;
              try { await api.invoke('nx:annDelete', { id: a.id }); toast('Deleted', a.title); await refreshAnnouncements(); rerenderAnnPage(); }
              catch (e) { toast('Delete failed', e.message, { type: 'error' }); }
            },
          }),
        ) : null,
      ),
      el('div', { class: 'nx-ann-tags' },
        (a.tags || []).map((t) => el('span', { class: 'nx-tag', text: t })),
        el('span', { class: 'nx-ann-when', text: `${a.createdAt === a.updatedAt ? 'Published' : 'Updated'} ${timeAgo(a.updatedAt)}` }),
      ),
      a.body ? el('p', { class: 'nx-ann-body', text: a.body }) : null,
    ),
  );
}

const ICON_GLYPHS = { spark: '✦', star: '★', bolt: '⚡', warn: '⚠', info: 'ℹ', mega: '📣', shield: '🛡', heart: '❤' };
function annForm(existing) {
  const isEdit = !!existing;
  const title = el('input', { class: 'input', placeholder: 'Announcement title…', maxlength: '120', value: existing?.title || '' });
  const body = el('textarea', { class: 'input', rows: '4', placeholder: 'What should everyone know? (line breaks are kept)', style: { resize: 'vertical', marginTop: '8px' } });
  body.value = existing?.body || '';
  const tags = el('input', { class: 'input', placeholder: 'Tags, comma separated — e.g. update, event, maintenance', value: (existing?.tags || []).join(', ') });
  const prio = el('select', { class: 'input', style: { marginTop: '8px' } },
    ...['info', 'important', 'critical'].map((p) => el('option', { value: p, text: PRIO_LABEL[p], selected: (existing?.priority || 'info') === p ? '' : null })));
  const pinned = el('input', { type: 'checkbox' }); pinned.checked = !!existing?.pinned;
  const color = el('input', { type: 'color', value: existing?.style?.color || '#38e1ff', title: 'Accent color' });
  const banner = el('input', { type: 'color', value: existing?.style?.banner || '#101828', title: 'Banner color' });
  const icon = el('select', { class: 'input', title: 'Banner icon' },
    ...Object.entries(ICON_GLYPHS).map(([k, g]) => el('option', { value: k, text: `${g}  ${k}`, selected: (existing?.style?.icon || 'spark') === k ? '' : null })));
  const err = el('div', { class: 'hint', style: { color: 'var(--danger)', minHeight: '16px', marginTop: '6px' } });

  const m = openModal({
    title: isEdit ? 'Edit announcement' : 'New announcement',
    sub: 'Everyone sees it in the ANNOUNCEMENTS tab. Uploading or UPDATING fires the red badge — deleting never does.',
    body: el('div', {},
      el('label', { class: 'label', text: 'Title' }), title,
      el('label', { class: 'label', style: { marginTop: '8px' }, text: 'Body' }), body,
      el('label', { class: 'label', style: { marginTop: '8px' }, text: 'Tags' }), tags,
      el('div', { style: { display: 'flex', gap: '14px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' } },
        el('label', { class: 'label', style: { margin: '0' }, text: 'Priority' }), prio,
        el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } }, pinned, 'Pinned'),
        el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } }, icon, 'Icon'),
        el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } }, color, 'Accent'),
        el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12.5px' } }, banner, 'Banner'),
      ),
      err,
    ),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn primary', text: isEdit ? 'Save (fires badge)' : 'Publish (fires badge)',
        onclick: async () => {
          err.textContent = '';
          const payload = {
            title: title.value.trim(),
            body: body.value,
            tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
            priority: prio.value,
            pinned: pinned.checked,
            style: { color: color.value, banner: banner.value, icon: icon.value },
          };
          if (!payload.title) { err.textContent = 'The announcement needs a title.'; return; }
          try {
            if (isEdit) { await api.invoke('nx:annUpdate', { id: existing.id, patch: payload }); toast('Announcement updated', 'Everyone gets the red badge.'); }
            else { await api.invoke('nx:annCreate', payload); toast('Announcement published', 'Every launcher shows a red badge.'); }
            close();
            await refreshAnnouncements();
            rerenderAnnPage();
          } catch (e) { err.textContent = e.message; }
        },
      }),
    ],
  });
  return m;
}

async function refreshAnnouncements() {
  try { const s = await api.invoke('nx:refresh'); if (s) nx.announcements = s.announcements || []; } catch {}
  updateBadge();
}

let annPageBody = null; // re-renderable announcements page content
function rerenderAnnPage() {
  if (!annPageBody) return;
  // keep the reading position stable across the re-render
  const scroller = annPageBody.closest('.page') || annPageBody.parentElement;
  const st = scroller ? scroller.scrollTop : 0;
  annPageBody.innerHTML = '';
  annPageBody.append(...buildAnnouncementsBody());
  if (scroller) scroller.scrollTop = st;
}

function buildAnnouncementsBody() {
  const frag = [];
  frag.push(el('div', { class: 'page-head' },
    el('h1', { text: 'Announcements' }),
    el('p', { class: 'page-sub', text: nx.admin ? 'News from you (NX administrator) — create, restyle, edit or delete.' : 'News and updates from the NX administrator.' }),
  ));

  /* ---- admin unlock bar ---- */
  const adminBar = el('div', { class: 'nx-admin-bar' });
  if (!nx.admin) {
    adminBar.append(
      el('span', { class: 'hint', text: 'Administrator? Unlock to publish and manage announcements + remote-lock devices.' }),
      el('button', {
        class: 'btn small', text: 'NX Admin', style: { marginLeft: 'auto' },
        onclick: () => {
          const pass = el('input', { class: 'input', type: 'password', placeholder: 'Owner passkey', style: { marginTop: '8px' } });
          const err = el('div', { class: 'hint', style: { color: 'var(--danger)', minHeight: '16px', marginTop: '6px' } });
          openModal({
            title: 'NX Administrator',
            sub: 'Enter the owner passkey to unlock announcements + remote lock on this device.',
            body: el('div', {}, pass, err),
            actions: (close) => [
              el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
              el('button', {
                class: 'btn primary', text: 'Unlock', onclick: async () => {
                  try { await api.invoke('nx:adminCheck', { pass: pass.value }); nx.admin = true; close(); rerenderAnnPage(); toast('Administrator mode', 'You can now publish announcements and lock devices.'); }
                  catch (e) { err.textContent = e.message; }
                },
              }),
            ],
          });
        },
      }),
    );
  } else {
    adminBar.classList.add('open');
    adminBar.append(
      el('span', { class: 'nx-admin-chip', text: 'NX ADMIN' }),
      el('button', { class: 'btn small primary', text: '＋ New announcement', onclick: () => annForm(null) }),
      el('button', { class: 'btn small', text: 'Devices & locks', onclick: () => openAdminDevices() }),
      el('button', { class: 'btn small', text: 'Device & login IDs', onclick: () => openIdentityEditor() }),
      el('button', { class: 'btn small danger', text: 'Blocklist', onclick: () => openBlocklist() }),
      el('button', {
        class: 'btn small ghost', text: 'Lock admin', style: { marginLeft: 'auto' },
        onclick: () => { nx.admin = false; rerenderAnnPage(); },
      }),
    );
  }
  frag.push(adminBar);

  const list = el('div', { class: 'nx-ann-list' });
  const render = (anns) => {
    list.innerHTML = '';
    const sorted = [...anns].sort((x, y) => (y.pinned - x.pinned) || (y.updatedAt - x.updatedAt));
    if (!sorted.length) {
      list.append(el('div', { class: 'empty-state' },
        el('h3', { text: 'No announcements yet' }),
        el('p', { text: nx.admin ? 'Press "＋ New announcement" to publish your first one.' : 'When the administrator publishes one, a red badge will appear on the ANNOUNCEMENTS button.' }),
      ));
      return;
    }
    for (const a of sorted) list.append(annCard(a, nx.admin));
  };
  render(nx.announcements);
  frag.push(list);
  return frag;
}

async function buildAnnouncements(container) {
  markAllSeen();
  updateBadge();
  annPageBody = el('div', {});
  container.append(annPageBody);
  annPageBody.append(...buildAnnouncementsBody());
  refreshAnnouncements().then(rerenderAnnPage).catch(() => {});
  startAnnAutoRefresh(); // 1-minute auto refresher for this tab
}

/* ---- 1-minute auto refresher (ANNOUNCEMENTS tab) ----
   Pulls fresh announcements from the engine every 60 seconds. The page is
   only re-rendered when the data ACTUALLY changed (no flicker / scroll jump
   while you are reading), and the badge stays current app-wide. */
let annAutoTimer = null;
function startAnnAutoRefresh() {
  if (annAutoTimer) return;
  annAutoTimer = setInterval(async () => {
    try {
      const before = JSON.stringify(nx.announcements);
      await refreshAnnouncements();
      if (JSON.stringify(nx.announcements) !== before) {
        if (annPageBody && document.querySelector('[data-page="announcements"]')) rerenderAnnPage();
      }
    } catch {}
  }, 60000);
}

let badgeBtn = null;
function buildAnnouncementsButton() {
  badgeBtn = el('button', { class: 'nav-item', 'data-nav': 'announcements', id: 'nx-announcements-btn' },
    'ANNOUNCEMENTS',
    el('span', { class: 'nx-badge', hidden: true }, ''),
  );
  return badgeBtn;
}
function updateBadge() {
  if (!badgeBtn) return;
  const n = unseenCount();
  const b = badgeBtn.querySelector('.nx-badge');
  if (n > 0) {
    b.hidden = false;
    b.textContent = n > 9 ? '9+' : String(n);
    b.classList.remove('pop');
    void b.offsetWidth; // restart the pop animation
    b.classList.add('pop');
  } else { b.hidden = true; }
}

/* =================================================================
   v4.1 — OWNER IDENTITY EDITOR (announcements → NX Admin → Device & login IDs)
   Lets the owner rewrite this device's LAUNCHER ID (NX uuid), the DEVICE ID
   (hardware fingerprint) and the Microsoft CLIENT ID used for sign-in.
   Gated TWICE by the owner passkey: the NX Admin session unlock AND a fresh
   passkey verified by the engine at save time (nx:identityWrite).
================================================================= */
async function openIdentityEditor() {
  const wrap = el('div', {});
  wrap.append(el('div', { class: 'hint', style: { padding: '6px 0' }, text: 'Loading current identity…' }));

  let cur = null;
  try { cur = await api.invoke('nx:identityRead', {}); } catch (e) {
    wrap.innerHTML = '';
    wrap.append(el('p', { style: { color: 'var(--danger)' }, text: 'Could not read the identity: ' + e.message }));
    return;
  }
  wrap.innerHTML = '';

  const row = (label, input, hint) => el('div', { style: { marginTop: '12px' } },
    el('label', { class: 'label', text: label }), input,
    hint ? el('div', { class: 'hint', style: { marginTop: '4px', lineHeight: '1.5' }, text: hint }) : null);

  const uuidIn = el('input', { class: 'input', value: cur.uuid || '', spellcheck: 'false', style: { fontFamily: 'monospace', fontSize: '12px' } });
  const fpIn = el('input', { class: 'input', value: cur.fingerprint || '', spellcheck: 'false', style: { fontFamily: 'monospace', fontSize: '12px' } });
  const cidIn = el('input', { class: 'input', value: cur.msClientId || '', placeholder: 'empty = built-in (00000000402b5328 official Minecraft app)', spellcheck: 'false', style: { fontFamily: 'monospace', fontSize: '12px' } });
  const passIn = el('input', { class: 'input', type: 'password', placeholder: 'Owner passkey (required to save)', style: { marginTop: '14px' } });
  const result = el('div', { class: 'hint', style: { marginTop: '10px', lineHeight: '1.6', whiteSpace: 'pre-wrap' } });

  wrap.append(
    el('div', { class: 'hint', style: { lineHeight: '1.6' }, text: `Current cloud UUID: ${cur.cloudUuid || '(not connected)'} — identity file: ${cur.file || 'memory only'}${cur.source ? ' (source: ' + cur.source + ')' : ''}` }),
    row('Launcher ID (NX UUID)', uuidIn, 'The device identity NX Cloud knows. Change it together with the Device ID for a completely fresh cloud identity; the old row is tombstoned, not deleted.'),
    row('Device ID (hardware fingerprint)', fpIn, '64 hex chars — binds the UUID to this machine (MachineGuid + motherboard). Changing it alone re-identifies the hardware mapping.'),
    row('Microsoft Client ID (login app)', cidIn, 'Used by the browser/device-code sign-in. Leave EMPTY for the built-in official Minecraft app id.'),
    passIn,
    result,
  );

  openModal({
    title: 'Device & login IDs',
    sub: 'OWNER ONLY — edit this device\u2019s Launcher ID, Device ID and the Microsoft Client ID. The passkey is verified again on save.',
    body: wrap,
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Close', onclick: close }),
      el('button', {
        class: 'btn primary', text: 'Save identity', onclick: async () => {
          result.textContent = 'Saving…';
          result.style.color = '';
          try {
            const r = await api.invoke('nx:identityWrite', {
              pass: passIn.value,
              uuid: uuidIn.value.trim(),
              fingerprint: fpIn.value.trim(),
              msClientId: cidIn.value.trim(),
            });
            const cloudUuid = (r.cloud && r.cloud.uuid) || '';
            const rebind = r.cloud && r.cloud.rebind;
            result.textContent = 'SAVED.\nLocal identity: ' + (r.identity && r.identity.uuid) +
              '\nCloud UUID now: ' + (cloudUuid || '(cloud not reachable — it adopts on next connect)') +
              (rebind && rebind.ok ? '\nRebind: fingerprint moved to the new ID' + (rebind.moved && rebind.moved.length ? ' (freed: ' + rebind.moved.join(', ') + ')' : '') : '') +
              '\nMS Client ID: ' + (r.msClientId || 'built-in');
            toast('Identity updated', 'Launcher ID / Device ID / Client ID saved.');
          } catch (e) {
            result.textContent = e.message;
            result.style.color = 'var(--danger)';
          }
        },
      }),
    ],
  });
}

/* =================================================================
   admin devices & locks (announcements → NX Admin → Devices & locks)
================================================================= */
async function openAdminDevices() {
  const wrap = el('div', { class: 'nx-dev-wrap' });
  const m = openModal({
    title: 'Devices & locks',
    sub: 'Every NX device with its MICROSOFT USERNAME, Microsoft UUID and NX launcher UUID. Locking quits Minecraft and shows the LOCKED screen; BLOCKING refuses the account/device on every device, forever.',
    body: wrap,
    onClose: () => clearInterval(tick),
  });
  const tick = setInterval(load, 5000); // auto-update every 5 seconds
  async function load() {
    let rows = [];
    try { rows = await api.invoke('nx:adminList'); } catch (e) { wrap.innerHTML = ''; wrap.append(el('div', { class: 'hint', text: 'Needs the Supabase connection: ' + e.message })); return; }
    wrap.innerHTML = '';
    if (!rows.length) wrap.append(el('div', { class: 'hint', text: 'No devices have checked in yet.' }));
    for (const d of rows) {
      const row = el('div', { class: 'nx-dev-row' },
        headImg(d.playerUuid, d.playerName || d.deviceName, 'nx-dev-head'),
        el('div', { class: 'nx-dev-info' },
          el('b', { text: d.playerName || d.deviceName || 'Unknown device' }),
          el('span', { text: `${d.deviceName} · ${d.playerType === 'msa' ? 'Microsoft' : 'offline'} · ${d.online ? 'online' : 'last seen ' + timeAgo(d.lastSeen)}` }),
          // v4: Microsoft username + Microsoft UUID right beside the launcher UUID
          el('span', { class: 'nx-dev-uuid', text: `NX UUID  ${d.uuid}` }),
          d.playerUuid ? el('span', { class: 'nx-dev-uuid', text: `MS UUID  ${d.playerUuid}` }) : null,
        ),
        el('div', { class: 'nx-dev-flags' },
          d.gameRunning ? el('span', { class: 'nx-flag run', text: 'IN GAME' }) : null,
          d.online ? el('span', { class: 'nx-flag on', text: 'ONLINE' }) : el('span', { class: 'nx-flag off', text: 'OFFLINE' }),
          d.locked ? el('span', { class: 'nx-flag lock', text: 'LOCKED' }) : null,
          d.blocked ? el('span', { class: 'nx-flag block', text: 'BLOCKED' }) : null,
        ),
        el('div', { class: 'nx-dev-ops' },
          d.locked
            ? el('button', {
                class: 'btn small primary', text: 'Unlock',
                onclick: async () => { try { await api.invoke('nx:adminUnlock', { uuid: d.uuid }); toast('Unlocked', d.playerName || d.deviceName); load(); } catch (e) { toast('Unlock failed', e.message, { type: 'error' }); } },
              })
            : el('button', {
                class: 'btn small danger', text: 'Lock',
                onclick: () => lockForm(d, load),
              }),
          el('button', {
            class: `btn small ${d.blocked ? 'ghost' : 'danger'}`, text: d.blocked ? 'Unblock' : 'Block login',
            title: d.blocked ? 'Remove this account/device from the blocklist' : 'Refuse this Microsoft account (or this device) on EVERY device — forever',
            onclick: async () => {
              if (d.blocked) {
                try {
                  const list = await api.invoke('nx:blockList');
                  const hits = (list || []).filter((b) => (d.playerUuid && b.kind === 'msa-account' && (b.value === d.playerUuid || b.value === (d.playerName || '').toLowerCase())) || (b.kind === 'device' && b.value === d.uuid));
                  for (const h of hits) await api.invoke('nx:blockRemove', { id: h.id });
                  toast('Unblocked', d.playerName || d.deviceName); load();
                } catch (e) { toast('Unblock failed', e.message, { type: 'error' }); }
                return;
              }
              blockForm(d, load);
            },
          }),
        ),
      );
      wrap.append(row);
    }
  }
  await load();
}

/** v4: block an account (by Microsoft name/UUID) or a whole device. */
function blockForm(d, after) {
  const kind = el('select', { class: 'input' },
    el('option', { value: 'msa-account', text: `Microsoft account — ${d.playerName || 'unknown'} (works on every device)` }),
    el('option', { value: 'device', text: `This device only — ${d.deviceName || d.uuid.slice(0, 8)}` }),
  );
  const reason = el('input', { class: 'input', placeholder: 'Reason shown on their BLOCKED screen…', value: 'Blocked by the owner.' });
  openModal({
    title: `Block ${d.playerName || d.deviceName}`,
    sub: 'A blocked ACCOUNT cannot sign in to Neurax from ANY device, and is force-logged-out within 5 seconds on devices it is already signed into. A blocked DEVICE is locked out entirely. Only you can undo this.',
    body: el('div', {}, el('label', { class: 'label', text: 'What to block' }), kind, el('label', { class: 'label', style: { marginTop: '8px' }, text: 'Reason' }), reason),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn danger', text: 'BLOCK',
        onclick: async () => {
          try {
            if (kind.value === 'msa-account') {
              if (!d.playerUuid && !d.playerName) throw new Error('That device has no Microsoft account signed in — block the device instead.');
              await api.invoke('nx:blockAdd', { kind: 'msa-account', value: d.playerUuid || d.playerName, label: d.playerName, reason: reason.value });
            } else {
              await api.invoke('nx:blockAdd', { kind: 'device', value: d.uuid, label: d.deviceName || d.uuid.slice(0, 8), reason: reason.value });
            }
            toast('Blocked', (d.playerName || d.deviceName) + ' — enforced within 5 seconds on every device.');
            close(); after && after();
          } catch (e) { toast('Block failed', e.message, { type: 'error' }); }
        },
      }),
    ],
  });
}

/** v4: the blocklist manager — see + remove every block. */
async function openBlocklist() {
  const wrap = el('div', { class: 'nx-dev-wrap' });
  const addName = el('input', { class: 'input', placeholder: 'Microsoft player name or UUID…' });
  const addReason = el('input', { class: 'input', placeholder: 'Reason (shown on their screen)', style: { maxWidth: '220px' } });
  const m = openModal({
    title: 'Account & device blocklist',
    sub: 'Blocked accounts cannot log in on ANY device; blocked devices are locked out. Blocks are enforced within 5 seconds.',
    body: wrap,
  });
  async function load() {
    let rows = [];
    try { rows = await api.invoke('nx:blockList'); } catch (e) { wrap.innerHTML = ''; wrap.append(el('div', { class: 'hint', text: 'Needs the Supabase connection: ' + e.message })); return; }
    wrap.innerHTML = '';
    wrap.append(el('div', { class: 'nx-friend-addrow' },
      addName, addReason,
      el('button', {
        class: 'btn primary small', text: 'Block account',
        onclick: async () => {
          const v = addName.value.trim(); if (!v) return;
          try { await api.invoke('nx:blockAdd', { kind: 'msa-account', value: v, reason: addReason.value }); addName.value = ''; toast('Blocked', v); await load(); }
          catch (e) { toast('Block failed', e.message, { type: 'error' }); }
        },
      }),
    ));
    if (!rows.length) wrap.append(el('div', { class: 'nx-chat-empty', text: 'Nobody is blocked.' }));
    for (const b of rows) {
      wrap.append(el('div', { class: 'nx-dev-row' },
        el('span', { class: `nx-flag ${b.kind === 'device' ? 'off' : 'lock'}`, text: b.kind === 'device' ? 'DEVICE' : 'ACCOUNT' }),
        el('div', { class: 'nx-dev-info' },
          el('b', { text: b.label || b.value }),
          el('span', { class: 'nx-dev-uuid', text: b.value }),
          b.reason ? el('span', { text: b.reason }) : null,
        ),
        el('div', { class: 'nx-dev-ops' },
          el('button', {
            class: 'btn small ghost', text: 'Remove',
            onclick: async () => { try { await api.invoke('nx:blockRemove', { id: b.id }); toast('Block removed', b.label || b.value); await load(); } catch (e) { toast('Failed', e.message, { type: 'error' }); } },
          }),
        ),
      ));
    }
  }
  await load();
}

function lockForm(d, after) {
  const reason = el('input', { class: 'input', placeholder: 'Reason shown on the LOCKED screen…', value: 'Locked by the administrator.' });
  const minutes = el('input', { class: 'input', type: 'number', min: '0', placeholder: '0 = until you unlock manually' });
  openModal({
    title: `Lock ${d.playerName || d.deviceName}`,
    sub: 'Their game quits instantly, the launcher shows LAUNCHER LOCKED, and nothing can be used until you unlock — or the timer runs out.',
    body: el('div', {}, el('label', { class: 'label', text: 'Reason' }), reason, el('label', { class: 'label', style: { marginTop: '8px' }, text: 'Unlock timer (minutes)' }), minutes),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn danger', text: 'LOCK DEVICE',
        onclick: async () => {
          try {
            await api.invoke('nx:adminLock', { uuid: d.uuid, reason: reason.value, minutes: Number(minutes.value) || 0 });
            toast('Device locked', (d.playerName || d.deviceName) + (Number(minutes.value) ? ` — auto-unlocks in ${minutes.value} min` : ''));
            close(); after && after();
          } catch (e) { toast('Lock failed', e.message, { type: 'error' }); }
        },
      }),
    ],
  });
}

/* =================================================================
   chat popup
================================================================= */
let chatState = { chats: [], active: null, messages: [] };
let chatPopup = null;
const inlineMedia = new Map(); // fileId -> dataURL (small images shown inline)
const INLINE_MEDIA_MAX = 30;  // v4: bounded — inline images are the largest renderer memory sink
function inlineMediaRemember(fileId, url) {
  if (inlineMedia.size >= INLINE_MEDIA_MAX) {
    const oldest = inlineMedia.keys().next().value;
    try { URL.revokeObjectURL?.(inlineMedia.get(oldest)); } catch {}
    inlineMedia.delete(oldest); // FIFO evict — a long chat session can never balloon RAM
  }
  inlineMedia.set(fileId, url);
}

function fileChip(msg) {
  const kindIcon = msg.type === 'video' ? '🎬' : '📎';
  return el('div', { class: `nx-file-chip ${msg.type}`, onclick: () => downloadChatFile(msg) },
    el('span', { class: 'nx-file-ico', text: kindIcon }),
    el('span', { class: 'nx-file-meta' },
      el('b', { text: msg.fileName || 'file' }),
      el('span', { text: fmtBytes(msg.fileSize) }),
    ),
    el('span', { class: 'nx-file-dl', text: 'SAVE' }),
  );
}

async function downloadChatFile(msg) {
  try {
    toast('Downloading…', msg.fileName || 'file');
    const dest = await api.invoke('nx:downloadFile', { fileId: msg.fileId, fileName: msg.fileName });
    toast('Saved', dest);
  } catch (e) { toast('Download failed', e.message, { type: 'error' }); }
}

async function inlineImage(msg, bubble) {
  let url = inlineMedia.get(msg.fileId);
  if (!url) {
    try {
      const r = await api.invoke('nx:fileDataUrl', { fileId: msg.fileId, fileName: msg.fileName });
      if (!r || !r.url) return;
      if ((r.size || 0) > 25 * 1024 * 1024) { bubble.append(fileChip(msg)); return; }
      url = r.url; inlineMediaRemember(msg.fileId, url);
    } catch { bubble.append(el('div', { class: 'hint', text: 'Image unavailable — tap the file chip to save it.' })); bubble.append(fileChip(msg)); return; }
  }
  bubble.append(el('img', {
    class: 'nx-chat-img', src: url, alt: msg.fileName || 'image', loading: 'lazy',
    onclick: () => downloadChatFile(msg),
  }));
}

function renderMessages(container) {
  container.innerHTML = '';
  if (!chatState.messages.length) {
    container.append(el('div', { class: 'nx-chat-empty', text: 'No messages yet — say hi!' }));
  }
  const myUuid = nx.identity?.uuid;
  for (const m of chatState.messages) {
    const mine = m.from && myUuid && String(m.from).toLowerCase() === String(myUuid).toLowerCase();
    const row = el('div', { class: `nx-msg ${mine ? 'mine' : ''}`, dataset: { mid: String(m.id) } });
    if (!mine) {
      // just the player head + username (no full skin anywhere)
      row.append(headImg(m.from, m.fromName));
    }
    const bubble = el('div', { class: 'nx-msg-bubble' },
      mine ? null : el('div', { class: 'nx-msg-name', text: m.fromName || 'Player' }),
    );
    if (m.deleted) {
      bubble.append(el('div', { class: 'nx-msg-text deleted', text: 'This message was deleted' }));
    } else if (m.type === 'image' && m.fileId) {
      inlineImage(m, bubble);
      if (m.text) bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    } else if (m.type === 'video' || m.type === 'file') {
      bubble.append(fileChip(m));
      if (m.text) bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    } else {
      bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    }
    bubble.append(el('div', { class: 'nx-msg-time' },
      (m.deleted ? '' : timeAgo(m.at)),
      m.editedAt && !m.deleted ? ' · edited' : '',
    ));
    // v4: hover actions — edit / delete for me / delete for everyone (own msgs)
    if (mine && !m.deleted) {
      row.append(el('div', { class: 'nx-msg-ops' },
        m.type === 'text' ? el('button', { class: 'nx-op', title: 'Edit message', text: '✏', onclick: () => editMessage(m) }) : null,
        el('button', { class: 'nx-op', title: 'Delete for me', text: '👁', onclick: () => deleteMessage(m, 'me') }),
        el('button', { class: 'nx-op danger', title: 'Delete for everyone', text: '🗑', onclick: () => deleteMessage(m, 'everyone') }),
      ));
    } else if (!mine && !m.deleted) {
      row.append(el('div', { class: 'nx-msg-ops' },
        el('button', { class: 'nx-op', title: 'Delete for me', text: '👁', onclick: () => deleteMessage(m, 'me') }),
      ));
    }
    row.append(bubble);
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
}

async function editMessage(m) {
  const input = el('textarea', { class: 'input', rows: '3', style: { resize: 'vertical' } });
  input.value = m.text || '';
  openModal({
    title: 'Edit message',
    body: el('div', {}, input),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn primary', text: 'Save',
        onclick: async () => {
          try {
            await api.invoke('nx:msgEdit', { id: m.id, text: input.value });
            close();
            await reloadActiveMessages();
          } catch (e) { toast('Edit failed', e.message, { type: 'error' }); }
        },
      }),
    ],
  });
  setTimeout(() => input.focus(), 50);
}

async function deleteMessage(m, scope) {
  const yes = await confirmModal({
    title: scope === 'everyone' ? 'Delete for everyone?' : 'Delete for me?',
    message: scope === 'everyone'
      ? 'Your message will be removed for ALL members. Everyone sees "This message was deleted".'
      : 'The message disappears only on this device — everyone else still sees it.',
    confirmLabel: scope === 'everyone' ? 'Delete for everyone' : 'Delete for me',
    danger: scope === 'everyone',
  });
  if (!yes) return;
  try {
    await api.invoke(scope === 'everyone' ? 'nx:msgDeleteForEveryone' : 'nx:msgDeleteForMe', { id: m.id });
    await reloadActiveMessages();
  } catch (e) { toast('Delete failed', e.message, { type: 'error' }); }
}

async function reloadActiveMessages() {
  if (!chatState.active) return;
  try {
    const r = await api.invoke('nx:chatMessages', { chatId: chatState.active.id });
    chatState.messages = r.messages || [];
    renderMessages($('#nx-chat-messages'));
  } catch {}
}

async function refreshChats(listEl) {
  try {
    const r = await api.invoke('nx:chatList');
    chatState.chats = r.chats || [];
    renderChatList(listEl);
    updateOfflineBar();
  } catch (e) {
    renderChatList(listEl);
    updateOfflineBar();
  }
}

function renderChatList(listEl) {
  listEl.innerHTML = '';
  const groups = chatState.chats.filter((c) => c.kind !== 'dm');
  const dms = chatState.chats.filter((c) => c.kind === 'dm');
  if (!chatState.chats.length) {
    listEl.append(el('div', { class: 'nx-chat-empty', text: nx.presence.connected ? 'No chats yet — add a friend or create a group!' : 'NX Cloud offline — cached chats shown.' }));
    return;
  }
  const rowFor = (c) => {
    const active = chatState.active?.id === c.id;
    const friend = c.kind === 'dm' ? (c.members || []).find((m) => String(m.uuid).toLowerCase() !== String(nx.identity?.uuid || '').toLowerCase()) : null;
    const title = c.kind === 'dm' ? (friend ? friend.name : c.name) : c.name;
    const names = (c.members || []).slice(0, 3).map((x) => x.name).join(', ');
    const r = el('div', { class: `nx-chat-row ${active ? 'active' : ''} ${c.kind === 'dm' ? 'dm' : ''}`, onclick: () => selectChat(c, listEl) },
      c.kind === 'dm' && friend ? headImg(friend.uuid, friend.name, 'nx-row-head') : null,
      el('div', { class: 'nx-row-txt' },
        el('b', { text: (c.starred ? '★ ' : '') + title }),
        el('span', { text: c.kind === 'dm' ? (friend?.online ? 'online' : 'Direct message') : `${c.memberCount || (c.members || []).length} member${(c.memberCount || (c.members || []).length) === 1 ? '' : 's'}${names ? ' — ' + names : ''}` }),
      ),
      c.kind === 'dm' && friend ? el('span', { class: `nx-presence-dot ${friend.online ? 'on' : ''}` }) : null,
    );
    return r;
  };
  if (groups.length) {
    listEl.append(el('div', { class: 'nx-list-label', text: 'GROUPS' }));
    for (const c of [...groups].sort((a, b) => (b.starred - a.starred))) listEl.append(rowFor(c));
  }
  if (dms.length) {
    listEl.append(el('div', { class: 'nx-list-label', text: 'DIRECT MESSAGES' }));
    for (const c of [...dms].sort((a, b) => (b.starred - a.starred))) listEl.append(rowFor(c));
  }
}

async function selectChat(chat, listEl) {
  chatState.active = chat;
  renderChatList(listEl);
  chatState._headerButtons?.(); // v4: rebuild header ops for the newly selected chat
  chatState.messages = [];
  const msgsEl = $('#nx-chat-messages');
  if (msgsEl) renderMessages(msgsEl);
  try {
    const r = await api.invoke('nx:chatMessages', { chatId: chat.id });
    chatState.messages = r.messages || [];
    if (msgsEl) renderMessages(msgsEl);
  } catch (e) {
    if (nx.presence.connected) toast('Could not load messages', e.message, { type: 'warn' });
  }
}

async function sendMessage(textInput, msgsEl) {
  const text = textInput.value.trim();
  if (!text || !chatState.active) return;
  textInput.value = '';
  try {
    await api.invoke('nx:chatSend', { chatId: chatState.active.id, text });
    const r = await api.invoke('nx:chatMessages', { chatId: chatState.active.id });
    chatState.messages = r.messages || [];
    renderMessages(msgsEl);
  } catch (e) {
    renderMessages(msgsEl); // keep the UI alive in offline mode
    toast('Message queued', e.message, { type: 'warn' });
  }
}

async function sendFile(msgsEl) {
  if (!chatState.active) return;
  const path = await api.invoke('dialog:openFile', { title: 'Send a file (up to 100MB)' });
  if (!path) return;
  toast('Uploading…', path.split(/[\\/]/).pop());
  try {
    await api.invoke('nx:chatSendFile', { chatId: chatState.active.id, filePath: path });
    const r = await api.invoke('nx:chatMessages', { chatId: chatState.active.id });
    chatState.messages = r.messages || [];
    renderMessages(msgsEl);
    toast('Sent!');
  } catch (e) { toast('Upload failed', e.message, { type: 'error' }); }
}

async function createChat(listEl) {
  openModal({
    title: 'New group chat',
    sub: 'After creating it, press INVITE to add friends by UUID or Microsoft player name.',
    body: (() => { const i = el('input', { class: 'input', placeholder: 'Group name…', maxlength: '60' }); i.dataset.role = 'groupname'; return i; })(),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn primary', text: 'Create',
        onclick: async (e) => {
          const name = e.target.closest('.modal').querySelector('input').value.trim();
          if (!name) return;
          try {
            const r = await api.invoke('nx:chatCreate', { name });
            close();
            toast('Chat created', 'Now press INVITE to add friends.');
            await refreshChats(listEl);
            const fresh = chatState.chats.find((c) => c.id === r.chatId);
            if (fresh) selectChat(fresh, listEl);
          } catch (err) { toast('Create failed', err.message, { type: 'error' }); }
        },
      }),
    ],
  });
}

/* ---- FRIENDS — add / star / delete / one-click DM (no group needed) ---- */
async function openFriends(listEl) {
  const wrap = el('div', { class: 'nx-friends-wrap' });
  const input = el('input', { class: 'input', placeholder: "Friend's NX UUID or exact Microsoft player name…" });
  const add = async () => {
    const ref = input.value.trim();
    if (!ref) return;
    try {
      const r = await api.invoke('nx:friendAdd', { ref });
      input.value = '';
      if (r.already) toast('Already friends', r.name);
      else if (r.accepted) toast('You are friends', `${r.name} had already sent you a request — accepted automatically.`);
      else toast('Request sent', `${r.name} will be notified and can accept or reject.`);
      await load();
    } catch (e) { toast('Add failed', e.message, { type: 'error' }); }
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') add(); });
  const m = openModal({
    title: 'Friends',
    sub: 'Send a request to any Microsoft player — they accept or reject it. Star your best friends, jump into a 1:1 DM with one click — no group needed.',
    body: wrap,
    onClose: () => clearInterval(tick),
  });
  async function load() {
    // pending friend requests first — they need a yes/no
    let pending = { friendRequests: [], chatInvites: [] };
    try { pending = ((await api.invoke('nx:invitesList')) || {}).pending || pending; } catch {}
    let friends = [];
    try { friends = (await api.invoke('nx:friendsList')).friends || []; } catch (e) { wrap.innerHTML = ''; wrap.append(el('div', { class: 'hint', text: 'Needs the Supabase connection: ' + e.message })); return; }
    wrap.innerHTML = '';
    wrap.append(el('div', { class: 'nx-friend-addrow' }, input, el('button', { class: 'btn primary small', text: 'Send request', onclick: add })));
    const hasPending = (pending.friendRequests || []).length + (pending.chatInvites || []).length;
    if (hasPending) {
      wrap.append(el('div', { class: 'nx-list-label', text: 'PENDING INVITATIONS', style: { marginTop: '10px' } }));
      for (const r of pending.friendRequests || []) {
        wrap.append(el('div', { class: 'nx-friend-row' },
          headImg(r.uuid, r.name, 'nx-row-head'),
          el('div', { class: 'nx-row-txt' }, el('b', { text: r.name }), el('span', { text: 'wants to be your friend' })),
          el('div', { class: 'nx-friend-ops' },
            el('button', { class: 'btn small primary', text: 'Accept', onclick: () => respondInvite('friend', r.id, true, load) }),
            el('button', { class: 'btn small danger ghost', text: 'Reject', onclick: () => respondInvite('friend', r.id, false, load) }),
          ),
        ));
      }
      for (const r of pending.chatInvites || []) {
        wrap.append(el('div', { class: 'nx-friend-row' },
          headImg(r.uuid, r.name, 'nx-row-head'),
          el('div', { class: 'nx-row-txt' }, el('b', { text: r.groupName }), el('span', { text: `${r.name} invited you to the group` })),
          el('div', { class: 'nx-friend-ops' },
            el('button', { class: 'btn small primary', text: 'Accept', onclick: () => respondInvite('chat', r.id, true, load) }),
            el('button', { class: 'btn small danger ghost', text: 'Reject', onclick: () => respondInvite('chat', r.id, false, load) }),
          ),
        ));
      }
    }
    if (!friends.length && !hasPending) wrap.append(el('div', { class: 'nx-chat-empty', text: 'No friends yet — send a request by Microsoft player name. They accept, you are friends.' }));
    for (const f of [...friends].sort((a, b) => (b.starred - a.starred) || a.name.localeCompare(b.name))) {
      wrap.append(el('div', { class: 'nx-friend-row' },
        headImg(f.uuid, f.name, 'nx-row-head'),
        el('div', { class: 'nx-row-txt' },
          el('b', { text: f.name }),
          el('span', { text: f.online ? 'online' : ('last seen ' + timeAgo(f.lastSeen)) }),
        ),
        el('span', { class: `nx-presence-dot ${f.online ? 'on' : ''}` }),
        el('div', { class: 'nx-friend-ops' },
          el('button', {
            class: `btn small ghost ${f.starred ? 'starred' : ''}`, title: f.starred ? 'Unstar' : 'Star',
            text: f.starred ? '★' : '☆',
            onclick: async () => { try { await api.invoke('nx:friendStar', { uuid: f.uuid, starred: !f.starred }); await load(); } catch (e) { toast('Failed', e.message, { type: 'error' }); } },
          }),
          el('button', {
            class: 'btn small primary', text: 'Message',
            onclick: async () => {
              try {
                const r = await api.invoke('nx:chatDM', { ref: f.uuid || f.name });
                m.close?.();
                await refreshChats(listEl);
                if (chatPopup) { const fresh = chatState.chats.find((c) => c.id === r.chatId); if (fresh) selectChat(fresh, listEl); }
                else { openChatPopup(); const fresh = chatState.chats.find((c) => c.id === r.chatId); if (fresh) selectChat(fresh, $('#nx-chat-list')); }
                toast('DM opened', r.name);
              } catch (e) { toast('DM failed', e.message, { type: 'error' }); }
            },
          }),
          el('button', {
            class: 'btn small danger ghost', text: 'Delete',
            onclick: async () => {
              const yes = await confirmModal({ title: `Remove ${f.name}?`, message: 'They disappear from YOUR friends list. Chats you already share stay untouched.', confirmLabel: 'Remove' });
              if (!yes) return;
              try { await api.invoke('nx:friendRemove', { uuid: f.uuid }); toast('Friend removed', f.name); await load(); } catch (e) { toast('Failed', e.message, { type: 'error' }); }
            },
          }),
        ),
      ));
    }
  }
  const tick = setInterval(load, 10000); // keep online dots fresh
  await load();
}

/* ---- group management: members/roles, rename, delete ---- */
function openChatSettings(listEl) {
  const c = chatState.active;
  if (!c) return;
  const myRole = c.myRole || 'member';
  const isOwner = myRole === 'owner';
  const canManage = isOwner || myRole === 'admin';
  const wrap = el('div', { class: 'nx-friends-wrap' });
  const nameInput = el('input', { class: 'input', value: c.name, maxlength: '60', disabled: canManage ? null : '' });
  openModal({
    title: `“${c.name}” settings`,
    sub: isOwner ? 'You are the OWNER — rename, add admins, kick members or delete the group.' : canManage ? 'You are an ADMIN — rename and kick members.' : 'Members view.',
    body: el('div', {},
      el('label', { class: 'label', text: 'Group name' }), nameInput,
      el('div', { class: 'nx-friend-addrow', style: { marginTop: '10px' } },
        el('button', { class: 'btn small primary', text: 'Save name', onclick: async () => { try { await api.invoke('nx:chatRename', { chatId: c.id, name: nameInput.value }); toast('Renamed', nameInput.value); await refreshChats(listEl); c.name = nameInput.value.trim() || c.name; } catch (e) { toast('Rename failed', e.message, { type: 'error' }); } } }),
      ),
      el('div', { class: 'nx-list-label', text: 'MEMBERS & ROLES', style: { marginTop: '14px' } }),
      wrap,
    ),
  });
  const renderMembers = () => {
    wrap.innerHTML = '';
    for (const mem of c.members || []) {
      const isMemOwner = mem.role === 'owner';
      wrap.append(el('div', { class: 'nx-friend-row' },
        headImg(mem.uuid, mem.name, 'nx-row-head'),
        el('div', { class: 'nx-row-txt' },
          el('b', { text: mem.name }),
          el('span', { text: `${isMemOwner ? 'owner' : (mem.role || 'member')}${mem.online ? ' · online' : ''} · ${(mem.uuid || '').slice(0, 8)}…` }),
        ),
        el('div', { class: 'nx-friend-ops' },
          isOwner && !isMemOwner ? el('button', {
            class: 'btn small ghost', text: mem.role === 'admin' ? 'Demote' : 'Make admin',
            onclick: async () => { try { await api.invoke('nx:chatSetRole', { chatId: c.id, memberUuid: mem.uuid, role: mem.role === 'admin' ? 'member' : 'admin' }); toast('Role updated', mem.name); renderMembers(); refreshChats(listEl); } catch (e) { toast('Failed', e.message, { type: 'error' }); } },
          }) : null,
          isOwner && !isMemOwner || (myRole === 'admin' && !isMemOwner && mem.role !== 'admin') ? el('button', {
            class: 'btn small danger ghost', text: 'Kick',
            onclick: async () => {
              const yes = await confirmModal({ title: `Kick ${mem.name}?`, message: 'They lose access to this chat immediately.', confirmLabel: 'Kick' });
              if (!yes) return;
              try { await api.invoke('nx:chatKick', { chatId: c.id, memberUuid: mem.uuid }); toast('Kicked', mem.name); renderMembers(); refreshChats(listEl); } catch (e) { toast('Kick failed', e.message, { type: 'error' }); }
            },
          }) : null,
        ),
      ));
    }
  };
  renderMembers();
}

async function deleteChat(listEl) {
  const c = chatState.active;
  if (!c) return;
  const yes = await confirmModal({ title: `Delete “${c.name}”?`, message: 'The chat, its members and ALL of its messages are removed for EVERYONE. This cannot be undone.', confirmLabel: 'Delete forever', danger: true });
  if (!yes) return;
  try {
    await api.invoke('nx:chatDelete', { chatId: c.id });
    chatState.active = null;
    await refreshChats(listEl);
    renderMessages($('#nx-chat-messages'));
    toast('Chat deleted', c.name);
  } catch (e) { toast('Delete failed', e.message, { type: 'error' }); }
}

/* ---- THE INVITE FEATURE — proper UI, Microsoft players only ---- */
function inviteToChat(listEl) {
  if (!chatState.active) { toast('Pick a chat first', 'Select or create a group chat.'); return; }
  const input = el('input', { class: 'input', placeholder: "Friend's NX UUID or exact Microsoft player name…" });
  const err = el('div', { class: 'hint', style: { color: 'var(--danger)', minHeight: '16px', marginTop: '6px' } });
  const result = el('div', { style: { marginTop: '4px' } });
  openModal({
    title: `Invite to "${chatState.active.name}"`,
    sub: 'Enter their NX device UUID (from their Settings → NX Cloud) or their exact Microsoft player name. They get an invitation they can ACCEPT or REJECT — nothing happens without their yes. Offline players must sign in once with Microsoft.',
    body: el('div', {}, input, err, result),
    actions: (close) => [
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn primary', text: 'Invite',
        onclick: async () => {
          err.textContent = ''; result.innerHTML = '';
          const ref = input.value.trim();
          if (!ref) { err.textContent = 'Enter a UUID or a player name.'; return; }
          try {
            const r = await api.invoke('nx:chatInvite', { chatId: chatState.active.id, ref });
            result.append(el('div', { class: 'nx-invite-ok' },
              headImg(r.uuid, r.name, 'nx-invite-head'),
              el('div', {}, el('b', { text: r.name }), el('div', { class: 'hint', text: 'Invitation sent — they will be notified within 5 seconds and can accept or reject it.' })),
            ));
            input.value = '';
            await refreshChats(listEl);
            toast('Invitation sent', r.name);
          } catch (e) { err.textContent = e.message; }
        },
      }),
    ],
  });
  setTimeout(() => input.focus(), 50);
}

/* ================================================================= v1.0
   INVITATIONS CENTER — every incoming friend request and group invite in one
   place, each with ACCEPT / REJECT. Live toasts fire the moment something
   arrives; outcome toasts fire when YOUR requests are answered. */
async function respondInvite(kind, id, accept, after) {
  try {
    if (kind === 'friend') await api.invoke('nx:friendRespond', { id, accept });
    else await api.invoke('nx:inviteRespond', { id, accept });
    toast(accept ? 'Accepted' : 'Rejected', accept
      ? (kind === 'friend' ? 'You are friends now.' : 'You joined the chat.')
      : 'The invitation was declined.');
    after && after();
  } catch (e) { toast('Failed', e.message, { type: 'error' }); }
}

function pendingCount() {
  return (nx.pending.friendRequests || []).length + (nx.pending.chatInvites || []).length;
}

function openInvitations(after) {
  const wrap = el('div', { class: 'nx-friends-wrap' });
  const render = () => {
    wrap.innerHTML = '';
    const fr = nx.pending.friendRequests || [];
    const ci = nx.pending.chatInvites || [];
    if (!fr.length && !ci.length) {
      wrap.append(el('div', { class: 'nx-chat-empty', text: 'No pending invitations — you are all caught up.' }));
      return;
    }
    if (fr.length) {
      wrap.append(el('div', { class: 'nx-list-label', text: 'FRIEND REQUESTS' }));
      for (const r of fr) {
        wrap.append(el('div', { class: 'nx-friend-row' },
          headImg(r.uuid, r.name, 'nx-row-head'),
          el('div', { class: 'nx-row-txt' },
            el('b', { text: r.name }),
            el('span', { text: r.online ? 'online · wants to be your friend' : `wants to be your friend · ${timeAgo(r.at)}` })),
          el('span', { class: `nx-presence-dot ${r.online ? 'on' : ''}` }),
          el('div', { class: 'nx-friend-ops' },
            el('button', { class: 'btn small primary', text: 'Accept', onclick: () => respondInvite('friend', r.id, true, render) }),
            el('button', { class: 'btn small danger ghost', text: 'Reject', onclick: () => respondInvite('friend', r.id, false, render) }),
          ),
        ));
      }
    }
    if (ci.length) {
      wrap.append(el('div', { class: 'nx-list-label', text: 'GROUP INVITES', style: { marginTop: fr.length ? '14px' : '0' } }));
      for (const r of ci) {
        wrap.append(el('div', { class: 'nx-friend-row' },
          headImg(r.uuid, r.name, 'nx-row-head'),
          el('div', { class: 'nx-row-txt' },
            el('b', { text: r.groupName }),
            el('span', { text: `${r.name} invited you · ${timeAgo(r.at)}` })),
          el('div', { class: 'nx-friend-ops' },
            el('button', { class: 'btn small primary', text: 'Accept', onclick: () => respondInvite('chat', r.id, true, render) }),
            el('button', { class: 'btn small danger ghost', text: 'Reject', onclick: () => respondInvite('chat', r.id, false, render) }),
          ),
        ));
      }
    }
  };
  render();
  const m = openModal({
    title: 'Invitations',
    sub: 'Friend requests and group invites arrive here. Nothing joins without your yes.',
    body: wrap,
    onClose: after,
  });
  return m;
}

async function leaveChat(listEl) {
  if (!chatState.active) return;
  const yes = await confirmModal({ title: 'Leave chat', message: `Leave "${chatState.active.name}"? You will stop receiving its messages.`, confirmLabel: 'Leave', danger: false });
  if (!yes) return;
  try {
    await api.invoke('nx:chatLeave', { chatId: chatState.active.id });
    chatState.active = null;
    await refreshChats(listEl);
    renderMessages($('#nx-chat-messages'));
  } catch (e) { toast('Leave failed', e.message, { type: 'error' }); }
}

/* ---- offline banner (grace mode) ---- */
let offlineBar = null;
function updateOfflineBar() {
  if (!chatPopup) return;
  const bar = chatPopup.querySelector('.nx-offline-bar');
  const need = !nx.presence.connected;
  if (need && !bar) {
    const b = el('div', { class: 'nx-offline-bar' },
      el('span', { text: '● NX Cloud is offline — showing cached chats. Messages you send are queued and go out automatically.' }),
      el('button', {
        class: 'btn small', text: 'Retry now', style: { marginLeft: 'auto' },
        onclick: async () => {
          try { const r = await api.invoke('nx:flushQueue'); toast(r.sent ? 'Queue flushed' : 'Still offline', r.sent ? `${r.sent} queued message(s) delivered.` : 'The cloud is not reachable yet.'); }
          catch (e) { toast('Still offline', e.message, { type: 'warn' }); }
          updateOfflineBar();
        },
      }),
    );
    chatPopup.querySelector('.nx-chat-popup').prepend(b);
    offlineBar = b;
  } else if (!need && bar) {
    bar.remove(); offlineBar = null;
    refreshChats($('#nx-chat-list'));
  }
}

function openChatPopup() {
  if (chatPopup) { chatPopup.remove(); chatPopup = null; }
  const listEl = el('div', { class: 'nx-chat-list', id: 'nx-chat-list' });
  const msgsEl = el('div', { class: 'nx-chat-messages', id: 'nx-chat-messages' });
  const input = el('input', { class: 'nx-chat-input', placeholder: 'Type a message…', maxlength: '4000' });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendMessage(input, msgsEl); });

  const sub = el('span', { class: 'nx-chat-sub' });
  const ops = el('div', { class: 'nx-chat-head-ops' });
  const voiceBar = el('div', { class: 'nx-voice-bar', hidden: true });
  const popup = el('div', { class: 'nx-chat-backdrop' },
    el('div', { class: 'nx-chat-popup' },
      el('header', { class: 'nx-chat-head' },
        el('div', {},
          el('h2', { text: 'NX Chat' }),
          sub,
        ),
        el('span', { style: { flex: '1' } }),
        ops,
        el('button', { class: 'btn ghost', text: 'Close', onclick: closeChatPopup }),
      ),
      voiceBar,
      el('div', { class: 'nx-chat-body' },
        el('aside', {},
          el('div', { class: 'nx-chat-ops' },
            el('button', { class: 'btn primary small', text: 'Friends', title: 'Add / star / DM friends — no group needed', onclick: () => openFriends(listEl) }),
            el('button', { class: 'btn ghost small', text: '+ Group', onclick: () => createChat(listEl) }),
            el('button', { class: 'btn ghost small', text: 'Invite', title: 'Invite by UUID or Microsoft player name — they accept or reject', onclick: () => inviteToChat(listEl) }),
            el('button', { class: `btn ghost small invite-btn ${pendingCount() ? 'has-badge' : ''}`, title: 'Friend requests & group invites — accept or reject', onclick: () => openInvitations() }, 'Invitations', pendingCount() ? el('span', { class: 'nx-invite-badge', text: String(pendingCount()) }) : null),
            el('button', { class: 'btn ghost small', text: 'Leave', onclick: () => leaveChat(listEl) }),
          ),
          listEl,
        ),
        el('main', {},
          msgsEl,
          el('footer', { class: 'nx-chat-foot' },
            el('button', { class: 'btn ghost', title: 'Send image / video / file (≤100MB)', text: '📎', onclick: () => sendFile(msgsEl) }),
            input,
            el('button', { class: 'btn primary', text: 'Send', onclick: () => sendMessage(input, msgsEl) }),
          ),
        ),
      ),
    ),
  );
  popup.addEventListener('click', (e) => { if (e.target === popup) closeChatPopup(); });
  document.body.append(popup);
  chatPopup = popup;

  const headerButtons = () => {
    const c = chatState.active;
    ops.innerHTML = '';
    if (!c) { sub.textContent = 'Group chats, DMs and voice with launcher friends'; return; }
    sub.textContent = c.kind === 'dm' ? 'Direct message' : `${c.memberCount || (c.members || []).length} members · you are ${c.myRole || 'member'}`;
    ops.append(el('button', {
      class: `btn small ${voiceCtl.state.roomId ? 'danger' : 'primary'}`, text: voiceCtl.state.roomId ? 'Leave voice' : '🎤 Voice',
      title: voiceCtl.state.roomId ? 'Leave the voice call' : 'Join (or start) the voice call for this chat',
      onclick: () => (voiceCtl.state.roomId ? voiceCtl.leave() : joinVoice(c)),
    }));
    ops.append(el('button', { class: 'btn small ghost', title: c.starred ? 'Unstar this chat' : 'Star this chat', text: c.starred ? '★' : '☆', onclick: async () => { try { await api.invoke('nx:chatStar', { chatId: c.id, starred: !c.starred }); await refreshChats(listEl); headerButtons(); } catch {} } }));
    if (c.kind !== 'dm') ops.append(el('button', { class: 'btn small ghost', text: 'Settings', title: 'Members, roles, rename', onclick: () => openChatSettings(listEl) }));
    if ((c.myRole === 'owner')) ops.append(el('button', { class: 'btn small danger ghost', text: 'Delete', title: 'Delete this chat for everyone', onclick: () => deleteChat(listEl) }));
  };
  chatState._headerButtons = headerButtons;
  headerButtons();
  refreshChats(listEl);
  if (chatState.active) {
    const fresh = chatState.chats.find((c) => c.id === chatState.active.id);
    selectChat(fresh || chatState.active, listEl);
  }
  renderVoiceBar(voiceBar);
}
function closeChatPopup() { chatPopup?.remove(); chatPopup = null; offlineBar = null; }

/* =================================================================
   VOICE CALLS — real P2P audio (WebRTC) via the nx-voice module.
================================================================= */
async function joinVoice(chat) {
  if (!chat) return;
  try {
    toast('Voice', `Connecting to “${chat.kind === 'dm' ? chat.name : chat.name}”…`);
    await voiceCtl.join(chat);
    toast('Voice connected', 'You are live. Speak freely — P2P encrypted audio.');
  } catch (e) {
    if (/Permission denied|NotAllowedError/i.test(e.message || '')) toast('Microphone blocked', 'Allow microphone access for Neurax in Windows Settings → Privacy → Microphone.', { type: 'error', timeout: 7000 });
    else toast('Voice failed', e.message, { type: 'error' });
  }
  chatState._headerButtons?.();
}

/** The live voice strip inside the chat popup (also shows OTHER active calls). */
function renderVoiceBar(bar) {
  if (!bar || !chatPopup) return;
  bar.innerHTML = '';
  const st = voiceCtl.state;
  if (st.roomId) {
    bar.hidden = false;
    bar.classList.add('live');
    const peers = st.participants.filter((p) => String(p.uuid).toLowerCase() !== String(nx.identity?.uuid || '').toLowerCase());
    bar.append(el('span', { class: 'nx-voice-live' }, '● LIVE'));
    for (const p of peers) {
      bar.append(el('span', { class: `nx-voice-peer ${st.speaking?.has(p.uuid) ? 'speaking' : ''} ${p.muted ? 'muted' : ''}`, title: p.muted ? p.name + ' (muted)' : p.name },
        headImg(p.uuid, p.name, 'nx-voice-head'), el('span', { class: 'nx-voice-ring' }),
      ));
    }
    if (!peers.length) bar.append(el('span', { class: 'hint', text: 'You are alone in the call — waiting for others…' }));
    bar.append(el('span', { style: { flex: '1' } }));
    bar.append(el('button', { class: 'btn small ghost', text: st.muted ? '🔇 Muted' : '🎙 Mic on', onclick: () => { voiceCtl.toggleMute(); renderVoiceBar(bar); chatState._headerButtons?.(); } }));
    bar.append(el('button', { class: 'btn small danger', text: 'Leave', onclick: () => { voiceCtl.leave(); renderVoiceBar(bar); chatState._headerButtons?.(); } }));
  } else {
    // not in a call — show active calls in MY other chats as one-click join
    const rooms = voiceCtl.activeRooms || {};
    const mine = Object.values(rooms).filter((r) => r.chatId !== chatState.active?.id);
    if (!mine.length) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.classList.remove('live');
    for (const r of mine) {
      const c = chatState.chats.find((x) => x.id === r.chatId);
      bar.append(el('span', { class: 'nx-voice-hint' },
        `🎤 Voice call in “${c ? c.name : 'a chat'}” (${r.participants.length} in call) `,
        el('button', { class: 'btn small primary', text: 'Join', onclick: () => joinVoice(c || { id: r.chatId, name: 'chat' }) }),
      ));
    }
  }
}
voiceCtl.onChange = () => {
  renderVoiceBar(chatPopup?.querySelector('.nx-voice-bar'));
  chatState._headerButtons?.();
};

/* =================================================================
   lock screen (remote LOCK — enforced, no way around it in the UI)
================================================================= */
let lockOverlay = null;
let lockTick = null;

function buildLockOverlay(lock) {
  const padlock = `<svg class="nx-lock-icon" viewBox="0 0 24 24" width="86" height="86" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/>
    <path class="shackle" d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>
    <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/>
    <path d="M12 16.5v2"/>
  </svg>`;
  const blocked = !!lock.blocked;
  return el('div', { class: `nx-lock ${blocked ? 'blocked' : ''}`, id: 'nx-lock-overlay' },
    el('div', { class: 'nx-lock-scan' }),
    el('div', { class: 'nx-lock-card' },
      el('div', { class: 'nx-lock-iconwrap', html: padlock }),
      el('h1', { class: 'nx-lock-title', text: blocked ? 'ACCESS BLOCKED' : 'LAUNCHER LOCKED' }),
      el('p', { class: 'nx-lock-reason', text: lock.reason || 'Locked by the administrator.' }),
      el('div', { class: 'nx-lock-timer', text: '' }),
      el('div', { class: 'nx-lock-uuid' }, `Device: ${nx.identity?.uuid || '…'}`),
      el('p', { class: 'nx-lock-hint', text: blocked
        ? 'The owner has blocked this account/device from using Neurax Launcher. This applies on every device and cannot be appealed here.'
        : 'This device was locked remotely. Minecraft was closed. Only the administrator can unlock it' + (lock.until ? ', or wait for the timer.' : '.') }),
    ),
  );
}

function showLock(lock) {
  nx.locked = lock;
  if (lockOverlay) lockOverlay.remove();
  lockOverlay = buildLockOverlay(lock);
  document.body.append(lockOverlay);
  const t = lockOverlay.querySelector('.nx-lock-timer');
  clearInterval(lockTick);
  const tick = () => {
    if (!lockOverlay) { clearInterval(lockTick); return; }
    if (lock.until) {
      const left = lock.until - Date.now();
      if (left <= 0) { t.textContent = 'Unlocking…'; return; }
      const h = Math.floor(left / 3600e3), m = Math.floor((left % 3600e3) / 60e3), s = Math.floor((left % 60e3) / 1000);
      t.textContent = `Unlocks in ${h ? h + 'h ' : ''}${m}m ${String(s).padStart(2, '0')}s`;
    } else t.textContent = 'Locked until the administrator unlocks you';
  };
  tick();
  lockTick = setInterval(tick, 1000);
}
function hideLock() {
  nx.locked = null;
  lockOverlay?.remove();
  lockOverlay = null;
  clearInterval(lockTick);
}

/* =================================================================
   boot & wiring
================================================================= */
async function init() {
  try { nx.identity = await api.invoke('nx:identity'); } catch {}
  try {
    const s = await api.invoke('nx:status');
    nx.presence = { connected: s.connected, online: s.online, total: s.total };
    nx.announcements = s.announcements || [];
  } catch {}

  // navbar: chip + announcements button
  const nav = $('#navbar');
  const right = nav?.querySelector('.nav-right');
  if (nav) {
    const chipEl = buildChip();
    const annBtn = buildAnnouncementsButton();
    annBtn.addEventListener('click', () => { navigate('announcements', { force: true }); });
    if (right) { right.prepend(annBtn); right.prepend(chipEl); }
    else nav.append(chipEl, annBtn);
    updateChip();
    updateBadge();
  }

  // live events — the engine pushes every 5 seconds (Supabase mode)
  api.on('nx:presence', (p) => {
    Object.assign(nx.presence, p);
    updateChip();
    updateOfflineBar();
    // refresh cached chats when we come back online
    if (p.connected && chatPopup) refreshChats($('#nx-chat-list'));
  });
  api.on('nx:announcements', (p) => {
    const before = unseenCount();
    nx.announcements = p.announcements || [];
    updateBadge();
    if (unseenCount() > before && document.querySelector('[data-page="announcements"]')) {
      markAllSeen(); updateBadge();
    }
  });
  api.on('nx:lock', (p) => { p.locked ? showLock(p.locked) : hideLock(); });
  api.on('nx:chat', (m) => {
    if (m.event === 'message' && chatPopup) {
      if (chatState.active && m.message.chatId === chatState.active.id) {
        api.invoke('nx:chatMessages', { chatId: chatState.active.id })
          .then((r) => { chatState.messages = r.messages || []; renderMessages($('#nx-chat-messages')); })
          .catch(() => {});
      } else {
        // activity in another chat → refresh the sidebar
        refreshChats($('#nx-chat-list'));
      }
    } else if (m.event === 'new-chat' && chatPopup) {
      refreshChats($('#nx-chat-list'));
    }
  });
  // v4: live voice-room tracking (badges + one-click join bars)
  api.on('nx:voice', (p) => {
    voiceCtl.activeRooms = p.rooms || {};
    renderVoiceBar(chatPopup?.querySelector('.nx-voice-bar'));
  });

  // v1.0 — live invitations: friend requests + group invites (accept/reject)
  let lastInviteSig = '';
  api.on('nx:invites', (p) => {
    nx.pending = {
      friendRequests: p.friendRequests || [],
      chatInvites: p.chatInvites || [],
    };
    const sig = JSON.stringify([nx.pending.friendRequests, nx.pending.chatInvites]);
    if (sig !== lastInviteSig && lastInviteSig !== '') {
      const n = pendingCount();
      if (n > 0) toast('New invitation', `${n} pending invitation${n === 1 ? '' : 's'} — open NX Chat → Invitations to accept or reject.`, { timeout: 8000 });
    }
    lastInviteSig = sig;
    // refresh the invitations UI if it is open
    if (chatPopup) {
      const btn = chatPopup.querySelector('.invite-btn');
      if (btn) {
        const badge = btn.querySelector('.nx-invite-badge');
        if (pendingCount() && !badge) btn.append(el('span', { class: 'nx-invite-badge', text: String(pendingCount()) }));
        else if (!pendingCount() && badge) badge.remove();
        else if (badge) badge.textContent = String(pendingCount());
      }
    }
  });
  api.on('nx:inviteOutcome', (p) => {
    if (p.status === 'accepted') toast(p.kind === 'friend' ? 'Friend request accepted' : 'Invite accepted', `${p.name} said yes.`);
    else toast(p.kind === 'friend' ? 'Friend request rejected' : 'Invite rejected', `${p.name} declined.`, { type: 'warn' });
  });

  // v1.0 — prime the invitations cache at boot
  try {
    const inv = await api.invoke('nx:invitesList');
    if (inv && inv.pending) nx.pending = inv.pending;
  } catch {}

  // boot-time lock check (a locked device stays locked even after a restart)
  try {
    const l = await api.invoke('nx:lockState');
    if (l && l.locked !== false && l.reason) showLock(l);
  } catch {}

  // v4: prime the friends cache for the chip + voice rooms from status
  try {
    const s = await api.invoke('nx:status');
    if (s) { voiceCtl.activeRooms = s.voiceRooms || {}; }
  } catch {}
}

/* ---- page registration ---- */
registerPage('announcements', buildAnnouncements);

export const nxUI = { init, showLock, hideLock };
