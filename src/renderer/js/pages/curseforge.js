// curseforge.js — CurseForge storefront (replicates curseforge.com: orange accent,
// row-style results, categories sidebar, project pages with Description/Files, install flow).
// Requires the user's free API key (Settings → Integrations) — the official CF API is key-only.
import { el, ICONS, fmtNum, fmtBytes, timeAgo, fmtDate, sanitizeHTML, PROVIDER_LOGOS } from '../utils.js';
import { api, state, saveSettings } from '../state.js';
import { toast } from '../components/toast.js';
import { buildStoreChrome, iconImg, installFlow, loadMoreBtn } from './store-common.js';

const CLASS_IDS = { mod: 6, resourcepack: 12, modpack: 4471, world: 17 };
const PROJECT_TYPES = [
  { id: 'mod', label: 'Mods' },
  { id: 'modpack', label: 'Modpacks' },
  { id: 'resourcepack', label: 'Resource Packs' },
  { id: 'world', label: 'Worlds' },
];
const SORTS = [
  { id: 2, label: 'Popularity' },
  { id: 6, label: 'Total downloads' },
  { id: 3, label: 'Last updated' },
  { id: 4, label: 'Name' },
];
const MOD_LOADER_ENUM = { any: 0, forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

export async function buildCurseforge(container) {
  const { content } = buildStoreChrome(container, {
    providerClass: 'cf',
    logo: PROVIDER_LOGOS.curseforge,
    title: 'CurseForge',
    sub: 'Mods • Modpacks • Resource packs — the classic repository',
  });

  content.style.display = 'block';
  const viewHost = el('div');
  content.append(viewHost);

  const filters = { q: '', projectType: 'mod', gameVersion: '', categoryId: null, sortField: 2, loader: 0 };
  const view = { index: 0, hits: [], total: 0 };

  const hasKey = await api.invoke('curseforge:hasKey');
  if (!hasKey) { showKeyNotice(); return; }

  await showHome();

  /* ---------------- key notice (no fake data — honest state) ---------------- */
  function showKeyNotice() {
    viewHost.innerHTML = '';
    const keyInput = el('input', { class: 'input', placeholder: 'Paste your CurseForge API key here…' });
    viewHost.append(
      el('div', { class: 'key-notice animate-fade-up' },
        el('div', { class: 'big-icon', html: ICONS.key }),
        el('h2', { text: 'A CurseForge API key is needed' }),
        el('p', { text: 'CurseForge requires every app to use its own free API key (unlike Modrinth, whose API is open). It takes ~3 minutes to get one:' }),
        el('ol', {},
          el('li', { text: 'Go to console.curseforge.com and sign in with a CurseForge account.' }),
          el('li', { text: 'Create an API client (any name) — no verification needed for personal use.' }),
          el('li', { text: 'Copy the generated key and paste it below.' })),
        keyInput,
        el('button', {
          class: 'btn primary', style: { marginTop: '14px' }, text: 'Save key & open CurseForge',
          onclick: async (e) => {
            // strip stray whitespace/quotes people accidentally copy around the key
            const v = keyInput.value.trim().replace(/^["']|["']$/g, '');
            if (!v) { toast('Key required', 'Paste the key from console.curseforge.com', { type: 'warn' }); return; }
            const btn = e.target;
            btn.disabled = true; btn.textContent = 'Validating key…';
            try {
              await saveSettings({ cfApiKey: v });
              await api.invoke('curseforge:validate');
              toast('Key saved', 'CurseForge connection verified.');
              const { navigate } = await import('../router.js');
              navigate('curseforge', { forward: false });
            } catch (err) {
              toast('CurseForge rejected this key', err.message, { type: 'warn', timeout: 10000 });
              btn.disabled = false; btn.textContent = 'Save key & open CurseForge';
            }
          },
        }),
        el('p', { class: 'hint', style: { marginTop: '16px' }, text: 'You can also set it later in Settings → Integrations.' }),
      ),
    );
  }

  /* ---------------- home ---------------- */
  async function showHome() {
    viewHost.innerHTML = '';
    const search = el('input', { placeholder: 'Search CurseForge…' });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { filters.q = search.value.trim(); showSearch(); }
    });
    viewHost.append(el('div', { class: 'store-search', style: { marginBottom: '18px', maxWidth: '760px', margin: '0 auto 22px' } },
      el('div', { class: 'search-field' }, el('span', { style: { color: 'var(--faint)' }, html: ICONS.search }), search)));

    const featuredWrap = el('div', { class: 'store-rows' });
    viewHost.append(el('div', { class: 'store-featured' }, el('h3', { text: 'Most downloaded this week' }), featuredWrap));
    try {
      const res = await api.invoke('curseforge:search', { projectType: 'mod', sortField: 6, pageSize: 10 });
      featuredWrap.append(renderRows(res.data || [], (m) => showProject(m.id)));
    } catch (e) {
      featuredWrap.append(el('div', { class: 'empty-state' }, el('h3', { text: 'Could not reach CurseForge' }), el('p', { text: e.message })));
    }
  }

  /* ---------------- search ---------------- */
  async function showSearch() {
    viewHost.innerHTML = '';
    view.index = 0; view.hits = []; view.total = 0;

    const search = el('input', { placeholder: 'Search CurseForge…', value: filters.q });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { filters.q = search.value.trim(); refresh(); }
    });
    const sortSel = el('select', { class: 'store-sort' }, ...SORTS.map(s => el('option', { value: s.id, text: 'Sort: ' + s.label })));
    sortSel.value = filters.sortField;
    sortSel.addEventListener('change', () => { filters.sortField = Number(sortSel.value); refresh(); });

    const searchRow = el('div', { class: 'store-search' },
      el('div', { class: 'search-field' }, el('span', { style: { color: 'var(--faint)' }, html: ICONS.search }), search), sortSel);

    /* sidebar: types + categories + game version */
    const typeChips = el('div', { class: 'filter-chips' });
    for (const t of PROJECT_TYPES) {
      typeChips.append(el('span', {
        class: `fchip ${filters.projectType === t.id ? 'on' : ''}`, text: t.label,
        onclick: () => { filters.projectType = t.id; filters.categoryId = null; showSearch(); },
      }));
    }
    const gvInput = el('input', { class: 'input', placeholder: 'e.g. 1.21.4', value: filters.gameVersion, style: { padding: '8px 10px', fontSize: '12.5px' } });
    gvInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { filters.gameVersion = gvInput.value.trim(); refresh(); } });

    const catWrap = el('div', { class: 'filter-chips' });
    api.invoke('curseforge:categories', { classId: CLASS_IDS[filters.projectType] }).then(cats => {
      catWrap.innerHTML = '';
      for (const c of (cats || []).slice(0, 26)) {
        catWrap.append(el('span', {
          class: `fchip ${filters.categoryId === c.id ? 'on' : ''}`, text: c.name,
          onclick: () => { filters.categoryId = filters.categoryId === c.id ? null : c.id; refresh(); },
        }));
      }
    }).catch(() => {});

    const sidebar = el('div', { class: 'store-filters' },
      el('div', { class: 'card', style: { padding: '14px', display: 'flex', flexDirection: 'column', gap: '16px', background: 'var(--store-panel, var(--panel))' } },
        el('div', { class: 'filter-group' }, el('h4', { text: 'Project type' }), typeChips),
        el('div', { class: 'filter-group' }, el('h4', { text: 'Game version' }), gvInput),
        el('div', { class: 'filter-group' }, el('h4', { text: 'Categories' }), catWrap),
      ),
    );

    const results = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
    viewHost.append(el('div', { class: 'store-layout' }, sidebar,
      el('div', { class: 'store-main' }, searchRow, results)));

    async function refresh() {
      results.innerHTML = '';
      results.append(skeletonRows());
      try {
        const res = await api.invoke('curseforge:search', {
          q: filters.q, projectType: filters.projectType,
          gameVersion: filters.gameVersion || null,
          categoryId: filters.categoryId,
          sortField: filters.sortField, index: view.index, pageSize: 20,
        });
        view.total = res.pagination?.total || (res.data || []).length;
        view.hits = res.data || [];
        results.innerHTML = '';
        results.append(el('div', { style: { color: 'var(--muted)', fontSize: '12.5px' } },
          el('b', { text: `${fmtNum(view.total)} results`, style: { color: 'var(--text)' } })));
        results.append(renderRows(view.hits, (m) => showProject(m.id)));
        if (view.index + 20 < view.total) {
          results.append(loadMoreBtn(() => { view.index += 20; refresh(); }));
        }
      } catch (e) {
        results.innerHTML = '';
        if (e.message === 'CF_API_KEY_MISSING') showKeyNotice();
        else results.append(el('div', { class: 'empty-state' }, el('h3', { text: 'Search failed' }), el('p', { text: e.message })));
      }
    }
    await refresh();
  }

  /* ---------------- project page ---------------- */
  async function showProject(modId) {
    viewHost.innerHTML = '';
    const loading = el('div', { style: { display: 'flex', justifyContent: 'center', padding: '60px' } }, el('span', { class: 'spinner large' }));
    viewHost.append(loading);
    let mod, description, files;
    try {
      [mod, description, files] = await Promise.all([
        api.invoke('curseforge:mod', { id: modId }),
        api.invoke('curseforge:description', { id: modId }),
        api.invoke('curseforge:files', { id: modId }),
      ]);
    } catch (e) {
      loading.replaceWith(el('div', { class: 'empty-state' }, el('h3', { text: 'Failed to load project' }), el('p', { text: e.message })));
      return;
    }
    const m = mod.data || mod;
    viewHost.innerHTML = '';

    const backToSearch = el('button', { class: 'btn small ghost', html: `${ICONS.back} <span style="margin-left:6px">Back to search</span>`, onclick: () => showSearch() });

    const installBtn = el('button', { class: 'install-btn', html: `${ICONS.download} Download latest` });
    const latestFile = (files.data || files || [])[0];
    if (latestFile) {
      installBtn.addEventListener('click', () => {
        installFlow({
          provider: 'CurseForge',
          doInstall: (target) => api.invoke('curseforge:install', {
            mod: m, file: latestFile, projectType: m.classId === 4471 ? 'modpack' : (m.classId === 12 ? 'resourcepack' : 'mod'), target,
          }),
        });
      });
    } else installBtn.disabled = true;

    const stats = el('div', { class: 'proj-stats' },
      el('span', { class: 'stat-chip', html: `${ICONS.download} <b>${fmtNum(m.downloadCount)}</b> downloads` }),
      el('span', { class: 'stat-chip', text: `Updated ${timeAgo(new Date(m.dateModified).getTime())}` }),
      el('span', { class: 'stat-chip', text: `Created ${fmtDate(new Date(m.dateCreated).getTime())}` }),
    );

    const tabs = el('div', { class: 'proj-tabs' });
    const tabBody = el('div');
    let activeTab = 'description';
    const renderTabs = () => {
      tabs.innerHTML = '';
      for (const [id, label] of [['description', 'Description'], ['files', 'Files']]) {
        tabs.append(el('button', {
          class: `proj-tab ${id === activeTab ? 'active' : ''}`, text: label,
          onclick: () => { activeTab = id; renderTabs(); renderTab(); },
        }));
      }
    };
    const renderTab = () => {
      tabBody.innerHTML = '';
      if (activeTab === 'description') {
        tabBody.append(el('div', { class: 'proj-desc', html: sanitizeHTML((description.data || description || '<p>No description.</p>')) }));
      } else {
        const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
        for (const f of (files.data || files || []).slice(0, 25)) {
          list.append(el('div', { class: 'version-row' },
            el('span', { class: 'v-num', text: f.displayName || f.fileName }),
            el('div', { class: 'v-chips' },
              el('span', { class: 'vchip', text: f.gameVersions.slice(-2).join(' / ') }),
              (f.gameVersions.some(g => g.toLowerCase().includes('fabric')) ? el('span', { class: 'vchip loader', text: 'fabric' }) : null),
              (f.gameVersions.some(g => g.toLowerCase().includes('neoforge')) ? el('span', { class: 'vchip loader', text: 'neoforge' }) : null),
              (f.gameVersions.some(g => g.toLowerCase().includes('forge')) ? el('span', { class: 'vchip loader', text: 'forge' }) : null),
            ),
            el('span', { class: 'v-date', text: fmtDate(new Date(f.fileDate).getTime()) }),
            el('button', {
              class: 'btn small primary', html: `${ICONS.download} ${fmtBytes(f.fileLength)}`,
              onclick: () => installFlow({
                provider: 'CurseForge',
                doInstall: (target) => api.invoke('curseforge:install', {
                  mod: m, file: f, projectType: m.classId === 4471 ? 'modpack' : (m.classId === 12 ? 'resourcepack' : 'mod'), target,
                }),
              }),
            }),
          ));
        }
        tabBody.append(list);
      }
    };
    renderTabs(); renderTab();

    viewHost.append(
      backToSearch,
      el('div', { class: 'proj-header', style: { marginTop: '14px' } },
        iconImg(m.logo?.thumbnailUrl, initialsOf(m.name), 'proj-icon'),
        el('div', { class: 'proj-head-main' },
          el('div', { class: 'proj-title', text: m.name }),
          el('div', { class: 'proj-byline', html: `by <b>${m.authors?.[0]?.name || 'unknown'}</b> • ${m.slug}` }),
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
            ...(m.categories || []).slice(0, 5).map(c => el('span', { class: 'chip', text: c.name }))),
          stats,
        ),
        el('div', { class: 'proj-actions' }, installBtn),
      ),
      tabs, tabBody,
    );
  }

  /* ---------------- render helpers ---------------- */
  function renderRows(mods, openFn) {
    const rows = el('div', { class: 'store-rows stagger' });
    if (!mods?.length) rows.append(el('div', { class: 'empty-state' }, el('h3', { text: 'Nothing found' })));
    for (const m of mods) {
      rows.append(el('div', { class: 'project-row', onclick: () => openFn(m.id) },
        iconImg(m.logo?.thumbnailUrl, initialsOf(m.name)),
        el('div', { class: 'p-main' },
          el('div', { class: 'p-title', text: m.name }),
          el('div', { class: 'p-author', text: 'by ' + (m.authors?.[0]?.name || m.slug) }),
          el('div', { class: 'p-desc', text: m.summary || '' }),
        ),
        el('div', { class: 'p-side' },
          el('span', { class: 'p-dl', text: fmtNum(m.downloadCount) }),
          el('span', { text: timeAgo(new Date(m.dateModified).getTime()) }),
        ),
      ));
    }
    return rows;
  }

  function skeletonRows() {
    const rows = el('div', { class: 'store-rows' });
    for (let i = 0; i < 7; i++) {
      rows.append(el('div', { class: 'project-row' },
        el('div', { class: 'skeleton', style: { width: '58px', height: '58px', borderRadius: '9px' } }),
        el('div', { style: { flex: '1' } },
          el('div', { class: 'skeleton', style: { height: '14px', width: '40%', marginBottom: '8px' } }),
          el('div', { class: 'skeleton', style: { height: '11px', width: '80%' } })),
      ));
    }
    return rows;
  }
}

function initialsOf(title) { return (title || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
