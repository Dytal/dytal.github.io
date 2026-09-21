// newinstance.js — create instance form (name / version / memory / loader / loader version)
// + Import a .mrpack Modrinth modpack into a real playable instance (one click).
import { el, $, fmtBytes } from '../utils.js';
import { api, refreshInstances, selectInstance, state } from '../state.js';
import { toast, progressToast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { openDropdownPanel, closeDropdown } from '../components/dropdown.js';
import { ICONS } from '../utils.js';

const LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];

export async function buildNewInstance(container) {
  let version = null;       // selected MC version id
  let loader = 'vanilla';
  let loaderVersion = null;
  let memoryMB = state.settings?.memoryMB || 2048;
  const totalMB = state.appInfo?.totalMemoryMB || 8192;

  /* ---------- version select ---------- */
  const versionBtn = selectBtn('Version');
  versionBtn.addEventListener('click', () => {
    if (versionBtn._open) return closeDropdown();
    openDropdownPanel({
      anchor: versionBtn, width: Math.max(320, versionBtn.offsetWidth + 60), maxVisibleItems: 4, itemHeight: 40,
      build: (panel) => {
        let group = 'Releases';
        const search = el('input', { placeholder: 'Search versions…', style: { marginBottom: '4px' } });
        const tabs = el('div', { class: 'dd-tabs' });
        const list = el('div', { class: 'dd-list' });
        let all = null;
        panel.append(el('div', { class: 'dd-search' }, search), tabs, list);

        const renderTabs = () => {
          tabs.innerHTML = '';
          for (const g of ['Releases', 'Snapshots', 'Beta', 'Alpha']) {
            tabs.append(el('div', {
              class: `dd-tab ${g === group ? 'active' : ''}`,
              onclick: () => { group = g; renderTabs(); renderList(); },
              text: g,
            }));
          }
        };
        const renderList = () => {
          list.innerHTML = '';
          if (!all) { list.append(spinnerRow()); return; }
          const q = search.value.trim().toLowerCase();
          let items = all.groups[group] || [];
          if (q) items = all.flat.filter(v => v.id.toLowerCase().includes(q)).slice(0, 60);
          if (!items.length) list.append(el('div', { class: 'dd-empty', text: 'No versions match.' }));
          for (const v of items) {
            list.append(el('div', {
              class: `dd-item ${v.id === version ? 'selected' : ''}`,
              onclick: () => {
                version = v.id; setSelectValue(versionBtn, version);
                loaderVersion = null; setSelectValue(loaderVerBtn, null);
                closeDropdown();
              },
            }, el('span', { text: v.id }), el('span', { class: 'sub', text: v.type === 'release' ? '' : v.type })));
          }
        };
        search.addEventListener('input', () => renderList());
        search.addEventListener('keydown', e => e.stopPropagation());
        renderTabs();
        renderList();
        api.invoke('versions:all').then(v => { all = v; renderList(); });
        return panel;
      },
    });
  });

  /* ---------- loader select ---------- */
  const loaderBtn = selectBtn('Loader');
  setSelectValue(loaderBtn, 'vanilla');
  loaderBtn.addEventListener('click', () => {
    if (loaderBtn._open) return closeDropdown();
    openDropdownPanel({
      anchor: loaderBtn, width: 260, maxVisibleItems: 5, itemHeight: 40,
      build: (panel) => {
        const list = el('div', { class: 'dd-list' });
        for (const l of LOADERS) {
          list.append(el('div', {
            class: `dd-item ${l === loader ? 'selected' : ''}`,
            onclick: () => {
              loader = l; loaderVersion = null;
              setSelectValue(loaderBtn, l); setSelectValue(loaderVerBtn, null);
              closeDropdown();
            },
          }, el('span', { style: { textTransform: 'capitalize' }, text: l })));
        }
        panel.append(list);
        return panel;
      },
    });
  });

  /* ---------- loader version select ---------- */
  const loaderVerBtn = selectBtn('Loader version');
  loaderVerBtn.addEventListener('click', () => {
    if (loaderVerBtn._open) return closeDropdown();
    if (!version) { toast('Pick a Minecraft version first', '', { type: 'warn' }); return; }
    if (loader === 'vanilla') { toast('Vanilla has a single built-in version', '', { type: 'warn' }); return; }
    openDropdownPanel({
      anchor: loaderVerBtn, width: 300, maxVisibleItems: 4, itemHeight: 40,
      build: (panel) => {
        const list = el('div', { class: 'dd-list' });
        list.append(spinnerRow());
        panel.append(list);
        const channel = { fabric: 'versions:fabricLoaders', quilt: 'versions:quiltLoaders', forge: 'versions:forgeVersions', neoforge: 'versions:neoforgeVersions' }[loader];
        api.invoke(channel, { gameVersion: version }).then(items => {
          list.innerHTML = '';
          if (!items?.length) { list.append(el('div', { class: 'dd-empty', text: `No ${loader} builds for ${version}` })); return; }
          for (const it of items.slice(0, 50)) {
            const id = it.loader || it.version;
            list.append(el('div', {
              class: `dd-item ${id === loaderVersion ? 'selected' : ''}`,
              onclick: () => { loaderVersion = id; setSelectValue(loaderVerBtn, id); closeDropdown(); },
            }, el('span', { text: id }), it.tag ? el('span', { class: 'sub', text: it.tag }) : null));
          }
        }).catch(e => { list.innerHTML = ''; list.append(el('div', { class: 'dd-empty', text: e.message })); });
        return panel;
      },
    });
  });

  /* ---------- memory slider ---------- */
  const slider = el('input', { type: 'range', class: 'slider', min: '1024', max: String(Math.max(1024, totalMB - 1024)), step: '256', value: String(memoryMB) });
  const memVal = el('span', { class: 'val', text: fmtMem(memoryMB) });
  const syncSlider = () => {
    memoryMB = Number(slider.value);
    const pct = ((memoryMB - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
    slider.style.setProperty('--fill', pct + '%');
    memVal.textContent = fmtMem(memoryMB);
  };
  slider.addEventListener('input', syncSlider);
  syncSlider();

  /* ---------- name input ---------- */
  const nameInput = el('input', { class: 'input', placeholder: 'Instance name…', maxlength: '60' });
  setTimeout(() => nameInput.focus(), 250);

  /* ---------- create ---------- */
  const createBtn = el('button', { class: 'btn primary', onclick: doCreate }, 'Create An Instance');
  async function doCreate() {
    const name = nameInput.value.trim() || `Instance ${state.instances.length + 1}`;
    if (!version) { toast('Missing version', 'Choose a Minecraft version.', { type: 'warn' }); return; }
    if (loader !== 'vanilla' && !loaderVersion) {
      toast('Missing loader version', `Choose a ${loader} version.`, { type: 'warn' });
      return;
    }
    createBtn.disabled = true;
    try {
      const inst = await api.invoke('instances:create', {
        name, version, loader,
        loaderVersion: loader === 'vanilla' ? null : loaderVersion,
        memoryMB,
      });
      await refreshInstances();
      // make the new instance the active PLAY target — the dashboard we're about
      // to land on must show THIS instance on the play button
      await selectInstance(inst.id);
      toast('Instance created', `${name} • ${version} • ${loader}`, {});
      const { navigate } = await import('../router.js');
      navigate('home', { forward: false });
    } catch (e) {
      toast('Could not create instance', e.message, { type: 'error' });
    } finally { createBtn.disabled = false; }
  }

  const folderBtn = el('button', { class: 'icon-btn', title: 'Open .neurax folder', onclick: () => api.invoke('app:openFolder', {}), html: ICONS.folder });

  /* ---------- import .mrpack modpack ---------- */
  const importBtn = el('button', { class: 'btn', html: `${ICONS.up} <span style="margin-left:6px">Import .mrpack modpack</span>`, onclick: doImportMrpack });
  async function doImportMrpack() {
    const file = await api.invoke('dialog:openFile', {
      title: 'Select a Modrinth modpack (.mrpack)',
      filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }],
    });
    if (!file) return;
    let info;
    try { info = await api.invoke('modrinth:readMrpack', { mrpackPath: file }); }
    catch (e) { toast('Not a valid modpack', e.message, { type: 'error' }); return; }

    const nameInput = el('input', { class: 'input', value: info.name || 'Modpack', maxlength: '60' });
    const proceed = await new Promise((resolve) => {
      openModal({
        title: 'Import modpack',
        sub: 'This converts the .mrpack into a fully working instance — overrides, mods, configs, the right loader.',
        body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
          el('div', { class: 'mrpack-preview' },
            el('div', {}, el('b', { text: info.name || 'Modpack' })),
            info.summary ? el('div', { class: 'hint', text: info.summary }) : null,
            el('div', { class: 'mp-meta' },
              el('span', { class: 'vchip', text: `Minecraft ${info.gameVersion || '?'}` }),
              el('span', { class: 'vchip loader', text: `${cap1(info.loader)}${info.loaderVersion ? ' ' + info.loaderVersion : ''}` }),
              el('span', { class: 'vchip', text: `${info.fileCount} files` }),
              el('span', { class: 'vchip', text: fmtBytes(info.totalBytes) }),
              info.hasOverrides ? el('span', { class: 'vchip', text: 'overrides' }) : null,
            ),
          ),
          el('div', {}, el('label', { class: 'label', text: 'Instance name' }), nameInput),
        ),
        actions: (close) => [
          el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { resolve(false); close(); } }),
          el('button', { class: 'btn primary', text: 'Import & create instance', onclick: () => { resolve(true); close(); } }),
        ],
        onClose: () => resolve(false),
      });
    });
    if (!proceed) return;

    const pt = progressToast('Importing modpack…', true);
    const unsub = api.on('install:progress', (p) => {
      if (!p || (p.provider || '').toLowerCase() !== 'modrinth') return;
      if (p.status) pt.status(p.status);
      else if (p.count != null) pt.count(p.done || 0, p.count || 0, p.file || '');
      else if (p.received != null) pt.update(p.received || 0, p.total || 0, 'Downloading…');
    });
    try {
      const res = await api.invoke('modrinth:installMrpack', {
        mrpackPath: file,
        target: { type: 'new-instance', name: nameInput.value.trim() || info.name || 'Modpack', memoryMB: state.settings?.memoryMB || 2048 },
      });
      pt.done('Modpack installed');
      toast('Modpack imported', `${res.instance} • ${res.version} • ${res.loader} (${res.files} files verified)`);
      await refreshInstances();
      await selectInstance(res.instanceId);
      const { navigate } = await import('../router.js');
      navigate('home', { forward: false });
    } catch (e) {
      pt.fail('Failed');
      toast('Import failed', e.message, { type: 'error' });
    } finally { unsub(); }
  }
  function cap1(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  /* ---------- layout (mockup: form card left, hero right) ---------- */
  container.append(
    el('div', { class: 'page-title', text: 'New Instance' }),
    el('div', { class: 'page-sub', text: 'Create a fresh game installation. Worlds, configs and mods live in .neurax/instances/<name>/.' }),
    el('div', { class: 'split' },
      el('div', { class: 'left' },
        el('div', { class: 'card', style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
          el('div', {}, el('label', { class: 'label', text: 'Instance name' }), nameInput),
          el('div', {}, el('label', { class: 'label', text: 'Version' }), wrapSelect(versionBtn)),
          el('div', { class: 'form-row' },
            el('div', {}, el('label', { class: 'label', text: 'Loader' }), wrapSelect(loaderBtn)),
            el('div', {}, el('label', { class: 'label', text: 'Loader version' }), wrapSelect(loaderVerBtn)),
          ),
          el('div', { class: 'mem-slider' },
            el('div', { class: 'mem-head' }, el('span', { text: 'Memory' }), memVal),
            slider,
            el('div', { class: 'mem-head' }, el('span', { text: '' }), el('span', { class: 'hint', text: `Total system memory: ${(totalMB / 1024).toFixed(0)} GB` })),
          ),
          el('div', { class: 'form-actions' }, folderBtn, createBtn),
        ),
        el('div', { class: 'card mrpack-import' },
          el('div', { class: 'mp-ico', html: ICONS.download }),
          el('div', { style: { flex: '1', minWidth: '0' } },
            el('b', { text: 'Have a .mrpack modpack file?' }),
            el('div', { class: 'hint', text: 'Import a Modrinth modpack and it becomes a real instance — overrides, mods, configs and the exact loader, all verified with sha1 checksums.' }),
          ),
          importBtn,
        ),
      ),
      el('div', { class: 'right' },
        el('div', {
          class: 'card animate-fade-up',
          style: {
            height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '14px', textAlign: 'center', padding: '40px',
            background: 'radial-gradient(500px 300px at 50% 0%, var(--accent-soft), transparent 70%), var(--panel)',
          },
        },
          el('div', { class: 'hero-icon', html: ICONS.box }),
          el('div', { style: { fontSize: '19px', fontWeight: '800' }, text: 'Your own installs' }),
          el('p', { class: 'hint', style: { maxWidth: '320px', fontSize: '13px', lineHeight: '1.7' },
            text: 'Every instance keeps its own worlds, resource packs, mods and configuration — completely isolated. Switch any time from the INSTANCE menu; double-click an instance there to edit it.' }),
          el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' } },
            ...LOADERS.map(l => el('span', { class: `chip ${l === loader ? 'accent' : ''}`, text: l }))),
        ),
      ),
    ),
  );
}

/* shared helpers (exported for newserver.js) */
export function selectBtn(placeholder) {
  const b = el('button', { class: 'select-btn' },
    el('span', { class: 'placeholder', text: placeholder }),
    el('span', { class: 'caret', html: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 9l6 6 6-6z"/></svg>` }),
  );
  b._placeholder = placeholder;
  return b;
}
export function setSelectValue(btn, value) {
  const span = btn.querySelector('span');
  if (!span) return;
  if (value) { span.textContent = value; span.classList.remove('placeholder'); }
  else { span.textContent = btn._placeholder || 'Select…'; span.classList.add('placeholder'); }
}
export function wrapSelect(btn) {
  return el('div', { class: 'select-wrap' }, btn);
}
export function spinnerRow() {
  return el('div', { style: { display: 'flex', justifyContent: 'center', padding: '16px' } }, el('span', { class: 'spinner' }));
}
export function fmtMem(mb) { return mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB'; }
