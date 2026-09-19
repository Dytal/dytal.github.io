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
async function headFor(uuid, name) {
  const key = uuid || name || 'nx';
  if (headCache.has(key)) return headCache.get(key);
  let url = null;
  try { const r = await api.invoke('nx:skinHead', { uuid: uuid || '', name: name || '' }); url = r && r.url; } catch {}
  if (!url) return null;
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
  const prio = a.priority || 'info';
  const m = seenMap();
  const fresh = m[a.id] !== a.updatedAt;
  return el('article', { class: `nx-ann prio-${prio} ${fresh ? 'fresh' : ''}`, style: { '--nx-accent': color, '--nx-banner': banner } },
    el('div', { class: 'nx-ann-bar' }),
    el('div', { class: 'nx-ann-main' },
      el('header', {},
        el('h3', { text: a.title }),
        el('span', { class: 'nx-prio', text: PRIO_LABEL[prio] || prio }),
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

/* ---- announcement create/edit form (admin) ---- */
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
            style: { color: color.value, banner: banner.value },
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
   admin devices & locks (announcements → NX Admin → Devices & locks)
================================================================= */
async function openAdminDevices() {
  const wrap = el('div', { class: 'nx-dev-wrap' });
  const m = openModal({
    title: 'Devices & locks',
    sub: 'Every NX device, its Microsoft player and its lock state. Locking quits Minecraft on that device and shows the LOCKED screen. Only you can unlock.',
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
          el('span', { class: 'nx-dev-uuid', text: d.uuid }),
        ),
        el('div', { class: 'nx-dev-flags' },
          d.gameRunning ? el('span', { class: 'nx-flag run', text: 'IN GAME' }) : null,
          d.online ? el('span', { class: 'nx-flag on', text: 'ONLINE' }) : el('span', { class: 'nx-flag off', text: 'OFFLINE' }),
          d.locked ? el('span', { class: 'nx-flag lock', text: 'LOCKED' }) : null,
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
        ),
      );
      wrap.append(row);
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
      url = r.url; inlineMedia.set(msg.fileId, url);
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
    const row = el('div', { class: `nx-msg ${mine ? 'mine' : ''}` });
    if (!mine) {
      // just the player head + username (no full skin anywhere)
      row.append(headImg(m.from, m.fromName));
    }
    const bubble = el('div', { class: 'nx-msg-bubble' },
      mine ? null : el('div', { class: 'nx-msg-name', text: m.fromName || 'Player' }),
    );
    if (m.type === 'image' && m.fileId) {
      inlineImage(m, bubble);
      if (m.text) bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    } else if (m.type === 'video' || m.type === 'file') {
      bubble.append(fileChip(m));
      if (m.text) bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    } else {
      bubble.append(el('div', { class: 'nx-msg-text', text: m.text }));
    }
    bubble.append(el('div', { class: 'nx-msg-time', text: timeAgo(m.at) }));
    row.append(bubble);
    container.append(row);
  }
  container.scrollTop = container.scrollHeight;
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
  if (!chatState.chats.length) {
    listEl.append(el('div', { class: 'nx-chat-empty', text: nx.presence.connected ? 'No chats yet — create one!' : 'NX Cloud offline — cached chats shown.' }));
    if (!chatState.chats.length && nx.presence.connected) return;
  }
  for (const c of chatState.chats) {
    const active = chatState.active?.id === c.id;
    const names = (c.members || []).slice(0, 3).map((x) => x.name).join(', ');
    const row = el('div', { class: `nx-chat-row ${active ? 'active' : ''}`, onclick: () => selectChat(c, listEl) },
      el('b', { text: c.name }),
      el('span', { text: `${c.memberCount || (c.members || []).length} member${(c.memberCount || (c.members || []).length) === 1 ? '' : 's'}${names ? ' — ' + names : ''}` }),
    );
    listEl.append(row);
  }
}

async function selectChat(chat, listEl) {
  chatState.active = chat;
  renderChatList(listEl);
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

/* ---- THE INVITE FEATURE — proper UI, Microsoft players only ---- */
function inviteToChat(listEl) {
  if (!chatState.active) { toast('Pick a chat first', 'Select or create a group chat.'); return; }
  const input = el('input', { class: 'input', placeholder: "Friend's NX UUID or exact Microsoft player name…" });
  const err = el('div', { class: 'hint', style: { color: 'var(--danger)', minHeight: '16px', marginTop: '6px' } });
  const result = el('div', { style: { marginTop: '4px' } });
  openModal({
    title: `Invite to "${chatState.active.name}"`,
    sub: 'Enter their NX device UUID (from their Settings → NX Cloud) or their exact Microsoft player name. Offline players cannot be invited — they must sign in once with Microsoft.',
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
              el('div', {}, el('b', { text: r.name }), el('div', { class: 'hint', text: 'Invited! They will see this chat within 5 seconds.' })),
            ));
            input.value = '';
            await refreshChats(listEl);
            toast('Invited', r.name);
          } catch (e) { err.textContent = e.message; }
        },
      }),
    ],
  });
  setTimeout(() => input.focus(), 50);
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

  const popup = el('div', { class: 'nx-chat-backdrop' },
    el('div', { class: 'nx-chat-popup' },
      el('header', { class: 'nx-chat-head' },
        el('div', {},
          el('h2', { text: 'NX Chat' }),
          el('span', { class: 'nx-chat-sub', text: chatState.active ? chatState.active.name : 'Group chats with launcher friends' }),
        ),
        el('span', { style: { flex: '1' } }),
        el('button', { class: 'btn ghost', text: 'Close', onclick: closeChatPopup }),
      ),
      el('div', { class: 'nx-chat-body' },
        el('aside', {},
          el('div', { class: 'nx-chat-ops' },
            el('button', { class: 'btn primary small', text: '+ New group', onclick: () => createChat(listEl) }),
            el('button', { class: 'btn ghost small', text: 'Invite', title: 'Invite by UUID or Microsoft player name', onclick: () => inviteToChat(listEl) }),
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
  refreshChats(listEl);
  if (chatState.active) {
    const fresh = chatState.chats.find((c) => c.id === chatState.active.id);
    selectChat(fresh || chatState.active, listEl);
  }
}
function closeChatPopup() { chatPopup?.remove(); chatPopup = null; offlineBar = null; }

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
  return el('div', { class: 'nx-lock', id: 'nx-lock-overlay' },
    el('div', { class: 'nx-lock-scan' }),
    el('div', { class: 'nx-lock-card' },
      el('div', { class: 'nx-lock-iconwrap', html: padlock }),
      el('h1', { class: 'nx-lock-title', text: 'LAUNCHER LOCKED' }),
      el('p', { class: 'nx-lock-reason', text: lock.reason || 'Locked by the administrator.' }),
      el('div', { class: 'nx-lock-timer', text: '' }),
      el('div', { class: 'nx-lock-uuid' }, `Device: ${nx.identity?.uuid || '…'}`),
      el('p', { class: 'nx-lock-hint', text: 'This device was locked remotely. Minecraft was closed. Only the administrator can unlock it' + (lock.until ? ', or wait for the timer.' : '.') }),
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

  // boot-time lock check (a locked device stays locked even after a restart)
  try {
    const l = await api.invoke('nx:lockState');
    if (l && l.locked !== false && l.reason) showLock(l);
  } catch {}
}

/* ---- page registration ---- */
registerPage('announcements', buildAnnouncements);

export const nxUI = { init, showLock, hideLock };
