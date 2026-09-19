// main.js — renderer bootstrap: navbar, dropdowns (instance & versions), Modrinth button
import { el, $, ICONS, PROVIDER_LOGOS } from './utils.js';
import { api, state, boot, selection, selectInstance, selectVersion, on, EVENTS, refreshInstances, setGameState } from './state.js';
import { registerPage, navigate } from './router.js';
import { openDropdownPanel, closeDropdown, isOpen } from './components/dropdown.js';
import { toast } from './components/toast.js';
import { openModal } from './components/modal.js';

import * as home from './pages/home.js';
import * as newinstance from './pages/newinstance.js';
import * as newserver from './pages/newserver.js';
import * as servers from './pages/servers.js';
import * as settings from './pages/settings.js';
import * as modrinth from './pages/modrinth.js';
import { nxUI } from './nx.js';

/* ---------- brand logo ---------- */
const BRAND_LOGO = `<svg width="34" height="34" viewBox="0 0 512 512">
  <defs><linearGradient id="nxg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#34d3ee"/><stop offset="0.5" stop-color="#3b82f6"/><stop offset="1" stop-color="#d946ef"/>
  </linearGradient></defs>
  <rect x="24" y="24" width="464" height="464" rx="92" fill="#0b0f14"/>
  <path d="M156 366V146h58l124 148V146h58v220h-58L214 218v148z" fill="url(#nxg)"/>
</svg>`;

/* ---------- Modrinth button (single storefront — CurseForge removed) ---------- */
const providerBtn = el('button', { class: 'nav-item provider-btn', 'data-nav': 'provider', title: 'Browse mods, modpacks, resource packs & shaders' },
  el('span', { class: 'provider-swap' },
    el('span', { class: 'logo', html: PROVIDER_LOGOS.modrinth }),
    document.createTextNode('MODRINTH'),
  ));
providerBtn.addEventListener('click', () => {
  navigate('modrinth', { forward: true, force: true }); // force: re-entering the store resets to its root view
  markActive(null);
});

const instanceBtn = el('button', { class: 'nav-item', 'data-nav': 'instances' },
  'INSTANCE', el('span', { class: 'caret', html: `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6z"/></svg>` }));
const versionsBtn = el('button', { class: 'nav-item', 'data-nav': 'versions' },
  'VERSIONS', el('span', { class: 'caret', html: `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6z"/></svg>` }));
const serversBtn = el('button', { class: 'nav-item', 'data-nav': 'servers' }, 'SERVERS');
const newServerBtn = el('button', { class: 'nav-item', 'data-nav': 'new-server' }, '+ NEW SERVER');
const newInstanceBtn = el('button', { class: 'nav-item', 'data-nav': 'new-instance' }, '+ NEW INSTANCE');
const logsBtn = el('button', { class: 'icon-btn', title: 'Game & launcher logs (popup window)', html: ICONS.terminal });
const settingsBtn = el('button', { class: 'icon-btn', title: 'Settings', 'data-nav': 'settings', html: ICONS.gear });

function markActive(id) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (id) document.querySelector(`[data-nav="${id}"]`)?.classList.add('active');
}

/* ---------- INSTANCE dropdown (resizes with instance count; click=select, dbl-click=edit) ---------- */
instanceBtn.addEventListener('click', () => {
  if (instanceBtn.classList.contains('open')) return closeDropdown();
  openDropdownPanel({
    anchor: instanceBtn, width: 320,
    build: (panel) => {
      const list = el('div', { class: 'dd-list dd-inst' });
      const render = (instances) => {
        list.innerHTML = '';
        if (!instances.length) {
          list.append(el('div', { class: 'dd-empty', text: 'No instances yet — create one with + NEW INSTANCE' }));
          return;
        }
        for (const inst of instances) {
          const sel = state.settings?.selectedInstanceId === inst.id;
          const row = el('div', { class: `dd-item ${sel ? 'selected' : ''}` },
            el('div', { class: 'dd-inst-main' },
              el('div', { class: 'inst-avatar', text: (inst.name || 'I').slice(0, 2).toUpperCase() }),
              el('div', { class: 'dd-inst-meta' },
                el('b', { text: inst.name }),
                el('span', { text: `${inst.version} • ${inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}` }),
              ),
            ),
            el('span', { class: 'check', html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M4.5 12.5l5 5 10-11"/></svg>` }),
          );
          // single click = select & play-target it; double click = edit (per spec)
          row.addEventListener('click', () => {
            selectInstance(inst.id).then(() => closeDropdown());
          });
          row.addEventListener('dblclick', () => { closeDropdown(); openEditInstance(inst); });
          list.append(row);
        }
      };
      render(state.instances);
      panel.append(list,
        el('div', { class: 'dd-hintbar' },
          el('span', { text: 'Click = select • Double-click = edit' }),
          el('span', { text: `${state.instances.length} instance${state.instances.length === 1 ? '' : 's'}` }),
        ));
      return panel;
    },
  });
});

function openEditInstance(inst) {
  const nameInput = el('input', { class: 'input', value: inst.name, maxlength: '60' });
  const memInput = el('input', { class: 'input', type: 'number', step: '256', value: inst.memoryMB || state.settings.memoryMB });
  const info = el('div', { class: 'hint', text: `Version ${inst.version} • loader ${inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''} — version/loader can be changed by creating a new instance or installing a Modrinth modpack.` });
  openModal({
    title: `Edit ${inst.name}`,
    sub: 'Rename or adjust memory allocation.',
    body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '13px' } },
      el('div', {}, el('label', { class: 'label', text: 'Name' }), nameInput),
      el('div', {}, el('label', { class: 'label', text: 'Memory (MB)' }), memInput),
      info,
    ),
    actions: (close) => [
      el('button', {
        class: 'btn danger ghost', text: 'Delete',
        onclick: async () => {
          close();
          const { confirmModal } = await import('./components/modal.js');
          const ok = await confirmModal({ title: `Delete ${inst.name}?`, message: 'All worlds, mods and configs of this instance will be removed permanently.' });
          if (!ok) return;
          await api.invoke('instances:delete', { id: inst.id });
          await refreshInstances();
          toast('Instance deleted', inst.name);
        },
      }),
      el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
      el('button', {
        class: 'btn primary', text: 'Save',
        onclick: async () => {
          await api.invoke('instances:update', { id: inst.id, patch: { name: nameInput.value.trim() || inst.name, memoryMB: Number(memInput.value) || null } });
          await refreshInstances();
          close();
          toast('Instance updated', nameInput.value);
        },
      }),
    ],
  });
}

/* ---------- VERSIONS dropdown (max 4 rows visible, scroll for the rest) ---------- */
versionsBtn.addEventListener('click', () => {
  if (versionsBtn.classList.contains('open')) return closeDropdown();
  openDropdownPanel({
    anchor: versionsBtn, width: 330, maxVisibleItems: 4, itemHeight: 40,
    build: (panel) => {
      let group = state.settings.showOldVersions === false ? 'Releases' : 'Releases';
      const search = el('input', { placeholder: 'Search all versions…' });
      const tabs = el('div', { class: 'dd-tabs' });
      const list = el('div', { class: 'dd-list' });
      let all = null;

      const renderTabs = () => {
        tabs.innerHTML = '';
        const groups = ['Releases', 'Snapshots', 'Beta', 'Alpha'].filter(g =>
          !(g === 'Beta' || g === 'Alpha') || state.settings.showOldVersions !== false);
        for (const g of groups) {
          tabs.append(el('div', {
            class: `dd-tab ${g === group ? 'active' : ''}`, text: g,
            onclick: () => { group = g; renderTabs(); renderList(); },
          }));
        }
      };
      const renderList = () => {
        list.innerHTML = '';
        if (!all) { list.append(el('div', { style: { display: 'flex', justifyContent: 'center', padding: '14px' } }, el('span', { class: 'spinner' }))); return; }
        const q = search.value.trim().toLowerCase();
        let items = all.groups[group] || [];
        if (q) items = all.flat.filter(v => v.id.toLowerCase().includes(q)).slice(0, 80);
        if (!items.length) list.append(el('div', { class: 'dd-empty', text: 'No versions.' }));
        for (const v of items) {
          list.append(el('div', {
            class: `dd-item ${v.id === state.settings.selectedVersion ? 'selected' : ''}`,
            onclick: () => {
              selectVersion(v.id).then(() => closeDropdown());
            },
          }, el('span', { text: v.id }), el('span', { class: 'sub', text: v.type !== 'release' ? v.type : '' })));
        }
      };
      search.addEventListener('input', renderList);
      search.addEventListener('keydown', e => e.stopPropagation());
      renderTabs(); renderList();
      panel.append(el('div', { class: 'dd-search' }, search), tabs, list,
        el('div', { class: 'dd-hintbar' },
          el('span', { text: 'Click a version, then PLAY — runs vanilla into global .minecraft' })));
      api.invoke('versions:all').then(v => { all = v; renderList(); }).catch(e =>
        list.append(el('div', { class: 'dd-empty', text: e.message })));
      return panel;
    },
  });
});

/* ---------- nav actions ----------
   NOTE: INSTANCE & VERSIONS are NOT routed here — they have their own direct
   click listeners that toggle their dropdowns. Routing them through this
   delegated handler used to re-trigger .click() a second time, which opened
   the dropdown and instantly closed it (open→toggle→close). */
const NAV = {
  'new-server': () => { markActive('new-server'); navigate('new-server', { force: true }); },
  'new-instance': () => { markActive('new-instance'); navigate('new-instance', { force: true }); },
  'servers': () => { markActive('servers'); navigate('servers', { force: true }); },
  'settings': () => { markActive('settings'); navigate('settings', { force: true }); },
};
document.body.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (!nav) return;
  const key = nav.dataset.nav;
  if (NAV[key]) { e.preventDefault(); NAV[key](); }
});

/* ---------- pages registration ---------- */
registerPage('home', home.buildHome);
registerPage('new-instance', newinstance.buildNewInstance);
registerPage('new-server', newserver.buildNewServer);
registerPage('servers', (c, p) => { servers.disposeServers(); return servers.buildServers(c, p); });
registerPage('settings', settings.buildSettings);
registerPage('modrinth', modrinth.buildModrinth);

/* ---------- app shell ---------- */
async function start() {
  try {
    await startInner();
    // UI is up — disarm the failsafe watchdog
    window.__neuraxMarkBooted?.();
  } catch (e) {
    // show the real error on screen instead of leaving a silent black window
    console.error(e);
    if (typeof window.reportStartupError === 'function') window.reportStartupError(e);
    else throw e;
  }
}

async function startInner() {
  /* greet a remembered Microsoft session exactly once, no matter which of the
     two restore paths (main boot broadcast / renderer boot refresh) wins */
  let welcomed = false;
  const welcomeBack = (acc) => {
    if (welcomed || !acc || acc.type !== 'msa' || !acc.name) return;
    welcomed = true;
    toast('Welcome back, ' + acc.name, 'Your Microsoft session was restored — no need to sign in again.');
  };

  const navbar = el('nav', { id: 'navbar' },
    el('div', { class: 'brand', title: 'Neurax Launcher — Play', html: BRAND_LOGO, onclick: () => { markActive(null); navigate('home', { forward: false }); } }),
    newServerBtn, newInstanceBtn, instanceBtn, serversBtn, versionsBtn,
    providerBtn,
    el('div', { class: 'nav-spacer' }),
    el('div', { class: 'nav-right' }, logsBtn, settingsBtn),
  );
  document.getElementById('app').prepend(navbar);
  document.body.append(el('div', { class: 'ambient' }));

  logsBtn.addEventListener('click', async () => {
    try { await api.invoke('logs:open'); } catch (e) { toast('Logs', e.message, { type: 'warn' }); }
  });

  try { await boot(); } catch (e) { console.error(e); }
  await navigate('home', { forward: true });
  welcomeBack(state.account); // restored before the listener subscribed? still greet

  /* NX Cloud UI: presence chip, chat, announcements badge, lock screen.
     Registered pages + navbar buttons come from this module. */
  try { await nxUI.init(); } catch (e) { console.warn('NX UI init failed:', e); }

  /* engine events → UX */
  api.on('versions:auto-added', ({ added }) => {
    if (added?.length) toast('New Minecraft versions available', added.join(', ') + ' — auto-added to VERSIONS.', { timeout: 6500 });
  });
  api.on('auth:restored', (acc) => {
    if (acc?.name) { state.account = acc; welcomeBack(acc); }
  });

  /* launch lifecycle → persistent state.game (survives page rebuilds, so the
     dashboard ALWAYS shows what the game is doing, no matter how the user got
     back to it — logo click, Back to Play, creating an instance…). */
  api.on('launch:state', (p) => {
    const g = state.game;
    if (p.state === 'starting') {
      setGameState({ phase: 'starting', label: 'Starting…', detail: p.instance ? `${p.instance} • ${p.version}` : (p.version || null), pid: null, exitCode: null, message: null, stopped: false });
    } else if (p.state === 'checking-java') {
      setGameState({ phase: 'starting', label: `Checking Java ${p.javaMajor}…` });
    } else if (p.state === 'installing-loader') {
      setGameState({ phase: 'starting', label: `Installing ${p.loader} ${p.version}…` });
    } else if (p.state === 'downloading-game') {
      setGameState({ phase: 'downloading', label: 'Downloading game files…' });
    } else if (p.state === 'running') {
      setGameState({ phase: 'running', label: null, pid: p.pid ?? null, lastProgress: null });
      toast('Minecraft is running', g.detail || 'Have fun!', { timeout: 4000 });
    } else if (p.state === 'exited') {
      const stopped = g.stopped;
      setGameState({ phase: 'exited', exitCode: p.code ?? null, pid: null, lastProgress: null, stopped: false });
      if (stopped) toast('Minecraft was stopped', 'Session ended.');
      else if (p.code !== 0) toast('Minecraft exited', `Exit code ${p.code}. Check the logs for details.`, { type: 'warn', timeout: 8000 });
    } else if (p.state === 'failed') {
      setGameState({ phase: 'failed', message: p.message || 'Launch failed', lastProgress: null });
      toast('Launch failed', p.message || 'Unknown error', { type: 'error', timeout: 8000 });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closeDropdown();
  });
}

start();
