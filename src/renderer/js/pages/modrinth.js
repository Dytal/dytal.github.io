// modrinth.js — Modrinth storefront (replicates modrinth.com: green accent, card grid,
// filters sidebar, project pages with Description/Gallery/Versions, install flow).
// Includes: Plugins project type (bukkit/paper/spigot/...), Versions-tab search +
// loader/game-version filters, dedicated modpack flow (MC version + loader + pack
// version → download .mrpack OR convert to a real instance), smart one-click install
// when exactly one modded instance exists, and server-preset installs from Servers page.
import { el, $, $$, ICONS, fmtNum, fmtBytes, timeAgo, fmtDate, sanitizeHTML, PROVIDER_LOGOS } from '../utils.js';
import { api, state } from '../state.js';
import {
  buildStoreChrome, iconImg, installFlow, loadMoreBtn, skeletonCards,
  versionFilterBar, applyVersionFilters, pickBestVersion, singleModdedInstance,
} from './store-common.js';
import { progressToast, toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';

const PROJECT_TYPES = [
  { id: 'mod', label: 'Mods' },
  { id: 'modpack', label: 'Modpacks' },
  { id: 'plugin', label: 'Plugins' },
  { id: 'resourcepack', label: 'Resource Packs' },
  { id: 'shader', label: 'Shaders' },
];
const PLUGIN_LOADERS = ['bukkit', 'paper', 'spigot', 'purpur', 'folia', 'velocity', 'waterfall', 'bungeecord'];
const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const LOADERS_BY_TYPE = { mod: MOD_LOADERS, modpack: MOD_LOADERS, plugin: PLUGIN_LOADERS, resourcepack: [], shader: [] };
const SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'follows', label: 'Follows' },
  { id: 'newest', label: 'Newest' },
  { id: 'updated', label: 'Recently updated' },
];
const CATEGORIES = {
  mod: ['adventure', 'cursed', 'decoration', 'economy', 'equipment', 'food', 'game-mechanics', 'library', 'magic', 'management', 'minigame', 'mobs', 'optimization', 'social', 'storage', 'technology', 'transportation', 'utility', 'worldgen'],
  modpack: ['adventure', 'challenging', 'combat', 'exploration', 'experimental', 'ftb', 'hwyla', 'kitchen-sink', 'lightweight', 'map-based', 'multiplayer', 'quests', 'skyblock', 'small', 'tech', 'vanilla-plus'],
  plugin: ['adventure', 'admin-tools', 'chat', 'dev-tools', 'economy', 'game-mechanics', 'games', 'management', 'mechanics', 'protection', 'social', 'teleport', 'utility', 'worldgen'],
  resourcepack: ['8x-', '16x', '32x', '64x', '128x', '256x+', 'audio', 'blocks', 'combat', 'core-shaders', 'decorations', 'environment', 'fonts', 'gui', 'icon', 'items', 'misc', 'models', 'mod-support', 'optimization', 'pure', 'realistic', 'simplistic', 'sound', 'themed', 'tweaks', 'utility', 'vanilla-like'],
  shader: ['cartoon', 'cursed', 'fantasy', 'fbt', 'potato', 'realistic', 'semi-realistic', 'stylized', 'vanilla-like'],
};

export async function buildModrinth(container, params = {}) {
  let presetServerId = (params && params.presetServerId) || null;
  const presetServer = () => state.servers.find(s => s.id === presetServerId) || null;

  const { content } = buildStoreChrome(container, {
    providerClass: 'mr',
    logo: PROVIDER_LOGOS.modrinth,
    title: 'Modrinth',
    sub: 'Mods • Modpacks • Plugins • Resource packs • Shaders — the open source repository',
    targetOverride: presetServer() ? targetPillForServer(presetServer()) : undefined,
  });

  const view = { offset: 0, hits: [], total: 0, loading: false };
  const filters = { q: '', projectType: 'mod', loaders: [], versions: [], categories: [], index: 'relevance' };

  // coming from a server? pin the search to what THAT server can run
  if (presetServer()) {
    const srv = presetServer();
    filters.projectType = ['paper', 'spigot', 'purpur', 'folia'].includes(srv.type) ? 'plugin' : 'mod';
    filters.versions = [srv.version];
    if (LOADERS_BY_TYPE[filters.projectType]?.includes(srv.type)) filters.loaders = [srv.type];
  }

  content.style.display = 'block';
  const viewHost = el('div');
  content.append(viewHost);

  if (presetServer()) await showSearch();
  else await showHome();

  function targetPillForServer(srv) {
    return el('span', { class: 'target-pill server', title: 'Content installs into this server' },
      el('span', { class: 'dot' }),
      el('span', { class: 'pill-ico', html: ICONS.server }),
      `${srv.name} (${srv.type} ${srv.version})`);
  }

  /** preset server target for installFlow (undefined when unpinned) */
  function presetTarget() {
    const srv = presetServer();
    return srv ? { type: 'server', serverId: srv.id, loader: srv.type, version: srv.version } : undefined;
  }

  /* ---------------- home ---------------- */
  async function showHome() {
    viewHost.innerHTML = '';
    const search = el('input', { placeholder: 'Search Modrinth…', 'aria-label': 'search' });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { filters.q = search.value.trim(); showSearch(); }
    });
    const searchRow = el('div', { class: 'store-search', style: { marginBottom: '20px' } },
      el('div', { class: 'search-field' }, el('span', { style: { color: 'var(--faint)' }, html: ICONS.search }), search),
    );

    const featuredWrap = el('div', { class: 'store-featured' });
    featuredWrap.append(el('h3', { text: 'Popular right now' }));
    const grid = skeletonCards(8);
    featuredWrap.append(grid);
    viewHost.append(searchRow, featuredWrap);

    // quick type chips
    const quick = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '14px' } });
    for (const t of PROJECT_TYPES) {
      quick.append(el('span', {
        class: 'chip clickable', text: t.label,
        onclick: () => { filters.projectType = t.id; filters.q = ''; showSearch(); },
      }));
    }
    // smart-install explainer chip when the one-click mode is available
    const smart = singleModdedInstance();
    if (smart) {
      quick.append(el('span', {
        class: 'chip accent', title: 'One-click installs are ON',
        text: `⚡ Smart install → ${smart.name} (${smart.loader} ${smart.version})`,
      }));
    }
    viewHost.append(quick);

    try {
      const res = await api.invoke('modrinth:search', { q: '', projectType: 'mod', index: 'downloads', limit: 12 });
      grid.replaceWith(renderGrid(res.hits, showProject));
    } catch (e) {
      grid.replaceWith(el('div', { class: 'empty-state' }, el('h3', { text: 'Could not reach Modrinth' }), el('p', { text: e.message })));
    }
  }

  /* ---------------- search ---------------- */
  /** Translate UI filters into the Modrinth search payload. */
  function searchPayload({ limit = 20, offset = 0 } = {}) {
    if (filters.projectType === 'plugin') {
      // plugins are project_type=mod on Modrinth, narrowed by bukkit-family loaders
      const chosen = filters.loaders.filter(l => PLUGIN_LOADERS.includes(l));
      return {
        q: filters.q, projectType: 'mod',
        categories: [...filters.categories],
        loaders: chosen.length ? chosen : PLUGIN_LOADERS,
        versions: filters.versions, index: filters.index, limit, offset,
      };
    }
    return {
      q: filters.q, projectType: filters.projectType,
      categories: [...filters.categories, ...filters.loaders],
      versions: filters.versions, index: filters.index, limit, offset,
    };
  }

  async function showSearch() {
    viewHost.innerHTML = '';
    view.offset = 0; view.hits = []; view.total = 0;

    const search = el('input', { placeholder: 'Search Modrinth…', value: filters.q });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { filters.q = search.value.trim(); view.offset = 0; view.hits = []; fetchAndRender(true); }
    });
    const sortSel = el('select', { class: 'store-sort' },
      ...SORTS.map(s => el('option', { value: s.id, text: 'Sort: ' + s.label })));
    sortSel.value = filters.index;
    sortSel.addEventListener('change', () => { filters.index = sortSel.value; view.offset = 0; view.hits = []; fetchAndRender(true); });

    const searchRow = el('div', { class: 'store-search' },
      el('div', { class: 'search-field' }, el('span', { style: { color: 'var(--faint)' }, html: ICONS.search }), search), sortSel);

    /* pinned-server banner (entered from the Servers page) */
    if (presetServer()) {
      const srv = presetServer();
      viewHost.append(el('div', { class: 'preset-banner' },
        el('span', { class: 'pill-ico', html: ICONS.server }),
        el('span', { html: `Installing content into <b>${srv.name}</b> — ${srv.type} ${srv.version}. Install buttons now target this server.` }),
        el('button', {
          class: 'btn small ghost', text: 'Unpin',
          onclick: () => { presetServerId = null; showHome(); },
        }),
      ));
    }

    /* filters sidebar */
    const typeChips = filterGroup('Project type', PROJECT_TYPES.map(t => ({
      label: t.label, on: filters.projectType === t.id,
      onclick: () => { filters.projectType = t.id; filters.categories = []; filters.loaders = []; showSearch(); },
    })));
    const typeLoaders = LOADERS_BY_TYPE[filters.projectType] || [];
    const loaderChips = typeLoaders.length ? filterGroup('Loaders', typeLoaders.map(l => ({
      label: cap(l), on: filters.loaders.includes(l),
      onclick: () => { toggleArr(filters.loaders, l); view.offset = 0; view.hits = []; fetchAndRender(true); },
    }))) : null;
    /* game version dropdown — every version from the manifest, no typing needed */
    const gvSel = el('select', { class: 'input', style: { padding: '8px 10px', fontSize: '12.5px', width: '100%' } });
    gvSel.append(el('option', { value: '', text: 'Any Minecraft version' }));
    api.invoke('versions:all').then(all => {
      const rel = el('optgroup', { label: 'Releases' });
      for (const v of (all.groups.Releases || []).slice(0, 300)) rel.append(el('option', { value: v.id, text: v.id }));
      const snap = el('optgroup', { label: 'Snapshots' });
      for (const v of (all.groups.Snapshots || []).slice(0, 120)) snap.append(el('option', { value: v.id, text: v.id }));
      gvSel.append(rel, snap);
      gvSel.value = filters.versions[0] || '';
    }).catch(() => {});
    gvSel.addEventListener('change', () => {
      filters.versions = gvSel.value ? [gvSel.value] : [];
      view.offset = 0; view.hits = []; fetchAndRender(true);
    });

    /* one-click filter: same MC version + loader as the selected instance */
    const selInst = state.instances.find(i => i.id === state.settings?.selectedInstanceId) || null;
    const matchChip = el('span', {
      class: 'fchip clickable',
      text: selInst ? `Match my instance: ${selInst.version} • ${selInst.loader}` : 'Select an instance first (INSTANCE menu)',
      style: selInst ? {} : { opacity: '0.55', cursor: 'default' },
      onclick: () => {
        if (!selInst) return;
        filters.versions = [selInst.version];
        filters.loaders = selInst.loader && selInst.loader !== 'vanilla' && typeLoaders.includes(selInst.loader) ? [selInst.loader] : [];
        showSearch();
      },
    });
    const catChips = el('div', { class: 'filter-chips' });
    const renderCats = () => {
      catChips.innerHTML = '';
      for (const c of (CATEGORIES[filters.projectType] || []).slice(0, 24)) {
        catChips.append(el('span', {
          class: `fchip ${filters.categories.includes(c) ? 'on' : ''}`, text: c.replace(/-/g, ' '),
          onclick: () => { toggleArr(filters.categories, c); view.offset = 0; view.hits = []; fetchAndRender(true); },
        }));
      }
    };
    renderCats();

    const sidebar = el('div', { class: 'store-filters' },
      el('div', { class: 'card', style: { padding: '14px', display: 'flex', flexDirection: 'column', gap: '16px', background: 'var(--store-panel, var(--panel))' } },
        typeChips, loaderChips,
        el('div', { class: 'filter-group' }, el('h4', { text: 'Game version' }), gvSel, matchChip),
        el('div', { class: 'filter-group' }, el('h4', { text: 'Categories' }), catChips),
      ),
    );

    const results = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    const main = el('div', { class: 'store-main' }, searchRow, results);
    viewHost.append(el('div', { class: 'store-layout' }, sidebar, main));

    async function fetchAndRender(reset = false) {
      results.innerHTML = '';
      results.append(skeletonCards(8));
      try {
        const res = await api.invoke('modrinth:search', searchPayload({ limit: 20, offset: reset ? 0 : view.offset }));
        view.total = res.total_hits;
        if (reset) view.hits = res.hits;
        else view.hits.push(...res.hits);
        results.innerHTML = '';
        const head = el('div', { style: { color: 'var(--muted)', fontSize: '12.5px' } },
          el('b', { text: fmtNum(view.total) + ' results', style: { color: 'var(--text)' } }),
          ` for ${PROJECT_TYPES.find(t => t.id === filters.projectType)?.label || 'projects'}`);
        results.append(head, renderGrid(view.hits, showProject));
        if (view.hits.length < view.total) {
          const lm = loadMoreBtn(() => { view.offset = view.hits.length; fetchAndRender(false); });
          results.append(lm);
        }
      } catch (e) {
        results.innerHTML = '';
        results.append(el('div', { class: 'empty-state' }, el('h3', { text: 'Search failed' }), el('p', { text: e.message })));
      }
    }
    await fetchAndRender(true);
  }

  /* ---------------- project page ---------------- */
  function projectKindOf(project) {
    if (project.project_type === 'modpack') return 'modpack';
    if (project.project_type === 'resourcepack') return 'resourcepack';
    if (project.project_type === 'shader') return 'shader';
    const loaders = (project.loaders || []).map(l => String(l).toLowerCase());
    if (loaders.some(l => PLUGIN_LOADERS.includes(l))) return 'plugin';
    return 'mod';
  }

  async function showProject(idOrSlug, fromSearch = true) {
    viewHost.innerHTML = '';
    const loading = el('div', { style: { display: 'flex', justifyContent: 'center', padding: '60px' } }, el('span', { class: 'spinner large' }));
    viewHost.append(loading);

    let project, versions;
    try {
      [project, versions] = await Promise.all([
        api.invoke('modrinth:project', { id: idOrSlug }),
        api.invoke('modrinth:versions', { id: idOrSlug }),
      ]);
    } catch (e) {
      loading.replaceWith(el('div', { class: 'empty-state' }, el('h3', { text: 'Failed to load project' }), el('p', { text: e.message })));
      return;
    }
    viewHost.innerHTML = '';

    const kind = projectKindOf(project);
    const backToSearch = el('button', { class: 'btn small ghost', html: `${ICONS.back} <span style="margin-left:6px">Back to search</span>`, onclick: () => showSearch() });

    const icon = iconImg(project.icon_url, initialsOf(project.title));
    const installBtn = el('button', { class: 'install-btn', html: `${ICONS.download} ${kind === 'modpack' ? 'Install modpack' : 'Install'}` });
    installBtn.addEventListener('click', () => {
      if (kind === 'modpack') return openModpackFlow(project, versions, null);
      startInstall(project, versions, kind, null, null);
    });

    const stats = el('div', { class: 'proj-stats' },
      el('span', { class: 'stat-chip', html: `${ICONS.download} <b>${fmtNum(project.downloads)}</b> downloads` }),
      el('span', { class: 'stat-chip', html: `${ICONS.heart} <b>${fmtNum(project.follows)}</b> followers` }),
      el('span', { class: 'stat-chip', text: `Updated ${timeAgo(new Date(project.date_modified).getTime())}` }),
      el('span', { class: 'stat-chip', text: `Created ${fmtDate(new Date(project.date_created).getTime())}` }),
      project.license?.name ? el('span', { class: 'stat-chip', text: project.license.name }) : null,
    );

    const tabs = el('div', { class: 'proj-tabs' });
    const tabBody = el('div');
    const TABS = [
      ['description', 'Description'],
      ['gallery', 'Gallery'],
      ['versions', 'Versions'],
    ];
    let activeTab = 'description';
    const renderTabs = () => {
      tabs.innerHTML = '';
      for (const [id, label] of TABS) {
        tabs.append(el('button', {
          class: `proj-tab ${id === activeTab ? 'active' : ''}`, text: label,
          onclick: () => { activeTab = id; renderTabs(); renderTab(); },
        }));
      }
    };
    const renderTab = () => {
      tabBody.innerHTML = '';
      if (activeTab === 'description') {
        tabBody.append(el('div', { class: 'proj-desc', html: sanitizeHTML(project.body || '<p>No description provided.</p>') }));
      } else if (activeTab === 'gallery') {
        const g = el('div', { class: 'gallery-grid' });
        if (!project.gallery?.length) g.append(el('p', { class: 'hint', text: 'No gallery images.' }));
        for (const img of project.gallery || []) {
          g.append(el('img', { src: img.url, alt: img.title || '', loading: 'lazy', title: img.description || '' }));
        }
        tabBody.append(g);
      } else if (activeTab === 'versions') {
        tabBody.append(buildVersionsTab(project, versions, kind));
      }
    };
    renderTabs(); renderTab();

    viewHost.append(
      backToSearch,
      el('div', { class: 'proj-header', style: { marginTop: '14px' } },
        icon,
        el('div', { class: 'proj-head-main' },
          el('div', { class: 'proj-title', text: project.title }),
          el('div', { class: 'proj-byline', html: `by <b>${project.author || 'unknown'}</b> • ${project.project_type}` }),
          el('div', { class: 'p-tags', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
            ...(project.display_categories || project.categories || []).slice(0, 6).map(c => el('span', { class: 'chip', text: c.replace(/-/g, ' ')}))),
          stats,
        ),
        el('div', { class: 'proj-actions' }, installBtn),
      ),
      tabs,
      tabBody,
    );
  }

  /** Shared install entry (mods, plugins, resource packs, shaders). */
  function startInstall(project, versions, kind, fixedVersionId, versionObj) {
    installFlow({
      provider: 'Modrinth',
      projectName: project.title,
      projectType: kind,
      versions,
      fixedVersionId,
      presetTarget: presetTarget(),
      doInstall: async (target, vObj) => {
        const loaders = (project.loaders || []).map(l => String(l).toLowerCase());
        let t = target;
        if (target.type === 'server') {
          const loader = loaders.includes(target.loader) ? target.loader : (loaders[0] || target.loader);
          t = { ...target, loader };
        } else {
          const loader = target.loader && loaders.includes(target.loader) ? target.loader : (loaders[0] || null);
          t = loader ? { ...target, loader } : target;
        }
        return api.invoke('modrinth:install', {
          projectId: project.project_id || project.slug,
          target: t,
          versionId: vObj ? vObj.id : (fixedVersionId || null),
        });
      },
    });
  }

  /* ---------------- Versions tab (with search + filters) ---------------- */
  function buildVersionsTab(project, versions, kind) {
    const fstate = { q: '', loader: '', gv: '' };
    const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
    const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

    const renderList = () => {
      const filtered = applyVersionFilters(versions, fstate);
      list.innerHTML = '';
      if (!filtered.length) {
        list.append(el('p', { class: 'hint', text: 'No versions match these filters.' }));
        return;
      }
      for (const v of filtered.slice(0, 60)) {
        const primary = v.files.find(f => f.primary) || v.files[0];
        list.append(el('div', { class: 'version-row' },
          el('span', { class: 'v-num', text: v.version_number }),
          el('div', { class: 'v-chips' },
            ...v.loaders.map(l => el('span', { class: 'vchip loader', text: l })),
            ...v.game_versions.slice(-3).map(gv => el('span', { class: 'vchip', text: gv })),
            v.game_versions.length > 3 ? el('span', { class: 'vchip', text: `+${v.game_versions.length - 3}` }) : null,
          ),
          el('span', { class: 'v-date', text: fmtDate(new Date(v.date_published).getTime()) }),
          primary ? el('button', {
            class: 'btn small primary', html: `${ICONS.download} ${fmtBytes(primary.size)}`,
            onclick: () => {
              if (kind === 'modpack') openModpackFlow(project, versions, v.id);
              else startInstall(project, versions, kind, v.id, v);
            },
          }) : null,
        ));
      }
      if (filtered.length > 60) list.append(el('p', { class: 'hint', text: `Showing 60 of ${fmtNum(filtered.length)} matching versions — refine the filters.` }));
    };

    wrap.append(versionFilterBar(versions, fstate, renderList));
    renderList();
    wrap.append(list);
    if (!versions.length) wrap.append(el('p', { class: 'hint', text: 'No versions.' }));
    return wrap;
  }

  /* ---------------- modpack flow ----------------
     User picks: MC version + loader (what the pack is available in) + the pack
     version → then EITHER downloads the .mrpack file OR converts it into a
     real playable instance. */
  function openModpackFlow(project, versions, fixedVersionId) {
    const gameVersions = [...new Set(versions.flatMap(v => v.game_versions || []))];
    const packLoaders = [...new Set(versions.flatMap(v => v.loaders || []))].filter(l => l !== 'minecraft');

    const gvSel = el('select', { class: 'input', style: { width: '100%' } },
      el('option', { value: '', text: 'Any Minecraft version' }),
      ...gameVersions.slice(0, 120).map(g => el('option', { value: g, text: g })));
    const loaderSel = el('select', { class: 'input', style: { width: '100%' } },
      el('option', { value: '', text: 'Any loader' }),
      ...packLoaders.map(l => el('option', { value: l, text: cap(l) })));

    let chosen = fixedVersionId ? (versions.find(v => v.id === fixedVersionId) || null) : null;
    const verList = el('div', { class: 'pick-list', style: { maxHeight: '230px', overflowY: 'auto' } });

    const filteredVersions = () => versions.filter(v =>
      (!gvSel.value || (v.game_versions || []).includes(gvSel.value)) &&
      (!loaderSel.value || (v.loaders || []).includes(loaderSel.value)));

    const renderList = () => {
      const filtered = filteredVersions();
      verList.innerHTML = '';
      if (!filtered.length) {
        verList.append(el('div', { class: 'pick-hint', text: 'No modpack version for this Minecraft version + loader combination.' }));
        return;
      }
      for (const v of filtered.slice(0, 60)) {
        const primary = v.files.find(f => f.primary) || v.files[0];
        verList.append(el('div', {
          class: `pick-item ${chosen && chosen.id === v.id ? 'selected' : ''}`,
          style: { display: 'block', padding: '9px 12px' },
          onclick: () => { chosen = v; renderList(); },
        },
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            el('b', { text: v.version_number, style: { fontSize: '13px' } }),
            primary ? el('span', { style: { marginLeft: 'auto', color: 'var(--muted)', fontSize: '11px' }, text: fmtBytes(primary.size) }) : null,
          ),
          el('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '5px' } },
            ...(v.loaders || []).map(l => el('span', { class: 'vchip loader', text: l })),
            ...(v.game_versions || []).slice(-2).map(g => el('span', { class: 'vchip', text: g })),
          ),
        ));
      }
    };
    gvSel.addEventListener('change', () => renderList());
    loaderSel.addEventListener('change', () => renderList());
    renderList();

    const requireVersion = () => {
      if (!chosen) { toast('Pick a modpack version', 'Select one of the modpack versions first.', { type: 'warn' }); return null; }
      return chosen;
    };

    /** action A: save the raw .mrpack file anywhere on disk */
    const downloadMrpack = async (close) => {
      const v = requireVersion(); if (!v) return;
      close();
      const dest = await api.invoke('dialog:saveFile', {
        title: 'Save modpack file',
        defaultPath: `${(project.slug || project.title || 'modpack').replace(/[^\w.-]+/g, '-')}-${v.version_number}.mrpack`,
        filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }],
      });
      if (!dest) return;
      const pt = progressToast('Downloading modpack…', true);
      const unsub = api.on('install:progress', (p) => {
        if (!p || (p.provider || '').toLowerCase() !== 'modrinth') return;
        if (p.received != null) pt.update(p.received || 0, p.total || 0, 'Downloading…');
      });
      try {
        const res = await api.invoke('modrinth:downloadMrpack', { versionId: v.id, destPath: dest });
        pt.done('Saved');
        toast('Modpack saved', `${res.filename} → ${res.path}`);
      } catch (e) {
        pt.fail('Failed');
        toast('Download failed', e.message, { type: 'error' });
      } finally { unsub(); }
    };

    /** action B: convert the .mrpack into a REAL instance (overrides + every file + loader) */
    const convertToInstance = async (close) => {
      const v = requireVersion(); if (!v) return;
      close();
      // mini confirm: instance name (prefilled), shows what will be built
      const nameInput = el('input', { class: 'input', value: project.title || '', maxlength: '60' });
      const gv = (v.game_versions || [])[0] || '—';
      const ld = (v.loaders || [])[0] || 'vanilla';
      const ok = await new Promise((resolve) => {
        let m;
        m = openModal({
          title: 'Convert to instance',
          sub: 'Creates a real playable instance: overrides, every mod/config file, correct loader.',
          body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            el('div', {}, el('label', { class: 'label', text: 'Instance name' }), nameInput),
            el('div', { class: 'hint', text: `${project.title} ${v.version_number} • Minecraft ${gv} • ${cap(ld)} — files are sha1-verified during install.` }),
          ),
          actions: (close) => [
            el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { resolve(false); close(); } }),
            el('button', { class: 'btn primary', text: 'Create instance', onclick: () => { resolve(nameInput.value.trim() || project.title || 'Modpack'); close(); } }),
          ],
          onClose: () => resolve(false),
        });
      });
      if (!ok) return;

      const pt = progressToast('Importing modpack…', true);
      const unsub = api.on('install:progress', (p) => {
        if (!p || (p.provider || '').toLowerCase() !== 'modrinth') return;
        if (p.status) pt.status(p.status);
        else if (p.count != null) pt.count(p.done || 0, p.count || 0, p.file || '');
        else if (p.received != null) pt.update(p.received || 0, p.total || 0, 'Downloading modpack…');
      });
      try {
        const res = await api.invoke('modrinth:installModpackVersion', {
          projectId: project.project_id || project.slug,
          versionId: v.id,
          target: { type: 'new-instance', name: typeof ok === 'string' ? ok : project.title, memoryMB: state.settings?.memoryMB || 2048 },
        });
        pt.done('Modpack installed');
        toast('Modpack instance ready', `${res.instance} • ${res.version} • ${res.loader} (${res.files} files)`);
        const { refreshInstances, selectInstance } = await import('../state.js');
        await refreshInstances();
        await selectInstance(res.instanceId);
        const { navigate } = await import('../router.js');
        navigate('home', { forward: false });
      } catch (e) {
        pt.fail('Failed');
        toast('Import failed', e.message, { type: 'error' });
      } finally { unsub(); }
    };

    openModal({
      title: `Install ${project.title}`,
      sub: 'Choose the Minecraft version, the loader the pack is available for, then the modpack version itself.',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        el('div', { class: 'form-row' },
          el('div', {}, el('label', { class: 'label', text: 'Minecraft version' }), gvSel),
          el('div', {}, el('label', { class: 'label', text: 'Loader' }), loaderSel),
        ),
        el('div', {}, el('label', { class: 'label', text: 'Modpack version' }), verList),
      ),
      actions: (close) => [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
        el('button', { class: 'btn', html: `${ICONS.save} <span style="margin-left:6px">Download .mrpack</span>`, onclick: () => downloadMrpack(close) }),
        el('button', { class: 'btn primary', html: `${ICONS.box} <span style="margin-left:6px">Convert to instance</span>`, onclick: () => convertToInstance(close) }),
      ],
    });
  }

  /* ---------------- helpers ---------------- */
  function renderGrid(hits, openFn) {
    const grid = el('div', { class: 'store-grid stagger' });
    if (!hits.length) grid.append(el('div', { class: 'empty-state', style: { gridColumn: '1/-1' } }, el('h3', { text: 'Nothing found' }), el('p', { text: 'Try different filters.' })));
    for (const h of hits) {
      grid.append(el('div', { class: 'project-card', onclick: () => openFn(h.project_id || h.slug) },
        el('div', { class: 'p-head' },
          iconImg(h.icon_url, initialsOf(h.title)),
          el('div', { style: { minWidth: '0' } },
            el('div', { class: 'p-title', text: h.title }),
            el('div', { class: 'p-author', text: 'by ' + h.author }),
          ),
        ),
        el('div', { class: 'p-desc', text: h.description || '' }),
        el('div', { class: 'p-tags' },
          ...(h.display_categories || []).slice(0, 3).map(c => el('span', { class: 'chip', text: c.replace(/-/g, ' ') }))),
        el('div', { class: 'p-foot' },
          el('span', { class: 'stat', html: `${ICONS.download} ${fmtNum(h.downloads)}` }),
          el('span', { class: 'stat', html: `${ICONS.heart} ${fmtNum(h.follows)}` }),
          el('span', { class: 'stat', text: timeAgo(new Date(h.date_modified).getTime()) }),
        ),
      ));
    }
    return grid;
  }

  function filterGroup(title, chips) {
    const wrap = el('div', { class: 'filter-group' });
    wrap.append(el('h4', { text: title }));
    const row = el('div', { class: 'filter-chips' });
    for (const c of chips) row.append(el('span', { class: `fchip ${c.on ? 'on' : ''}`, text: c.label, onclick: c.onclick }));
    wrap.append(row);
    return wrap;
  }
}

function initialsOf(title) { return (title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function toggleArr(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
