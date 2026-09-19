// store-common.js — shared chrome + install flow for the Modrinth storefront.
// Install flow asks: WHICH file version (with search + loader + game-version
// filters), WHERE (instance / global / SERVER / brand-new instance), then
// downloads with a live progress toast (via the engine's install:progress
// events — callbacks can never be passed through IPC, objects must be cloneable).
//
// SMART INSTALL: when the user has EXACTLY ONE instance and it is modded
// (fabric/forge/neoforge/quilt), the launcher auto-detects its loader + game
// version, auto-selects the latest WORKING file version and installs with a
// single click — no modal. With more than one instance (or a vanilla-only
// instance) the normal picker is shown, as requested.
import { el, ICONS, fmtDate, fmtNum } from '../utils.js';
import { state, api, refreshInstances, selectInstance } from '../state.js';
import { progressToast, toast } from '../components/toast.js';
import { openModal } from '../components/modal.js';

const PLUGIN_SERVER_TYPES = ['paper', 'spigot', 'purpur', 'folia'];
const MODDED_SERVER_TYPES = ['fabric', 'forge', 'neoforge', 'quilt'];
const NEW_INSTANCE_LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'];

/**
 * Build the page chrome: hero (back button + logo + title) and body container.
 * Returns { body, content } — body is a scrollable .store-body.
 */
export function buildStoreChrome(container, { providerClass, logo, title, sub, targetOverride = null }) {
  const content = el('div', { class: 'store-layout' });
  const body = el('div', { class: 'store-body' });
  const backBtn = el('button', { class: 'back-btn', html: `${ICONS.back} <span>Back to Play</span>` });
  backBtn.addEventListener('click', () => {
    import('../router.js').then(r => r.navigate('home', { forward: false }));
  });

  const hero = el('div', { class: 'store-hero' },
    backBtn,
    el('div', {},
      el('h1', {}, el('span', { class: 'hero-logo', html: logo }), title),
      el('div', { class: 'hero-sub', text: sub }),
    ),
    el('div', { class: 'hero-right' }, targetOverride || targetPill()),
  );

  body.append(content);
  container.classList.add('store-page');
  container.append(hero, body);
  return { body, content };
}

export function targetPill(serverId = null) {
  if (serverId) {
    const srv = state.servers.find(s => s.id === serverId);
    if (srv) {
      return el('span', { class: 'target-pill server', title: 'Content installs into this server' },
        el('span', { class: 'dot' }),
        el('span', { class: 'pill-ico', html: ICONS.server }),
        `${srv.name} (${srv.type} ${srv.version})`);
    }
  }
  const sel = state.settings?.selectedInstanceId;
  const inst = state.instances.find(i => i.id === sel);
  const label = inst ? inst.name : 'Global .minecraft';
  return el('span', { class: 'target-pill', title: 'Install target — change in INSTANCE menu' },
    el('span', { class: 'dot' }),
    el('span', { class: 'pill-ico', html: inst ? ICONS.box : ICONS.globe }),
    label);
}

export function iconImg(src, initials, cls = 'p-icon') {
  if (!src) return el('div', { class: `${cls} ph`, text: initials });
  const img = el('img', { class: cls, src, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: `${cls} ph`, text: initials })));
  return img;
}

/* ------------------------------------------------------------------ */
/*  Smart install helpers                                              */
/* ------------------------------------------------------------------ */

/** The single modded instance — only exists when there is EXACTLY ONE instance and it's modded. */
export function singleModdedInstance() {
  if (!state.instances || state.instances.length !== 1) return null; // >1 instance → never auto
  const inst = state.instances[0];
  if (!inst.loader || inst.loader === 'vanilla') return null;        // must be modded
  return inst;
}

/**
 * Renderer-side "latest working version" picker (mirror of the engine's
 * pickBestVersion). Modrinth lists versions newest-first, so the FIRST match
 * is the latest. loaderOnly types (resourcepack/shader) ignore loaders.
 */
export function pickBestVersion(versions, { loader = null, gameVersion = null } = {}) {
  const list = Array.isArray(versions) ? versions.filter(Boolean) : [];
  if (!list.length) return null;
  const hasLoader = (v) => !loader || !(v.loaders || []).length || (v.loaders || []).includes(loader);
  const hasGame = (v) => !gameVersion || !(v.game_versions || []).length || (v.game_versions || []).includes(gameVersion);
  return list.find(v => hasLoader(v) && hasGame(v))
      || list.find(v => hasGame(v))
      || list.find(v => hasLoader(v))
      || list[0];
}

/** Does this version actually work for the given instance? */
export function versionCompatible(version, inst, projectType) {
  if (!version || !inst) return false;
  const gv = version.game_versions || [];
  if (gv.length && !gv.includes(inst.version)) return false;
  if (projectType === 'mod') {
    const ls = version.loaders || [];
    if (ls.length && !ls.includes(inst.loader)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Version filter bar (search + loader + game version)                */
/* ------------------------------------------------------------------ */

/**
 * Searchable / filterable toolbar for a list of Modrinth version objects.
 * Mutates `filterState` { q, loader, gv } and calls onChange after any edit.
 */
export function versionFilterBar(vlist, filterState, onChange, { compact = false } = {}) {
  const loaders = [...new Set(vlist.flatMap(v => v.loaders || []))].filter(Boolean);
  const gameVersions = [...new Set(vlist.flatMap(v => v.game_versions || []))].filter(Boolean);

  const search = el('input', {
    class: 'input', placeholder: 'Search versions…', value: filterState.q || '',
    style: { padding: compact ? '6px 9px' : '8px 10px', fontSize: '12.5px' },
  });
  search.addEventListener('input', () => { filterState.q = search.value.trim().toLowerCase(); onChange(); });
  search.addEventListener('keydown', (e) => e.stopPropagation());

  const loaderSel = el('select', { class: 'input', style: { padding: compact ? '6px 9px' : '8px 10px', fontSize: '12.5px' } },
    el('option', { value: '', text: 'Any loader' }),
    ...loaders.map(l => el('option', { value: l, text: l })));
  loaderSel.value = filterState.loader || '';
  loaderSel.addEventListener('change', () => { filterState.loader = loaderSel.value; onChange(); });

  const gvSel = el('select', { class: 'input', style: { padding: compact ? '6px 9px' : '8px 10px', fontSize: '12.5px' } },
    el('option', { value: '', text: 'Any game version' }),
    ...gameVersions.slice(0, 80).map(g => el('option', { value: g, text: g })));
  if (!gameVersions.includes(filterState.gv || '') && filterState.gv) {
    gvSel.append(el('option', { value: filterState.gv, text: filterState.gv }));
  }
  gvSel.value = filterState.gv || '';
  gvSel.addEventListener('change', () => { filterState.gv = gvSel.value; onChange(); });

  return el('div', { class: 'pick-toolbar' },
    el('div', { class: 'search-field' }, el('span', { style: { color: 'var(--faint)' }, html: ICONS.search }), search),
    loaderSel, gvSel,
  );
}

/** Apply a filterState to a version list. */
export function applyVersionFilters(vlist, f) {
  let out = vlist;
  if (f.q) out = out.filter(v => (v.version_number || '').toLowerCase().includes(f.q) || (v.name || '').toLowerCase().includes(f.q));
  if (f.loader) out = out.filter(v => (v.loaders || []).includes(f.loader));
  if (f.gv) out = out.filter(v => (v.game_versions || []).includes(f.gv));
  return out;
}

/* ------------------------------------------------------------------ */
/*  Install flow                                                       */
/* ------------------------------------------------------------------ */

/** Pick the default file version: fixed id, else first one matching the target's MC version, else newest. */
function pickDefaultVersion(versions, fixedVersionId, inst) {
  if (fixedVersionId) {
    const f = versions.find(v => v.id === fixedVersionId);
    if (f) return f;
  }
  if (inst) {
    const c = versions.find(v => (v.game_versions || []).includes(inst.version));
    if (c) return c;
  }
  return versions[0] || null;
}

/** One selectable row in the version list. */
function versionRow(v, selected, onPick) {
  return el('div', {
    class: `pick-item ${selected ? 'selected' : ''}`,
    style: { display: 'block', padding: '9px 12px' },
    onclick: onPick,
  },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      el('b', { text: v.version_number, style: { fontSize: '13px' } }),
      el('span', { style: { marginLeft: 'auto', color: 'var(--muted)', fontSize: '11px' }, text: fmtDate(new Date(v.date_published).getTime()) }),
    ),
    el('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '5px' } },
      ...(v.loaders || []).map(l => el('span', { class: 'vchip loader', text: l })),
      ...(v.game_versions || []).slice(-2).map(g => el('span', { class: 'vchip', text: g })),
      (v.game_versions || []).length > 2 ? el('span', { class: 'vchip', text: `+${v.game_versions.length - 2}` }) : null,
    ),
  );
}

/** Which servers can take this content type? */
function serverEligible(srv, projectType) {
  const t = String(srv.type || '').toLowerCase();
  if (projectType === 'plugin') return PLUGIN_SERVER_TYPES.includes(t);
  if (projectType === 'mod') return MODDED_SERVER_TYPES.includes(t);
  return false;
}

/** New-instance mini form: name + MC version + loader (+ auto loader version). */
async function createInstanceFromModal({ suggestedName, suggestedVersion, suggestedLoader }) {
  const loader = suggestedLoader && NEW_INSTANCE_LOADERS.includes(suggestedLoader) ? suggestedLoader : 'vanilla';

  // fetch MC versions BEFORE showing the modal so the dropdown is ready
  let all = null;
  try { all = await api.invoke('versions:all'); } catch { /* offline — select stays minimal */ }

  const nameInput = el('input', { class: 'input', value: suggestedName || '', maxlength: '60', placeholder: 'Instance name…' });
  const mcSel = el('select', { class: 'input', style: { width: '100%' } });
  const loaderSel = el('select', { class: 'input', style: { width: '100%' } });
  for (const l of NEW_INSTANCE_LOADERS) {
    loaderSel.append(el('option', { value: l, text: l[0].toUpperCase() + l.slice(1) }));
  }
  loaderSel.value = loader;

  if (all) {
    const rel = el('optgroup', { label: 'Releases' });
    for (const v of (all.groups.Releases || []).slice(0, 300)) rel.append(el('option', { value: v.id, text: v.id }));
    const snap = el('optgroup', { label: 'Snapshots' });
    for (const v of (all.groups.Snapshots || []).slice(0, 120)) snap.append(el('option', { value: v.id, text: v.id }));
    mcSel.append(rel, snap);
    if (suggestedVersion) mcSel.value = suggestedVersion;
  }

  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    el('div', {}, el('label', { class: 'label', text: 'Instance name' }), nameInput),
    el('div', {}, el('label', { class: 'label', text: 'Minecraft version' }), mcSel),
    el('div', {}, el('label', { class: 'label', text: 'Loader' }), loaderSel),
    el('div', { class: 'hint', text: 'The newest compatible loader version is picked automatically — you can change it later on the instance.' }),
  );

  const ok = await new Promise((resolve) => {
    openModal({
      title: 'New instance',
      sub: 'Created instantly, then the content is installed into it.',
      body,
      actions: (close) => [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: () => { resolve(null); close(); } }),
        el('button', {
          class: 'btn primary', text: 'Create & install', onclick: () => {
            const name = nameInput.value.trim();
            const version = mcSel.value;
            if (!version) { toast('Pick a Minecraft version', 'No version list available right now.', { type: 'warn' }); return; }
            resolve({ name, version, loader: loaderSel.value });
            close();
          },
        }),
      ],
      onClose: () => resolve(null),
    });
  });

  return ok;
}

/**
 * Universal install flow.
 *  - versions:       optional array of Modrinth version objects (lets the user pick a specific one)
 *  - fixedVersionId: optional preselected version id (from the Versions tab rows)
 *  - projectType:    'mod' | 'plugin' | 'resourcepack' | 'shader' | 'modpack' — drives smart
 *                    install + server target eligibility
 *  - presetTarget:   { type:'server', serverId } when entering from the Servers page
 *  - doInstall:      (target, versionObj) => Promise<installResult>
 */
export async function installFlow({
  provider, doInstall, versions = null, fixedVersionId = null,
  projectName = '', projectType = null, presetTarget = null,
}) {
  const vlist = Array.isArray(versions) ? versions : [];

  /* ---- state shared between the two pickers ---- */
  let chosenVersion = pickDefaultVersion(vlist, fixedVersionId, state.instances.find(i => i.id === state.settings?.selectedInstanceId) || null);
  let chosenTarget = presetTarget && presetTarget.type === 'server' && state.servers.find(s => s.id === presetTarget.serverId)
    ? { ...presetTarget, loader: state.servers.find(s => s.id === presetTarget.serverId).type, version: state.servers.find(s => s.id === presetTarget.serverId).version }
    : null;
  const verFilter = { q: '', loader: '', gv: '' };

  const targetIsSelected = (kind, id) =>
    !!chosenTarget && chosenTarget.type === kind && (kind === 'global' || chosenTarget.instanceId === id || (kind === 'server' && chosenTarget.serverId === id));

  /* ---- SMART INSTALL: one modded instance → one click, no modal ---- */
  if (projectType !== 'plugin' && projectType !== 'modpack') {
    const inst = singleModdedInstance();
    if (inst) {
      const smartVersion = fixedVersionId
        ? (vlist.find(v => v.id === fixedVersionId) || null)
        : pickBestVersion(vlist, {
            loader: projectType === 'mod' ? inst.loader : null,
            gameVersion: inst.version,
          });
      const ok = smartVersion && (vlist.length ? versionCompatible(smartVersion, inst, projectType) : true);
      if (ok) {
        toast('Smart install',
          `${projectName || 'Content'} ${smartVersion ? smartVersion.version_number : ''} → ${inst.name} (${inst.loader} ${inst.version}) — auto-detected your only modded instance`);
        return runInstall(provider, doInstall, {
          type: 'instance', instanceId: inst.id, loader: inst.loader, version: inst.version,
        }, smartVersion);
      }
      // not compatible → fall through to the full picker below
    }
  }

  /* ---- target list (instances + global + SERVERS + create new) ---- */
  function buildTargetList(container, rerender) {
    container.append(
      el('div', { class: `pick-item ${targetIsSelected('global') ? 'selected' : ''}`, onclick: () => { chosenTarget = { type: 'global' }; rerender(); } },
        el('span', { class: 'pick-ico', html: ICONS.globe }),
        el('div', {}, el('b', { text: 'Global .minecraft' }), el('span', { style: { display: 'block' }, text: 'Shared across all versions' })),
      ),
    );
    for (const inst of state.instances) {
      const compat = chosenVersion ? (chosenVersion.game_versions || []).includes(inst.version) : true;
      container.append(
        el('div', { class: `pick-item ${targetIsSelected('instance', inst.id) ? 'selected' : ''}`, onclick: () => { chosenTarget = { type: 'instance', instanceId: inst.id, loader: inst.loader, version: inst.version }; rerender(); } },
          el('span', { class: 'pick-ico', html: ICONS.box }),
          el('div', {}, el('b', { text: inst.name }),
            el('span', { style: { display: 'block' }, text: `${inst.version} • ${inst.loader}` }),
            chosenVersion && !compat ? el('span', { style: { display: 'block', color: 'var(--warn, #f59e0b)', fontSize: '11px' }, text: 'this file does not list this MC version' }) : null,
          ),
        ),
      );
    }

    // ---- servers (plugins + mods) ----
    const wantServers = projectType === 'plugin' || projectType === 'mod';
    if (wantServers) {
      const eligible = state.servers.filter(s => serverEligible(s, projectType));
      container.append(el('div', { class: 'pick-section', text: projectType === 'plugin' ? 'Servers (plugins)' : 'Servers (mods)' }));
      if (!state.servers.length) {
        container.append(el('div', { class: 'pick-hint', text: 'You have no servers yet — create one with + NEW SERVER, then install content straight into it.' }));
      } else if (!eligible.length) {
        container.append(el('div', { class: 'pick-hint', text: projectType === 'plugin'
          ? 'Plugins need a Paper / Spigot / Purpur / Folia server.'
          : 'Server mods need a Fabric / Forge / NeoForge / Quilt server.' }));
      }
      for (const srv of eligible) {
        const compat = chosenVersion ? (chosenVersion.game_versions || []).includes(srv.version) : true;
        container.append(
          el('div', { class: `pick-item ${targetIsSelected('server', srv.id) ? 'selected' : ''}`, onclick: () => { chosenTarget = { type: 'server', serverId: srv.id, loader: srv.type, version: srv.version }; rerender(); } },
            el('span', { class: 'pick-ico', html: ICONS.server }),
            el('div', {}, el('b', { text: srv.name }),
              el('span', { style: { display: 'block' }, text: `${srv.type} • ${srv.version}` }),
              chosenVersion && !compat ? el('span', { style: { display: 'block', color: 'var(--warn, #f59e0b)', fontSize: '11px' }, text: 'this file does not list this server MC version' }) : null,
            ),
          ),
        );
      }
    }

    container.append(
      el('div', { class: 'pick-item', onclick: async () => {
        const def = chosenVersion || {};
        const created = await createInstanceFromModal({
          suggestedName: projectName,
          suggestedVersion: (def.game_versions || [])[0] || null,
          suggestedLoader: (def.loaders || [])[0] || 'vanilla',
        });
        if (!created || !created.version) return;
        const pt = progressToast('Creating instance…', true);
        try {
          const inst = await api.invoke('instances:create', {
            name: created.name || 'Instance', version: created.version,
            loader: created.loader, loaderVersion: null, memoryMB: state.settings?.memoryMB || 2048,
          });
          await refreshInstances();
          await selectInstance(inst.id); // keep play-target in sync with the engine's auto-select
          pt.done('Instance created');
          toast('Instance created', `${inst.name} • ${created.version} • ${created.loader}`);
          chosenTarget = { type: 'instance', instanceId: inst.id, loader: created.loader, version: created.version };
          rerender();
        } catch (e) {
          pt.fail('Failed');
          toast('Could not create instance', e.message, { type: 'error' });
        }
      } },
        el('span', { class: 'pick-ico', html: el('b', { text: '+', style: { fontSize: '17px' } }) }),
        el('div', {}, el('b', { text: 'Create new instance…' }), el('span', { style: { display: 'block' }, text: 'Pick its Minecraft version & loader' })),
      ),
    );
  }

  /* ---- resolve missing pieces ---- */
  if (!vlist.length) {
    // no version metadata (e.g. quick install) — only ask for the target
    const target = await new Promise((resolve) => {
      let m;
      const list = el('div', { class: 'pick-list' });
      const rerender = () => {
        if (chosenTarget) { resolve(chosenTarget); m.close(); return; } // resolve FIRST — close() fires onClose (cancel) and must not win
        list.innerHTML = '';
        buildTargetList(list, rerender);
      };
      rerender();
      m = openModal({ title: 'Install to…', sub: 'Choose where this content should be installed.', body: list });
    });
    return runInstall(provider, doInstall, target, null);
  }

  /* ---- full picker: filterable version list + target list ---- */
  const target = await new Promise((resolve) => {
    let m;
    const verList = el('div', { class: 'pick-list', style: { maxHeight: '210px', overflowY: 'auto' } });
    const targetList = el('div', { class: 'pick-list', style: { maxHeight: '250px', overflowY: 'auto' } });

    const renderVerList = () => {
      const filtered = applyVersionFilters(vlist, verFilter);
      verList.innerHTML = '';
      if (!filtered.length) {
        verList.append(el('div', { class: 'pick-hint', text: 'No versions match these filters.' }));
        return;
      }
      for (const v of filtered.slice(0, 60)) {
        verList.append(versionRow(v, chosenVersion && v.id === chosenVersion.id, () => {
          chosenVersion = v;
          renderVerList();
          buildTargetList(targetList, rerender); // compat hints may change
        }));
      }
      if (filtered.length > 60) verList.append(el('div', { class: 'pick-hint', text: `Showing 60 of ${fmtNum(filtered.length)} matching versions — refine your filters.` }));
    };
    const rerender = () => {
      renderVerList();
      targetList.innerHTML = '';
      buildTargetList(targetList, rerender);
    };

    const toolbar = versionFilterBar(vlist, verFilter, rerender, { compact: true });
    rerender();

    const confirm = () => {
      if (!chosenTarget) { toast('Choose a destination', 'Pick an instance, global .minecraft, a server, or create a new one.', { type: 'warn' }); return; }
      resolve(chosenTarget); // resolve FIRST — m.close() triggers onClose (cancel) which must not overwrite the result
      m.close();
    };

    m = openModal({
      title: 'Install options',
      sub: 'Search and filter the file versions, then pick where to install.',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        el('div', {}, el('label', { class: 'label', text: 'Version' }), toolbar, verList),
        el('div', {}, el('label', { class: 'label', text: 'Install to' }), targetList),
      ),
      actions: (close) => [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
        el('button', { class: 'btn primary', text: 'Install', onclick: confirm }),
      ],
      onClose: () => resolve(null),
    });
  });

  if (!target) return null;
  return runInstall(provider, doInstall, target, chosenVersion);
}

/** Shared download+progress runner. */
async function runInstall(provider, doInstall, target, versionObj) {
  const pt = progressToast(`Installing from ${provider}…`, true);
  const key = (provider || '').toLowerCase();
  const unsub = api.on('install:progress', (p) => {
    if (!p || (p.provider || '').toLowerCase() !== key) return;
    if (p.status) pt.status(p.status);
    else if (p.count != null || p.done != null) pt.count(p.done || 0, p.count || 0, p.file || '');
    else if (p.received != null) pt.update(p.received || 0, p.total || 0, 'Downloading…');
  });
  try {
    const res = await doInstall(target, versionObj);
    pt.done('Installed');
    const where = target.type === 'instance' ? 'instance'
      : target.type === 'server' ? 'server' : 'global .minecraft';
    toast('Installed',
      res?.file ? `${res.file} → ${where}`
      : res?.files != null ? `${res.files} files → ${where}`
      : 'Done');
    return res;
  } catch (e) {
    pt.fail('Failed');
    toast('Install failed', e.message, { type: 'error' });
    return null;
  } finally {
    unsub();
  }
}

export function loadMoreBtn(onClick, spinning = false) {
  return el('div', { class: 'store-loadmore' },
    el('button', { class: 'btn', onclick: onClick, innerHTML: spinning ? '<span class="spinner"></span>' : 'Load more' }),
  );
}

export function skeletonCards(n = 8) {
  const wrap = el('div', { class: 'store-grid' });
  for (let i = 0; i < n; i++) {
    wrap.append(el('div', { class: 'project-card' },
      el('div', { class: 'p-head' },
        el('div', { class: 'skeleton', style: { width: '52px', height: '52px', borderRadius: '11px' } }),
        el('div', { style: { flex: '1' } },
          el('div', { class: 'skeleton', style: { height: '14px', width: '70%', marginBottom: '8px' } }),
          el('div', { class: 'skeleton', style: { height: '11px', width: '40%' } })),
      ),
      el('div', { class: 'skeleton', style: { height: '34px' } }),
    ));
  }
  return wrap;
}
