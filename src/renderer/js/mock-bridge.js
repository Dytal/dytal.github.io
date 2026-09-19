// mock-bridge.js — DEVELOPER UI-PREVIEW HARNESS. Used ONLY when the Electron preload
// bridge is absent (e.g. opening index.html in a plain browser or a UI probe).
// It is inert in the packaged launcher: window.neurax always comes from preload.js
// and the real engine. Nothing here runs for end users.
(function () {
  if (window.neurax) return; // real bridge present
  console.warn('[neurax] UI PREVIEW MODE — developer harness, not the real engine.');

  const delay = (v, ms = 120) => new Promise(r => setTimeout(() => r(v), ms));
  const now = Date.now();

  const versions = [
    ['1.21.4', 'release'], ['1.21.3', 'release'], ['1.21.2', 'release'], ['1.21.1', 'release'],
    ['1.21', 'release'], ['1.20.6', 'release'], ['1.20.4', 'release'], ['1.20.1', 'release'],
    ['1.19.4', 'release'], ['1.19.2', 'release'], ['1.18.2', 'release'], ['1.17.1', 'release'],
    ['1.16.5', 'release'], ['1.12.2', 'release'], ['1.8.9', 'release'], ['1.7.10', 'release'],
    ['26.3-rc-3', 'snapshot'], ['26.3-pre5', 'snapshot'], ['25.4-alpha', 'snapshot'],
  ];
  const loaders = {
    fabric: ['0.19.5', '0.19.4', '0.18.14', '0.16.9'],
    quilt: ['0.27.1', '0.26.4'],
    forge: ['54.1.18', '54.1.14', '52.0.24'],
    neoforge: ['21.4.47', '21.1.95'],
  };

  const instances = [
    { id: 'demo1', name: 'Performance+', version: '1.21.4', loader: 'fabric', loaderVersion: '0.19.5', memoryMB: 4096, created: now - 8e8, lastPlayed: now - 3e6 },
    { id: 'demo2', name: 'NeoTech', version: '1.21.1', loader: 'neoforge', loaderVersion: '21.1.95', memoryMB: 6144, created: now - 5e8, lastPlayed: now - 8e7 },
    { id: 'demo3', name: 'Classic Survival', version: '1.12.2', loader: 'forge', loaderVersion: '14.23.5.2859', memoryMB: 3072, created: now - 9e9, lastPlayed: now - 9e8 },
  ];
  const servers = [
    { id: 'sv1', name: 'Creative Hub', type: 'paper', version: '1.21.4', memoryMB: 2048, port: 25565, motd: 'Welcome!', installed: true, jarFile: 'paper.jar', created: now, lastRun: now - 5e6 },
    { id: 'sv2', name: 'Modded SMP', type: 'fabric', version: '1.21.4', memoryMB: 4096, port: 25566, motd: 'Modded fun', installed: false, jarFile: null, created: now, lastRun: 0 },
  ];

  const settings = {
    version: 2, theme: 'emerald', memoryMB: 4096, javaPathOverride: '', keepLauncherOpen: true,
    windowWidth: 1000, windowHeight: 800, rememberWindowSize: true, cfApiKey: '', msClientId: '',
    lastAccount: { type: 'offline', name: 'Steve', uuid: 'x' }, selectedInstanceId: 'demo1',
    selectedVersion: '1.21.4', showSnapshots: true, showOldVersions: true, playFullscreen: false,
    gameWidth: 1280, gameHeight: 720, eulaAcceptedServers: true, concurrency: 8,
    nxCloudUrl: 'http://127.0.0.1:8790',
    nxSupabaseUrl: 'postgresql://postgres:***@db.demo.supabase.co:5432/postgres',
    nxAdminPass: '', nxEnabled: true, nxUiInject: true,
  };

  const mrHits = [
    { project_id: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'A modern rendering engine that greatly improves frame rates.', author: 'jellysquid3', downloads: 226906968, follows: 12000, icon_url: null, project_type: 'mod', categories: ['performance', 'fabric'], display_categories: ['performance'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
    { project_id: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API', description: 'Essential hooks and interoperability for Fabric mods.', author: 'modmuss50', downloads: 350000000, follows: 9000, icon_url: null, project_type: 'mod', categories: ['library', 'fabric'], display_categories: ['library'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
    { project_id: 'gvQqBUqZ', slug: 'lithium', title: 'Lithium', description: 'Game logic optimizations that do not change gameplay.', author: 'jellysquid3', downloads: 80000000, follows: 5000, icon_url: null, project_type: 'mod', categories: ['optimization', 'fabric'], display_categories: ['optimization'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
  ];

  const modpackHits = [
    { project_id: 'mp1', slug: 'fabulously-optimized', title: 'Fabulously Optimized', description: 'A performance-focused modpack.', author: 'robotkoer', downloads: 9000000, follows: 4100, icon_url: null, project_type: 'modpack', categories: ['optimization', 'fabric'], display_categories: ['optimization'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
  ];

  const pluginHits = [
    { project_id: 'plg1', slug: 'essentialsx', title: 'EssentialsX', description: 'The essential plugin suite for Minecraft servers.', author: 'EssentialsX Team', downloads: 48000000, follows: 3200, icon_url: null, project_type: 'mod', categories: ['admin-tools', 'paper'], display_categories: ['admin-tools'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
    { project_id: 'plg2', slug: 'luckperms', title: 'LuckPerms', description: 'A permissions plugin for Minecraft servers.', author: 'Luck', downloads: 30000000, follows: 2100, icon_url: null, project_type: 'mod', categories: ['management', 'paper'], display_categories: ['management'], date_modified: new Date().toISOString(), versions: ['1.21.4'] },
  ];

  // one sample announcement so the announcements page has something to render in preview
  const previewAnnouncements = [{
    id: 'preview-ann-1', title: 'Welcome to NX Cloud',
    body: 'This is a preview announcement rendered by the developer UI harness.\nThe real list comes from your nx-cloud server.',
    tags: ['preview'], style: { color: '#38e1ff', banner: '#101828', icon: 'spark' },
    priority: 'info', pinned: false, createdAt: now, updatedAt: now,
  }];

  // simple demo event bus so invoke() handlers can emit events to the UI
  const subs = new Map();
  const emitEvent = (channel, payload) => {
    for (const cb of (subs.get(channel) || [])) { try { cb(payload); } catch {} }
  };

  window.neurax = {
    invoke: (channel, payload = {}) => {
      switch (channel) {
        case 'app:info': return delay({ version: '3.0.0-preview', neuraxRoot: 'C:/Users/Demo/AppData/Roaming/.neurax', platform: 'win32', totalMemoryMB: 16384 });
        case 'settings:get': return delay({ ...settings });
        case 'settings:set': return delay(Object.assign(settings, payload));
        case 'versions:all': return delay({
          latest: { release: '1.21.4', snapshot: '26.3-rc-3' },
          groups: {
            Releases: versions.filter(v => v[1] === 'release').map(v => ({ id: v[0], type: 'release', releaseTime: now })),
            Snapshots: versions.filter(v => v[1] === 'snapshot').map(v => ({ id: v[0], type: 'snapshot', releaseTime: now })),
            Beta: [{ id: 'b1.7.3', type: 'old_beta', releaseTime: now }],
            Alpha: [{ id: 'a1.2.6', type: 'old_alpha', releaseTime: now }],
            Other: [],
          },
          flat: versions.map(v => ({ id: v[0], type: v[1] })),
        }, 250);
        case 'instances:list': return delay([...instances]);
        case 'instances:create': { const i = { id: 'd' + Math.random().toString(36).slice(2, 7), lastPlayed: 0, created: Date.now(), icon: null, ...payload }; instances.push(i); settings.selectedInstanceId = i.id; return delay(i); }
        case 'instances:update': { const i = instances.find(x => x.id === payload.id); if (i) Object.assign(i, payload.patch); return delay(i); }
        case 'instances:delete': { const idx = instances.findIndex(x => x.id === payload.id); if (idx >= 0) instances.splice(idx, 1); return delay(true); }
        case 'servers:list': return delay([...servers]);
        case 'servers:create': { const s = { id: 's' + Math.random().toString(36).slice(2, 7), installed: false, jarFile: null, lastRun: 0, created: Date.now(), ...payload }; servers.push(s); return delay(s); }
        case 'servers:update': { const s = servers.find(x => x.id === payload.id); if (s) Object.assign(s, payload.patch); return delay(s); }
        case 'servers:delete': { const idx = servers.findIndex(x => x.id === payload.id); if (idx >= 0) servers.splice(idx, 1); return delay(true); }
        case 'servers:running': return delay([]);
        case 'servers:runtime': return delay({ running: [], startedAt: {} });
        case 'servers:log': return delay({ logs: [
          { line: '[12:00:01] [ServerMain/INFO]: Starting minecraft server version 1.21.4', level: 'info', t: now - 60000 },
          { line: '[12:00:03] [Server thread/INFO]: Preparing level "world"', level: 'game', t: now - 58000 },
          { line: '[12:00:05] [Server thread/INFO]: Done (3.214s)! For help, type "help"', level: 'game', t: now - 56000 },
        ] });
        case 'servers:clearLog': return delay(true);
        case 'game:launch': {
          // demo: replay the real launch lifecycle so the dashboard shows the
          // same progress → RUNNING banner it would show in the packaged app
          const v = settings.selectedVersion || '1.21.4';
          (async () => {
            emitEvent('launch:state', { state: 'starting', instance: null, version: v, loader: 'vanilla' });
            await new Promise(r => setTimeout(r, 900));
            emitEvent('launch:state', { state: 'checking-java', javaMajor: 21 });
            await new Promise(r => setTimeout(r, 1100));
            emitEvent('launch:state', { state: 'downloading-game' });
            for (let step = 0; step <= 10; step++) {
              emitEvent('launch:progress', { type: 'download', task: step * 4, total: 40 });
              await new Promise(r => setTimeout(r, 220));
            }
            emitEvent('launch:state', { state: 'running', pid: 4242 });
          })();
          return delay({ ok: true, pid: 4242, account: { name: 'Steve' } }, 3400);
        }
        case 'game:stop': return delay({ stopped: true });
        case 'game:status': return delay({ launching: false });
        case 'versions:fabricLoaders': return delay(loaders.fabric.map(l => ({ loader: l, stable: true })));
        case 'versions:quiltLoaders': return delay(loaders.quilt.map(l => ({ loader: l, stable: true })));
        case 'versions:forgeVersions': return delay(loaders.forge.map(l => ({ version: l, tag: '' })));
        case 'versions:neoforgeVersions': return delay(loaders.neoforge.map(l => ({ version: l })));
        case 'java:discover': return delay([
          { path: 'C:/Program Files/Java/jdk-25/bin/java.exe', major: 25, source: 'system' },
          { path: 'C:/Program Files/Java/jdk-21/bin/java.exe', major: 21, source: 'system' },
        ]);
        case 'auth:offline': return delay({ type: 'offline', name: payload.name, uuid: 'x', accessToken: '0', skin: null });
        case 'auth:current': return delay({ type: 'offline', name: 'Steve', uuid: 'x', accessToken: '0', skin: null });
        case 'auth:sessionInfo': return delay({ hasSavedLogin: false, profileName: 'Steve', lastType: 'offline', cached: false });
        case 'auth:restore': return delay(null);
        case 'auth:logout': return delay(true);
        case 'auth:msWindow': {
          // demo: simulate the popup flow stages, then resolve a demo account
          (async () => {
            emitEvent('auth:msWindow', { stage: 'browser', message: 'Microsoft sign-in window opened — sign in there.' });
            await new Promise(r => setTimeout(r, 1200));
            emitEvent('auth:msWindow', { stage: 'code', message: 'Sign-in approved — connecting to Minecraft services…' });
          })();
          return delay({ type: 'msa', name: 'Steve', uuid: 'demo-uuid', accessToken: 'demo', skin: null }, 2600);
        }
        case 'auth:msWindowCancel': case 'auth:msStart': return delay(true);
        case 'modrinth:search': {
          const pl = payload.loaders || [];
          if (payload.projectType === 'modpack') return delay({ hits: modpackHits, total_hits: modpackHits.length });
          if (payload.projectType === 'mod' && pl.some(l => ['bukkit', 'paper', 'spigot', 'purpur', 'folia', 'velocity', 'waterfall', 'bungeecord'].includes(l))) {
            return delay({ hits: pluginHits, total_hits: pluginHits.length });
          }
          return delay({ hits: mrHits, total_hits: mrHits.length });
        }
        case 'modrinth:project': {
          if (payload.id === 'mp1') {
            return delay({ ...modpackHits[0], body: '<h2>About</h2><p>Demo modpack.</p>', gallery: [], license: { name: 'LGPL-3.0' } });
          }
          return delay({ ...mrHits[0], body: '<h2>About</h2><p>Example description body for <b>' + payload.id + '</b>.</p>', gallery: [], license: { name: 'LGPL-3.0' } });
        }
        case 'modrinth:versions': {
          if (payload.id === 'mp1') {
            return delay([
              { id: 'mpv3', version_number: '5.4.3', name: 'FO 5.4.3', date_published: new Date().toISOString(), game_versions: ['1.21.4'], loaders: ['fabric'], files: [{ primary: true, filename: 'FO-5.4.3.mrpack', url: 'https://cdn.modrinth.com/FO.mrpack', size: 4200000 }] },
              { id: 'mpv2', version_number: '5.4.0', name: 'FO 5.4.0', date_published: new Date(now - 6e10).toISOString(), game_versions: ['1.21.1'], loaders: ['fabric'], files: [{ primary: true, filename: 'FO-5.4.0.mrpack', url: 'https://cdn.modrinth.com/FO2.mrpack', size: 4100000 }] },
              { id: 'mpv1', version_number: '4.0.0', name: 'FO 4.0.0', date_published: new Date(now - 2e11).toISOString(), game_versions: ['1.20.4'], loaders: ['forge'], files: [{ primary: true, filename: 'FO-4.0.0.mrpack', url: 'https://cdn.modrinth.com/FO3.mrpack', size: 3900000 }] },
            ]);
          }
          return delay([
            { id: 'v1', version_number: '1.21.4-0.6.0', name: 'Sodium 0.6', date_published: new Date().toISOString(), game_versions: ['1.21.4'], loaders: ['fabric'], changelog: '<p>Faster rendering.</p>', files: [{ primary: true, filename: 'sodium-0.6.jar', url: 'https://example.com/sodium.jar', size: 1234567 }] },
            { id: 'v2', version_number: '1.21.1-0.5.11', name: 'Sodium 0.5', date_published: new Date(now - 3e10).toISOString(), game_versions: ['1.21.1'], loaders: ['fabric'], changelog: '<p>Fixes.</p>', files: [{ primary: true, filename: 'sodium-0.5.jar', url: 'https://example.com/sodium5.jar', size: 1100000 }] },
          ]);
        }
        case 'modrinth:install': {
          const where = payload.target?.type === 'server' ? 'server plugins folder' : payload.target?.type === 'instance' ? 'instance' : 'global .minecraft';
          return delay({ file: 'sodium-0.6.jar', path: 'C:/' + where + '/sodium-0.6.jar' });
        }
        case 'modrinth:readMrpack': return delay({ name: 'Demo Pack', summary: 'A demo modpack preview.', gameVersion: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9', fileCount: 42, totalBytes: 133700000, hasOverrides: true, versionId: 'v1' });
        case 'modrinth:installMrpack': case 'modrinth:installModpackVersion': {
          const inst = { id: 'd' + Math.random().toString(36).slice(2, 7), name: payload.target?.name || 'Demo Pack', version: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9', memoryMB: payload.target?.memoryMB || 2048, created: Date.now(), lastPlayed: 0, icon: null };
          instances.push(inst);
          settings.selectedInstanceId = inst.id;
          (async () => {
            for (let i = 0; i <= 5; i++) { emitEvent('install:progress', { provider: 'modrinth', done: i, count: 5, file: 'mods/file-' + i + '.jar' }); await new Promise(r => setTimeout(r, 260)); }
          })();
          return delay({ instanceId: inst.id, instance: inst.name, version: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9', files: 5, skipped: 0 }, 1700);
        }
        case 'modrinth:downloadMrpack': return delay({ path: payload.destPath || 'C:/Downloads/pack.mrpack', size: 133700000, filename: 'pack.mrpack' }, 900);
        case 'dialog:saveFile': return delay('C:/Users/Demo/Downloads/demo-pack.mrpack');
        case 'logs:history': return delay([]);
        case 'files:list': return delay({ path: payload.path || '', entries: [{ name: 'saves', type: 'dir', size: 0, mtime: now }, { name: 'options.txt', type: 'file', size: 1240, mtime: now }] });
        case 'files:readText': return delay({ content: 'demo file contents', size: 17, mtime: now });
        case 'files:readNbt': return delay({ name: '', tree: { $compound: { Data: { type: 10, value: { $compound: { LevelName: { type: 8, value: 'Demo World' } } } } } }, truncated: false });
        case 'dialog:openFile': return delay(null);
        case 'servers:install': case 'servers:start': case 'servers:stop': return delay(true);
        // ---- NX Cloud (preview stubs so the UI layer can be smoke-tested) ----
        case 'nx:status': return delay({ mode: 'supabase', connected: true, online: 3, total: 7, uuid: '00000000-0000-4000-8000-000000000000', locked: null, announcements: previewAnnouncements, lastError: null, queued: 0 });
        case 'nx:identity': return delay({ uuid: '00000000-0000-4000-8000-000000000000', fingerprint: 'preview', created: now, source: 'preview' });
        case 'nx:refresh': return delay({ mode: 'supabase', connected: true, online: 3, total: 7, announcements: previewAnnouncements });
        case 'nx:lockState': return delay(null);
        case 'nx:announcements': return delay({ announcements: previewAnnouncements });
        case 'nx:skinHead': return delay({ url: null });
        case 'nx:adminCheck': return delay({ ok: true });
        case 'nx:adminList': return delay([]);
        case 'nx:adminLock': case 'nx:adminUnlock': return delay({ ok: true });
        case 'nx:annCreate': case 'nx:annUpdate': case 'nx:annDelete': return delay({});
        case 'nx:flushQueue': return delay({ sent: 0, left: 0 });
        case 'nx:testSupabase': return delay({ ok: false, error: 'Preview mode — no database here.' });
        case 'nx:fileDataUrl': return delay({ url: null });
        case 'nx:chatList': return delay({ chats: [{ id: 'demo-chat-1', name: 'NX Squad', createdBy: 'someone', memberCount: 2, members: [{ uuid: 'u1', name: 'Alex', type: 'msa' }, { uuid: 'u2', name: 'Steve', type: 'msa' }] }] });
        case 'nx:chatMessages': return delay({ messages: [
          { id: 1, chatId: 'demo-chat-1', from: 'u1', fromName: 'Alex', fromType: 'msa', type: 'text', text: 'Ready for the server reset?', at: now - 6e5 },
          { id: 2, chatId: 'demo-chat-1', from: 'u2', fromName: 'Steve', fromType: 'msa', type: 'text', text: 'Let\u2019s build the arena first \\u{1F3D0}', at: now - 3e5 },
        ] });
        case 'nx:chatSend': case 'nx:chatCreate': case 'nx:chatInvite': case 'nx:chatLeave': return delay({});
        case 'nx:setCloudUrl': case 'nx:setSupabaseUrl': return delay({});
        case 'auth:skinData': return delay({ url: null });
        case 'nx:packInfo': return delay({ pack: 'NX-UI-64x', exists: true, file: 'assets/nx/NX-UI-64x.zip' });
        case 'vault:status': return delay({ file: '(demo) .neurax/vault.bin', bytes: 287, locked: true, readOnly: true, encrypted: 'AES-256-GCM + scrypt (bound to this machine)', updatedAt: now, logins: 2, sessions: 0 });
        case 'vault:remembered': return delay([{ type: 'msa', name: 'DemoPlayer', uuid: 'demo-uuid', lastUsed: now - 36e5, uses: 3 }, { type: 'offline', name: 'OfflineSteve', uuid: 'demo-uuid-2', lastUsed: now - 864e5, uses: 1 }]);
        default:
          return Promise.reject(new Error('[preview] No handler for ' + channel));
      }
    },
    on(channel, cb) {
      // demo event simulation
      subs.set(channel, [...(subs.get(channel) || []), cb]);
      if (channel === 'versions:auto-added') setTimeout(() => cb({ added: ['26.3-rc-4'] }), 6000);
      return () => { subs.set(channel, (subs.get(channel) || []).filter(f => f !== cb)); };
    },
  };
})();
