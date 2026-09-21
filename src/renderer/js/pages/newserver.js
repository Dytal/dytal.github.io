// newserver.js — create server form (mockup: name / type / memory / port / motd / create)
import { el } from '../utils.js';
import { api, refreshServers, state } from '../state.js';
import { toast } from '../components/toast.js';
import { openDropdownPanel, closeDropdown } from '../components/dropdown.js';
import { ICONS } from '../utils.js';
import { selectBtn, setSelectValue, wrapSelect, spinnerRow, fmtMem } from './newinstance.js';

const TYPES = [
  { id: 'paper', desc: 'High-performance Spigot fork (official builds)' },
  { id: 'vanilla', desc: 'Official Mojang server jar' },
  { id: 'fabric', desc: 'Fabric modded server' },
  { id: 'forge', desc: 'Forge modded server' },
  { id: 'neoforge', desc: 'NeoForge modded server' },
  { id: 'quilt', desc: 'Quilt modded server' },
  { id: 'spigot', desc: 'Built via BuildTools / manual jar' },
];

export async function buildNewServer(container) {
  let type = 'vanilla';
  let version = null;
  let memoryMB = 2048;
  const totalMB = state.appInfo?.totalMemoryMB || 8192;

  const typeBtn = selectBtn('Vanilla');
  typeBtn.querySelector('span').textContent = 'Vanilla';
  typeBtn._value = 'vanilla';
  typeBtn.addEventListener('click', () => {
    if (typeBtn._open) return closeDropdown();
    openDropdownPanel({
      anchor: typeBtn, width: 320, maxVisibleItems: 5, itemHeight: 46,
      build: (panel) => {
        const list = el('div', { class: 'dd-list' });
        for (const t of TYPES) {
          list.append(el('div', {
            class: `dd-item ${t.id === type ? 'selected' : ''}`,
            onclick: () => { type = t.id; version = null; setSelectValue(typeBtn, cap(t.id)); closeDropdown(); },
            ondblclick: () => { type = t.id; version = null; setSelectValue(typeBtn, cap(t.id)); closeDropdown(); },
          }, el('span', { text: cap(t.id) }), el('span', { class: 'sub', text: t.desc.slice(0, 26) })));
        }
        panel.append(list);
        return panel;
      },
    });
  });

  const versionBtn = selectBtn('Version');
  versionBtn.addEventListener('click', () => {
    if (versionBtn._open) return closeDropdown();
    openDropdownPanel({
      anchor: versionBtn, width: 340, maxVisibleItems: 4, itemHeight: 40,
      build: (panel) => {
        const search = el('input', { placeholder: 'Search versions…' });
        const list = el('div', { class: 'dd-list' });
        list.append(spinnerRow());
        panel.append(el('div', { class: 'dd-search' }, search), list);
        let currentIds = null;

        const renderItems = (ids) => {
          list.innerHTML = '';
          const q = search.value.trim().toLowerCase();
          const filtered = q ? ids.filter(v => v.toLowerCase().includes(q)) : ids;
          if (!filtered.length) list.append(el('div', { class: 'dd-empty', text: 'No versions match.' }));
          for (const v of filtered.slice(0, 80)) {
            list.append(el('div', {
              class: `dd-item ${v === version ? 'selected' : ''}`,
              onclick: () => { version = v; setSelectValue(versionBtn, v); closeDropdown(); },
            }, el('span', { text: v })));
          }
        };
        search.addEventListener('input', () => currentIds && renderItems(currentIds));
        search.addEventListener('keydown', e => e.stopPropagation());

        if (type === 'paper') {
          api.invoke('servers:paperVersions').then(r => { currentIds = r.versions; renderItems(currentIds); })
            .catch(e => { list.innerHTML = ''; list.append(el('div', { class: 'dd-empty', text: e.message })); });
        } else {
          api.invoke('versions:all').then(r => {
            currentIds = r.groups.Releases.map(v => v.id);
            if (state.settings.showSnapshots) currentIds = [...r.groups.Snapshots.map(v => v.id), ...currentIds];
            renderItems(currentIds);
          }).catch(e => { list.innerHTML = ''; list.append(el('div', { class: 'dd-empty', text: e.message })); });
        }
        return panel;
      },
    });
  });

  const slider = el('input', { type: 'range', class: 'slider', min: '512', max: String(Math.max(1024, totalMB - 1024)), step: '256', value: String(memoryMB) });
  const memVal = el('span', { class: 'val', text: fmtMem(memoryMB) });
  const syncSlider = () => {
    memoryMB = Number(slider.value);
    slider.style.setProperty('--fill', ((memoryMB - Number(slider.min)) / (Number(slider.max) - Number(slider.min)) * 100) + '%');
    memVal.textContent = fmtMem(memoryMB);
  };
  slider.addEventListener('input', syncSlider);
  syncSlider();

  const nameInput = el('input', { class: 'input', placeholder: 'Enter a server name…', maxlength: '60' });
  const portInput = el('input', { class: 'input', placeholder: 'PORT', type: 'number', min: '1024', max: '65535', value: '25565' });
  const motdInput = el('input', { class: 'input', placeholder: 'MOTD', maxlength: '120' });
  setTimeout(() => nameInput.focus(), 250);

  const createBtn = el('button', { class: 'btn primary', onclick: doCreate }, 'Create Server');
  async function doCreate() {
    const name = nameInput.value.trim() || `Server ${state.servers.length + 1}`;
    if (!version) { toast('Missing version', 'Choose the server Minecraft version.', { type: 'warn' }); return; }
    createBtn.disabled = true;
    try {
      const srv = await api.invoke('servers:create', {
        name, type, version, memoryMB,
        port: Number(portInput.value) || 25565,
        motd: motdInput.value.trim() || name,
      });
      await refreshServers();
      toast('Server created', `${name} • ${cap(type)} ${version} — open SERVERS to install & start`, { timeout: 5000 });
      const { navigate } = await import('../router.js');
      navigate('servers', { params: { select: srv.id } });
    } catch (e) {
      toast('Could not create server', e.message, { type: 'error' });
    } finally { createBtn.disabled = false; }
  }

  const folderBtn = el('button', { class: 'icon-btn', title: 'Open .neurax folder', onclick: () => api.invoke('app:openFolder', {}), html: ICONS.folder });

  container.append(
    el('div', { class: 'page-title', text: 'New Server' }),
    el('div', { class: 'page-sub', text: 'Spin up a local Minecraft server. It lives in .neurax/servers/<name>/ with its own console and file inspector.' }),
    el('div', { class: 'form-page' },
      el('div', { class: 'form-shell', style: { width: 'min(720px, 100%)' } },
        el('div', {}, el('label', { class: 'label', text: 'Server name' }), nameInput),
        el('div', { class: 'form-row' },
          el('div', {}, el('label', { class: 'label', text: 'Server type' }), wrapSelect(typeBtn)),
          el('div', {}, el('label', { class: 'label', text: 'Version' }), wrapSelect(versionBtn)),
        ),
        el('div', { class: 'form-row' },
          el('div', { class: 'mem-slider' },
            el('div', { class: 'mem-head' }, el('span', { text: 'Memory' }), memVal),
            slider,
          ),
          el('div', { style: { flex: '0 0 170px' } },
            el('label', { class: 'label', text: 'Port' }), portInput),
        ),
        el('div', {}, el('label', { class: 'label', text: 'MOTD' }), motdInput),
        el('div', { class: 'form-actions' }, folderBtn, createBtn),
      ),
    ),
  );
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
