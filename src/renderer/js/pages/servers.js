// servers.js — Servers manager: left list, right details + console + files inspector (NBT editor)
import { el, $, fmtBytes, ICONS } from '../utils.js';
import { api, state, refreshServers } from '../state.js';
import { toast } from '../components/toast.js';
import { confirmModal } from '../components/modal.js';

let selectedId = null;
let pageEls = null; // live DOM refs for the open page

const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);

const fmtUptime = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};

export async function buildServers(container, params = {}) {
  if (params.select) selectedId = params.select;
  /* Run-state + console are OWNED BY THE ENGINE (main process). This page only
     mirrors them — hydrated on every build from servers:runtime / servers:log,
     then kept fresh via server:event. That is why a running server now still
     shows RUNNING (with its console) after the logo → dashboard → servers
     round-trip, instead of looking stopped with an empty console. */
  const running = new Set();
  let startedAt = {};      // serverId -> epoch ms (from servers:runtime + events)
  let logBuffer = [];      // console lines of the SELECTED server
  let logServerId = null;  // which server logBuffer currently belongs to
  let uptimeText = null;   // live "RUNNING · 4m 12s" text (when a server is up)
  let currentPath = '';

  const syncRunning = () => {
    running.clear();
    for (const id of state.runningServers || []) running.add(id);
  };

  /* ---------------- left: list ---------------- */
  const listEl = el('div', { class: 'stagger', style: { display: 'flex', flexDirection: 'column', gap: '10px', overflowY: 'auto', flex: '1' } });
  const renderList = () => {
    listEl.innerHTML = '';
    if (!state.servers.length) {
      listEl.append(el('div', { class: 'empty-state' },
        el('div', { class: 'icon', html: ICONS.server }),
        el('h3', { text: 'No servers yet' }),
        el('p', { text: 'Create your first server with "+ NEW SERVER" in the top bar.' }),
      ));
      return;
    }
    for (const s of state.servers) {
      const isRunning = running.has(s.id);
      listEl.append(el('div', {
        class: `server-item ${s.id === selectedId ? 'selected' : ''}`,
        onclick: () => { selectedId = s.id; renderList(); renderDetails(); },
      },
        el('div', { class: 's-avatar', text: (s.name || 'S').slice(0, 2).toUpperCase() }),
        el('div', { class: 's-meta' },
          el('b', { text: s.name }),
          el('span', { text: `${cap(s.type)} • ${s.version} • port ${s.port}` }),
        ),
        el('div', { class: `s-status ${isRunning ? 'running' : 'stopped'}`, title: isRunning ? 'Running' : 'Stopped' }),
      ));
    }
  };
  renderList();

  /* ---------------- right: details ---------------- */
  const detailsEl = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', flex: '1', minHeight: '0' } });

  /* console */
  const consoleEl = el('div', { class: 'console' });
  const consoleInput = el('input', { class: 'input', placeholder: 'Type a command (e.g. list, say hi, stop)…' });
  const sendBtn = el('button', { class: 'btn small primary', text: 'Send' });
  const doSend = async () => {
    const cmd = consoleInput.value.trim();
    if (!cmd) return;
    try { await api.invoke('servers:command', { id: selectedId, command: cmd }); consoleInput.value = ''; }
    catch (e) { toast('Console', e.message, { type: 'warn' }); }
  };
  sendBtn.addEventListener('click', doSend);
  consoleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

  const renderConsole = () => {
    consoleEl.innerHTML = '';
    if (!logBuffer.length) {
      consoleEl.append(el('div', { class: 'log-line', style: { color: 'var(--faint)' }, text: '— console output appears here — history is kept even after you navigate away or restart the launcher —' }));
    }
    for (const l of logBuffer.slice(-250)) {
      consoleEl.append(el('div', { class: `log-line ${l.level}`, text: l.line }));
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  };

  /** Pull the console history for `id` straight from the engine. */
  const loadLogs = async (id) => {
    logServerId = id;
    let logs = [];
    try { logs = ((await api.invoke('servers:log', { id })) || {}).logs || []; }
    catch { logs = []; }
    if (logServerId !== id) return; // user switched servers mid-load
    logBuffer = logs;
    renderConsole();
  };

  /* console toolbar — Copy + Clear (Clear wipes the engine's saved history too) */
  const copyBtn = el('button', { class: 'btn small ghost', title: 'Copy the whole console to the clipboard', text: 'Copy' });
  copyBtn.addEventListener('click', async () => {
    const text = logBuffer.map(l => l.line).join('\n');
    if (!text) { toast('Console', 'Nothing to copy yet', { type: 'warn' }); return; }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.append(ta); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    ok ? toast('Console copied', `${logBuffer.length} lines are on your clipboard`, {})
       : toast('Copy failed', 'Select the console text manually instead', { type: 'warn' });
  });
  const clearBtn = el('button', { class: 'btn small ghost', title: 'Clear the console view AND the saved log file', text: 'Clear' });
  clearBtn.addEventListener('click', async () => {
    logBuffer = []; renderConsole();
    try { if (selectedId) await api.invoke('servers:clearLog', { id: selectedId }); } catch {}
    toast('Console cleared', '', {});
  });

  /* files inspector */
  const filesBody = el('div', { class: 'files-body' });
  const crumb = el('div', { class: 'files-crumb' });
  const editorWrap = el('div', { class: 'editor-area', style: { display: 'none' } });
  const editorTitle = el('div', { style: { padding: '8px 12px', fontSize: '12px', fontWeight: '700', color: 'var(--muted)' } });
  const editorStatus = el('div', { class: 'editor-status' });
  let editorTA = null;
  let saveTimer = null;

  const openTextEditor = async (filePath) => {
    try {
      const res = await api.invoke('files:readText', { scope: 'server', id: selectedId, path: filePath });
      editorWrap.style.display = 'flex';
      editorTitle.textContent = filePath;
      if (editorTA) editorTA.remove();
      editorTA = el('textarea', { class: 'textarea', style: { minHeight: '160px', border: 'none', borderRadius: '0', background: '#07080b' } });
      editorTA.value = res.content;
      editorWrap.append(editorTA, editorStatus);
      const setStatus = (saved) => {
        editorStatus.innerHTML = '';
        editorStatus.append(
          el('span', { class: `ed-status ${saved ? 'saved' : ''}` }, el('i', { class: 'dot' }), el('span', { text: saved ? 'Auto-saved' : 'Editing…' })),
          el('span', { text: `${fmtBytes(res.size)} — saves automatically 800ms after you stop typing` }),
        );
      };
      setStatus(true);
      editorTA.addEventListener('input', () => {
        setStatus(false);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          try {
            await api.invoke('files:writeText', { scope: 'server', id: selectedId, path: filePath, content: editorTA.value });
            setStatus(true);
          } catch (e) { toast('Auto-save failed', e.message, { type: 'error' }); }
        }, 800);
      });
    } catch (e) {
      // try NBT
      try {
        const nbt = await api.invoke('files:readNbt', { scope: 'server', id: selectedId, path: filePath });
        openNbtEditor(filePath, nbt);
      } catch (e2) {
        toast('Cannot open file', e.message !== 'ENOENT' ? e.message : e2.message, { type: 'warn' });
      }
    }
  };

  const openNbtEditor = (filePath, nbtData) => {
    editorWrap.style.display = 'flex';
    editorTitle.textContent = `${filePath} — NBT explorer`;
    if (editorTA) editorTA.remove();
    const tree = el('div', { class: 'nbt-tree' });
    const renderNode = (container, name, node, path) => {
      if (node && node.$compound) {
        const entries = Object.entries(node.$compound);
        container.append(el('div', { class: 'nbt-row' },
          el('span', { class: 'nbt-key', text: name || '(root)' }),
          el('span', { class: 'nbt-type', text: `compound {${entries.length}}` }),
        ));
        const child = el('div', { class: 'nbt-node' });
        for (const [k, v] of entries) renderNode(child, k, v.value, `${path}.${k}`, v.type, v);
        container.append(child);
      } else if (node && node.$list) {
        container.append(el('div', { class: 'nbt-row' },
          el('span', { class: 'nbt-key', text: name }),
          el('span', { class: 'nbt-type', text: `list[${node.$list.length}]` }),
        ));
        const child = el('div', { class: 'nbt-node' });
        node.$list.forEach((v, i) => renderNode(child, `[${i}]`, v, `${path}[${i}]`));
        container.append(child);
      } else {
        const val = node && node.$bytes ? `<${node.$bytes.length} bytes>`
          : node && node.$intarray ? `[${node.$intarray.length} ints]`
          : node && node.$longarray ? `[${node.$longarray.length} longs]`
          : String(node);
        const typeNum = node?.$bytes ? 7 : node?.$intarray ? 11 : node?.$longarray ? 12 : typeof node === 'number' ? (Number.isInteger(node) ? 3 : 6) : 8;
        const valSpan = el('span', { class: 'nbt-val editable', text: val, title: 'Click to edit' });
        valSpan.addEventListener('click', () => {
          const input = el('input', { class: 'input', style: { padding: '2px 8px', fontSize: '12px' }, value: val });
          valSpan.replaceWith(input);
          input.focus();
          const commit = async () => {
            let newVal = input.value;
            if (typeof node === 'number') {
              const n = Number(newVal);
              if (Number.isNaN(n)) { toast('Invalid number', `"${newVal}" is not a number`, { type: 'warn' }); newVal = val; }
              else newVal = n;
            }
            valSpan.textContent = typeof newVal === 'string' ? newVal : String(newVal);
            input.replaceWith(valSpan);
            try {
              // update the live tree and save
              setByPath(nbtData.tree, path, typeof node === 'number' ? Number(newVal) : String(newVal));
              await api.invoke('files:writeNbt', { scope: 'server', id: selectedId, path: filePath, data: { name: nbtData.name, tree: nbtData.tree } });
              toast('NBT saved', filePath, {});
            } catch (e) { toast('NBT save failed', e.message, { type: 'error' }); }
          };
          input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') commit();
            if (ev.key === 'Escape') input.replaceWith(valSpan);
          });
          input.addEventListener('blur', commit);
        });
        container.append(el('div', { class: 'nbt-row' },
          el('span', { class: 'nbt-key', text: name }),
          el('span', { class: 'nbt-type', text: tagLabel(typeNum) }),
          valSpan,
        ));
      }
    };
    renderNode(tree, nbtData.name || filePath, nbtData.tree, '');
    editorWrap.append(tree, editorStatus);
    editorStatus.innerHTML = '';
    editorStatus.append(
      el('span', { class: 'saved ed-status' }, el('i', { class: 'dot' }), el('span', { text: 'NBT editor' })),
      el('span', { text: 'Click a value to edit it — saved back to the .dat file automatically. Binary arrays are read-only.' }),
    );
  };

  const closeEditor = () => { editorWrap.style.display = 'none'; if (editorTA) { editorTA.remove(); editorTA = null; } };

  /** Decide how to open a file: NBT explorer for .dat/.nbt, text editor otherwise. */
  const openFile = async (filePath) => {
    const isNbt = /\.(dat|dat_old|nbt)$/.test(filePath);
    if (isNbt) {
      try {
        const nbtData = await api.invoke('files:readNbt', { scope: 'server', id: selectedId, path: filePath });
        openNbtEditor(filePath, nbtData);
      } catch (e) { toast('NBT error', e.message, { type: 'warn' }); }
      return;
    }
    await openTextEditor(filePath);
  };

  const renderFiles = async () => {
    closeEditor();
    filesBody.innerHTML = '';
    try {
      const res = await api.invoke('files:list', { scope: 'server', id: selectedId, path: currentPath });
      crumb.innerHTML = '';
      crumb.append(el('b', { text: 'server/' + (currentPath || '') }));
      if (!res.entries.length) {
        filesBody.append(el('div', { class: 'dd-empty', text: 'Empty folder' }));
      }
      if (currentPath) {
        filesBody.append(el('div', { class: 'file-row', onclick: () => { currentPath = currentPath.split('/').slice(0, -1).join('/'); renderFiles(); } },
          el('span', { class: 'f-icon', html: ICONS.up }), el('span', { class: 'f-name', text: '..' })));
      }
      for (const e of res.entries) {
        filesBody.append(el('div', {
          class: 'file-row',
          onclick: () => {
            const p = currentPath ? `${currentPath}/${e.name}` : e.name;
            if (e.type === 'dir') { currentPath = p; renderFiles(); }
            else openFile(p);
          },
        },
          el('span', { class: 'f-icon', html: e.type === 'dir' ? ICONS.folder : (/\.(dat|dat_old|nbt)$/.test(e.name) ? ICONS.box : ICONS.file) }),
          el('span', { class: 'f-name', text: e.name }),
          el('span', { class: 'f-size', text: e.type === 'file' ? fmtBytes(e.size) : '' }),
        ));
      }
    } catch (e) {
      filesBody.append(el('div', { class: 'dd-empty', text: e.message }));
    }
  };

  const newFileBtn = el('button', { class: 'btn small ghost', title: 'New file', text: '+ file' });
  const newDirBtn = el('button', { class: 'btn small ghost', title: 'New folder', text: '+ folder' });
  const refreshBtn = el('button', { class: 'icon-btn', title: 'Refresh', html: ICONS.refresh });
  const openBtn = el('button', { class: 'icon-btn', title: 'Open in system', html: ICONS.folder });
  newFileBtn.addEventListener('click', async () => {
    const name = prompt('New file name:');
    if (!name) return;
    await api.invoke('files:touch', { scope: 'server', id: selectedId, path: currentPath, name });
    renderFiles();
  });
  newDirBtn.addEventListener('click', async () => {
    const name = prompt('New folder name:');
    if (!name) return;
    await api.invoke('files:mkdir', { scope: 'server', id: selectedId, path: currentPath, name });
    renderFiles();
  });
  refreshBtn.addEventListener('click', renderFiles);
  openBtn.addEventListener('click', () => api.invoke('files:openInSystem', { scope: 'server', id: selectedId }));

  const filesWrap = el('div', { class: 'card files-wrap', style: { padding: '0', overflow: 'hidden' } },
    el('div', { class: 'files-toolbar' },
      crumb, refreshBtn, newFileBtn, newDirBtn, openBtn,
    ),
    filesBody,
    editorWrap,
  );

  /* details render */
  const renderDetails = () => {
    detailsEl.innerHTML = '';
    const s = state.servers.find(x => x.id === selectedId);
    if (!s) {
      detailsEl.append(el('div', { class: 'empty-state', style: { marginTop: '40px' } },
        el('div', { class: 'icon', html: ICONS.server }),
        el('h3', { text: 'Select a server' }),
        el('p', { text: 'Pick a server on the left to see details, live console and its files.' }),
      ));
      return;
    }
    const isRunning = running.has(s.id);
    /* Console history belongs to the SELECTED SERVER, not to this render.
       Hydrate it when the selection changes — and NEVER wipe it here
       (renderDetails used to do logBuffer = [], which is exactly why the
       console came up empty after navigating around or on every start/stop). */
    if (logServerId !== selectedId) loadLogs(selectedId);
    else renderConsole();

    const startBtn = el('button', { class: `btn ${isRunning ? 'danger' : 'primary'}` },
      el('span', { class: 'btn-ico', html: isRunning ? ICONS.stop : ICONS.play }),
      isRunning ? 'Stop server' : 'Start server');
    const forceBtn = isRunning
      ? el('button', { class: 'btn danger ghost', title: 'Kill the process immediately — prefer Stop, unsaved world data can be lost', text: 'Force stop' })
      : null;
    const installBtn = el('button', { class: 'btn' },
      s.installed ? null : el('span', { class: 'btn-ico', html: ICONS.download }),
      s.installed ? 'Reinstall' : 'Install server files');
    const editBtn = el('button', { class: 'btn ghost', text: 'Edit' });
    const deleteBtn = el('button', { class: 'btn danger ghost', text: 'Delete' });
    const contentBtn = el('button', { class: 'btn', title: 'Install mods or plugins from Modrinth straight into this server', html: `${ICONS.download} <span style="margin-left:6px">Add mods / plugins</span>` });
    contentBtn.addEventListener('click', async () => {
      const { navigate } = await import('../router.js');
      navigate('modrinth', { force: true, params: { presetServerId: s.id } });
    });

    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        if (running.has(s.id)) {
          const stopped = await api.invoke('servers:stop', { id: s.id });
          if (stopped) toast('Stopping…', `${s.name} — graceful stop sent, this can take a few seconds`);
          else toast('Not running', `${s.name} already exited`, { type: 'warn' });
        } else {
          const res = await api.invoke('servers:start', { id: s.id });
          if (res && res.alreadyRunning) toast('Already running', `${s.name} was started earlier and is still up`);
          else toast('Server starting', s.name);
        }
      } catch (e) { toast('Could not start', e.message, { type: 'error' }); }
      finally { startBtn.disabled = false; }
    });
    if (forceBtn) forceBtn.addEventListener('click', async () => {
      const ok = await confirmModal({ title: `Force stop ${s.name}?`, message: 'The server process is killed immediately. Anything not yet saved to disk (world chunks, player data) may be lost — use the normal Stop whenever you can.' });
      if (!ok) return;
      try {
        await api.invoke('servers:kill', { id: s.id });
        toast('Force stop', `${s.name} was killed`, { type: 'warn' });
      } catch (e) { toast('Force stop failed', e.message, { type: 'error' }); }
    });
    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      const pt = (await import('../components/toast.js')).progressToast(`Installing ${cap(s.type)} ${s.version}…`);
      try {
        await api.invoke('servers:install', { id: s.id });
        pt.done('Installed');
        await refreshServers(); renderDetails();
      } catch (e) { pt.fail('Failed'); toast('Install failed', e.message, { type: 'error' }); }
      finally { installBtn.disabled = false; }
    });
    editBtn.addEventListener('click', () => openEditServer(s));
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmModal({ title: `Delete ${s.name}?`, message: 'The server folder and all its files will be permanently removed.' });
      if (!ok) return;
      await api.invoke('servers:delete', { id: s.id });
      selectedId = null;
      await refreshServers(); renderList(); renderDetails();
    });

    uptimeText = null;
    const runChip = isRunning
      ? el('span', { class: 'chip accent', title: 'Started by Neurax — state survives page navigation now' },
          el('i', { class: 'dot' }),
          (uptimeText = el('span', { text: `RUNNING · ${startedAt[s.id] ? fmtUptime(Date.now() - startedAt[s.id]) : 'just now'}` })))
      : el('span', { class: 'chip', text: 'stopped' });

    detailsEl.append(
      el('div', { class: 'detail-header' },
        el('h2', { text: s.name }),
        el('div', { class: 'row' },
          el('span', { class: 'chip accent', text: cap(s.type) }),
          el('span', { class: 'chip', text: s.version }),
          el('span', { class: 'chip', text: `port ${s.port}` }),
          el('span', { class: 'chip', text: `mem ${fmtBytes(s.memoryMB * 1048576)}` }),
          runChip,
          s.installed ? el('span', { class: 'chip', text: 'installed' }) : el('span', { class: 'chip', text: 'not installed' }),
        ),
        el('div', { class: 'hint', style: { marginTop: '8px' }, text: `MOTD: ${s.motd || '—'}` }),
        el('div', { class: 'detail-actions' }, startBtn, forceBtn, installBtn, contentBtn, editBtn, deleteBtn),
      ),
      el('div', { class: 'card', style: { padding: '14px', display: 'flex', flexDirection: 'column', flex: '1', minHeight: '220px' } },
        el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' } },
          el('span', { class: 'label', style: { marginBottom: '0' }, text: 'Live console' }),
          el('div', { style: { display: 'flex', gap: '6px' } }, copyBtn, clearBtn),
        ),
        consoleEl,
        el('div', { class: 'console-input' }, consoleInput, sendBtn),
      ),
      filesWrap,
    );
    renderFiles();
  };

  /* events — mirror the engine's run-state + live console lines.
     state.js ALSO has an app-level listener for the running set; this one
     additionally drives this page's UI (list dots, details, console). */
  const unsub = api.on('server:event', (p) => {
    if (!p || !p.serverId) return;
    if (p.event === 'log') {
      if (p.serverId === logServerId) {
        logBuffer.push(p.payload);
        if (logBuffer.length > 400) logBuffer.shift();
        renderConsole();
      }
      return;
    }
    if (p.event === 'started') { running.add(p.serverId); startedAt[p.serverId] = Date.now(); }
    else if (p.event === 'stopped') { running.delete(p.serverId); delete startedAt[p.serverId]; }
    else if (p.event === 'log-cleared') { if (p.serverId === logServerId) { logBuffer = []; renderConsole(); } return; }
    else return; // install-start / install-done / download-progress: no UI change here
    renderList();
    if (p.serverId === selectedId) renderDetails();
  });

  /* uptime ticker — refreshes the RUNNING chip text without re-rendering
     the page (re-rendering would close the file editor mid-edit). */
  const uptimeTick = setInterval(() => {
    if (!uptimeText || !selectedId || !running.has(selectedId) || !startedAt[selectedId]) return;
    uptimeText.textContent = `RUNNING · ${fmtUptime(Date.now() - startedAt[selectedId])}`;
  }, 10000);

  pageEls = { unsub, uptimeTick };

  await refreshServers().catch(() => {});
  syncRunning();
  /* engine truth wins — covers events fired while this page was closed
     (exactly the logo → dashboard → servers round-trip scenario) */
  try {
    const rt = await api.invoke('servers:runtime');
    if (rt) {
      startedAt = rt.startedAt || {};
      running.clear();
      for (const id of (rt.running || [])) running.add(id);
      state.runningServers = rt.running || [];
    }
  } catch { /* keep state-derived values */ }
  renderList();
  if (!selectedId && state.servers.length) selectedId = state.servers[0].id;
  renderDetails();

  container.append(
    el('div', { class: 'page-title', text: 'Servers' }),
    el('div', { class: 'page-sub', text: 'Click a server to manage it. Console is live; files auto-save as you type.' }),
    el('div', { class: 'split' },
      el('div', { class: 'left' }, listEl),
      el('div', { class: 'right' }, detailsEl),
    ),
  );
}

function tagLabel(t) {
  return { 1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double', 7: 'byte[]', 8: 'string', 9: 'list', 10: 'compound', 11: 'int[]', 12: 'long[]' }[t] || 'tag';
}

function setByPath(tree, path, value) {
  // path like ".Data.LevelName" or ".Data.Items[0]"
  const tokens = path.replace(/^\./, '').split(/\.|(?=\[)/);
  let container = tree.$compound ? tree : tree;
  let key = null;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t.endsWith(']')) {
      const idx = Number(t.slice(t.indexOf('[') + 1, -1));
      const name = t.slice(0, t.indexOf('['));
      const node = name ? container.$compound[name].value : container;
      container = (node.$list ? node.$list[idx] : node);
    } else {
      const node = container.$compound[t];
      if (!node) return;
      container = node.value;
    }
  }
  const last = tokens[tokens.length - 1];
  if (last.endsWith(']')) {
    const idx = Number(last.slice(last.indexOf('[') + 1, -1));
    const name = last.slice(0, last.indexOf('['));
    const node = name ? container.$compound[name].value : container;
    node.$list[idx] = value;
  } else {
    const node = container.$compound[last];
    if (node) node.value = value;
  }
}

function openEditServer(s) {
  (async () => {
    const { openModal } = await import('../components/modal.js');
    const nameInput = el('input', { class: 'input', value: s.name });
    const portInput = el('input', { class: 'input', type: 'number', value: s.port });
    const motdInput = el('input', { class: 'input', value: s.motd });
    const memInput = el('input', { class: 'input', type: 'number', value: s.memoryMB, step: '256' });
    openModal({
      title: `Edit ${s.name}`,
      sub: 'Changes apply to server.properties on next start.',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '13px' } },
        el('div', {}, el('label', { class: 'label', text: 'Name' }), nameInput),
        el('div', { class: 'form-row' },
          el('div', {}, el('label', { class: 'label', text: 'Port' }), portInput),
          el('div', {}, el('label', { class: 'label', text: 'Memory (MB)' }), memInput),
        ),
        el('div', {}, el('label', { class: 'label', text: 'MOTD' }), motdInput),
      ),
      actions: (close) => [
        el('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
        el('button', {
          class: 'btn primary', text: 'Save', onclick: async () => {
            await api.invoke('servers:update', { id: s.id, patch: { name: nameInput.value.trim(), port: Number(portInput.value), motd: motdInput.value, memoryMB: Number(memInput.value) } });
            await refreshServers();
            close();
            toast('Server updated', '');
            const { navigate } = await import('../router.js');
            navigate('servers', { forward: false, params: { select: s.id }, force: true }); // same page — force so the new selection renders
          },
        }),
      ],
    });
  })();
}

export function disposeServers() {
  if (pageEls) {
    if (pageEls.unsub) pageEls.unsub();
    if (pageEls.uptimeTick) clearInterval(pageEls.uptimeTick);
    pageEls = null;
  }
}
