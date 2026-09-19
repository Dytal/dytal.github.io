// ipc.js — typed IPC surface between renderer and engine.
'use strict';
const { ipcMain, shell, dialog } = require('electron');
const path = require('path');

const pathsMod = require('./core/paths');
const settingsMod = require('./core/settings');
const store = require('./core/store');
const versions = require('./core/versions');
const javaEngine = require('./core/java');
const auth = require('./core/auth');
const game = require('./core/game');
const modrinth = require('./core/modrinth');
const servers = require('./core/servers');
const filesMod = require('./core/files');
const logger = require('./core/logger');
const nxCloud = require('./core/nx-cloud');
const nxKeys = require('./core/nx-admin-keys');
const nxVault = require('./core/nx-vault'); // encrypted memory vault (logins + passkeys)
const identity = require('./core/device-identity');
const nxInject = require('./core/nx-inject');
const { DIRS } = pathsMod;

const TARGETS = { game: game, servers: servers };

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}, e) };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      logger.core.debug(`IPC ${channel} failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });
}

function register() {
  // ---- app / settings ----
  handle('app:info', () => ({
    version: require('../../package.json').version,
    neuraxRoot: DIRS.root,
    platform: process.platform,
    totalMemoryMB: Math.floor(require('os').totalmem() / 1024 / 1024),
  }));
  handle('settings:get', () => settingsMod.get());
  handle('settings:set', (p) => settingsMod.set(p));
  handle('app:openFolder', (p) => { shell.openPath(p.dir || DIRS.root); return true; });
  handle('app:clearCache', () => { require('./core/net').cacheClear(); return true; });

  // ---- versions ----
  handle('versions:all', () => versions.getAllVersions());
  handle('versions:fabricLoaders', (p) => versions.getFabricLoaderVersions(p.gameVersion));
  handle('versions:quiltLoaders', (p) => versions.getQuiltLoaderVersions(p.gameVersion));
  handle('versions:forgeVersions', (p) => versions.getForgeVersions(p.gameVersion));
  handle('versions:neoforgeVersions', (p) => versions.getNeoForgeVersions(p.gameVersion));

  // ---- java ----
  handle('java:discover', (p) => javaEngine.discoverJavas({ fresh: !!(p && p.fresh) }));
  handle('java:ensure', (p, e) => javaEngine.ensureJava(p.major, {
    onProgress: (r, t) => e.sender.send('java:progress', { received: r, total: t }),
  }));

  // ---- auth ----
  handle('auth:offline', (p) => auth.loginOffline(p.name));
  handle('auth:msStart', (p, e) => auth.loginMicrosoft((p.clientId || settingsMod.get().msClientId || '').trim(), (userCode, uri) => {
    e.sender.send('auth:deviceCode', { userCode, verificationUri: uri });
    // convenience: open the Microsoft device-login page in the system browser right away
    shell.openExternal(uri).catch(() => {});
  }));
  // easiest path: embedded sign-in window (no codes) — official Minecraft MSA app
  handle('auth:msWindow', (p, e) => require('./core/msa-window').openMicrosoftLogin({
    clientId: (p.clientId || settingsMod.get().msClientId || '').trim(),
    broadcast: (stage, message) => {
      if (!e.sender.isDestroyed()) e.sender.send('auth:msWindow', { stage, message });
    },
  }));
  handle('auth:msWindowCancel', () => { require('./core/msa-window').cancelActive(); return true; });
  handle('auth:logout', () => {
    try { nxVault.forgetAccount(); } catch {} // vault keeps the login HISTORY — only the active mirror clears
    auth.clearTokens();
    settingsMod.set({ lastAccount: null });
    return true;
  });
  handle('auth:current', () => auth.currentAccount());
  handle('auth:restore', () => auth.restoreSession());
  handle('auth:sessionInfo', () => auth.getSessionInfo());
  // cropped PLAYER HEAD for the account chip (Hotfix-11 fix, now also used by
  // NX chat rows — the full skin PNG must never be shown again)
  handle('auth:skinData', async () => {
    const acc = await auth.currentAccount();
    if (!acc) return { url: null };
    const heads = require('./core/skin-heads');
    return { url: await heads.headDataUrl({ uuid: acc.uuid || '', name: acc.name || 'Player' }) };
  });

  // ---- instances ----
  handle('instances:list', () => store.listInstances());
  // creating an instance also makes it the active play target — the dashboard
  // the user lands on right after must show THEIR new instance on the PLAY button
  handle('instances:create', (p) => { const inst = store.createInstance(p); store.setSelected(inst.id); return inst; });
  handle('instances:update', (p) => store.updateInstance(p.id, p.patch));
  handle('instances:delete', (p) => store.deleteInstance(p.id));
  handle('instances:select', (p) => { store.setSelected(p.id); return true; });
  handle('instances:dir', (p) => store.instanceGameDir(p.id));

  // ---- launch ----
  handle('game:launch', (p) => game.launchGame(p || {}));
  handle('game:status', () => ({ launching: game.isLaunching() }));
  handle('game:stop', () => game.stopGame());

  // ---- servers ----
  handle('servers:list', () => store.listServers());
  handle('servers:create', (p) => store.createServer(p));
  handle('servers:update', (p) => store.updateServer(p.id, p.patch));
  handle('servers:delete', (p) => { servers.forceKill(p.id); return store.deleteServer(p.id); });
  handle('servers:install', (p) => servers.installServer(store.getServer(p.id)));
  handle('servers:start', (p) => servers.startServer(store.getServer(p.id)));
  handle('servers:stop', (p) => servers.stopServer(p.id));
  handle('servers:kill', (p) => servers.forceKill(p.id));
  handle('servers:command', (p) => { servers.sendCommand(p.id, p.command); return true; });
  handle('servers:running', () => servers.listRunning());
  handle('servers:runtime', () => servers.getRuntime());
  handle('servers:log', (p) => ({ logs: servers.getLog(p.id) }));
  handle('servers:clearLog', (p) => { servers.clearLog(p.id); return true; });
  handle('servers:paperVersions', () => servers.getPaperVersions());

  // ---- files inspector ----
  const dirFor = (p) => {
    if (p.scope === 'instance') return store.instanceGameDir(p.id);
    if (p.scope === 'server') return store.serverDir(p.id);
    return DIRS.minecraft;
  };
  handle('files:list', (p) => filesMod.list(dirFor(p), p.path));
  handle('files:readText', (p) => filesMod.readText(dirFor(p), p.path));
  handle('files:writeText', (p) => filesMod.writeText(dirFor(p), p.path, p.content));
  handle('files:readNbt', (p) => filesMod.readNbt(dirFor(p), p.path));
  handle('files:writeNbt', (p) => filesMod.writeNbt(dirFor(p), p.path, p.data));
  handle('files:readRegion', (p) => filesMod.readRegion(dirFor(p), p.path, p.limit));
  handle('files:readRegionChunk', (p) => filesMod.readRegionChunk(dirFor(p), p.path, p.index));
  handle('files:mkdir', (p) => filesMod.mkdir(dirFor(p), p.path, p.name));
  handle('files:touch', (p) => filesMod.touch(dirFor(p), p.path, p.name));
  handle('files:delete', (p) => filesMod.remove(dirFor(p), p.path));
  handle('files:rename', (p) => filesMod.rename(dirFor(p), p.path, p.newName));
  handle('files:openInSystem', (p) => { shell.openPath(dirFor(p)); return true; });
  handle('files:stats', (p) => filesMod.sizeOfDir(dirFor(p)));

  // ---- modrinth ----
  handle('modrinth:search', (p) => modrinth.search(p));
  handle('modrinth:project', (p) => modrinth.getProject(p.id));
  handle('modrinth:versions', (p) => modrinth.getVersions(p.id, p));
  handle('modrinth:install', (p, e) => modrinth.installProject({
    projectId: p.projectId, target: p.target, versionId: p.versionId,
    onProgress: (r, t) => e.sender.send('install:progress', { provider: 'modrinth', received: r, total: t }),
  }));
  // modpacks — read preview, download the raw .mrpack, or run the full converter
  handle('modrinth:readMrpack', (p) => modrinth.readMrpackIndex(p.mrpackPath));
  handle('modrinth:installMrpack', (p, e) => modrinth.installMrpack({
    mrpackPath: p.mrpackPath, target: p.target,
    onProgress: (d, total, name) => { if (!e.sender.isDestroyed()) e.sender.send('install:progress', { provider: 'modrinth', done: d, count: total, file: name }); },
    onStatus: (s) => { if (!e.sender.isDestroyed()) e.sender.send('install:progress', { provider: 'modrinth', status: s }); },
  }));
  handle('modrinth:installModpackVersion', (p, e) => {
    const send = (obj) => { if (!e.sender.isDestroyed()) e.sender.send('install:progress', { provider: 'modrinth', ...obj }); };
    return modrinth.installModpackVersion({
      projectId: p.projectId, versionId: p.versionId, target: p.target,
      onDownload: (r, t) => send({ received: r, total: t }),
      onProgress: (d, n, name) => send({ done: d, count: n, file: name }),
      onStatus: (s) => send({ status: s }),
    });
  });
  handle('modrinth:downloadMrpack', (p, e) => modrinth.downloadMrpackFile({
    versionId: p.versionId, destPath: p.destPath,
    onProgress: (r, t) => { if (!e.sender.isDestroyed()) e.sender.send('install:progress', { provider: 'modrinth', received: r, total: t }); },
  }));

  // ---- NX Cloud (device identity / remote control / chat / announcements) ----
  handle('nx:status', () => nxCloud.publicState());
  handle('nx:identity', () => identity.getIdentity());
  handle('nx:setCloudUrl', (p) => nxCloud.api.setCloudUrl(p.url));
  handle('nx:setSupabaseUrl', (p) => nxCloud.api.setSupabaseUrl(p.url));
  handle('nx:testSupabase', (p) => nxCloud.api.testSupabase(p.url));
  handle('nx:adminCheck', (p) => {
    // The admin panel inside the launcher is gated by the FIXED owner passkey.
    // The encrypted memory vault remembers it (self-healed to the baked value);
    // every successful unlock is remembered with a timestamp.
    const got = String((p && p.pass) || '');
    const want = nxVault.launcherVault().get().unlockPasskey || nxKeys.UNLOCK_PASSKEY;
    if (got !== want) throw new Error('Wrong owner passkey.');
    try { nxVault.noteAdminUnlock(); } catch {}
    return { ok: true };
  });
  // ---- memory vault (encrypted + read-only) ----
  handle('vault:status', () => {
    const st = nxVault.launcherVault().status();
    return {
      file: st.file, bytes: st.bytes, locked: st.locked, readOnly: st.readOnly,
      encrypted: st.encrypted, updatedAt: st.updatedAt,
      logins: st.remembers.logins, sessions: st.remembers.sessions,
    };
  });
  handle('vault:remembered', () => nxVault.rememberedLogins());
  handle('nx:flushQueue', () => nxCloud.api.flushQueue());
  handle('nx:skinHead', (p) => nxCloud.api.skinHead(p || {}));
  handle('nx:refresh', () => nxCloud.api.refresh());
  handle('nx:lockState', () => nxCloud.api.lockState());
  handle('nx:announcements', () => ({ announcements: nxCloud.publicState().announcements }));
  handle('nx:annCreate', (p) => nxCloud.api.annCreate(p));
  handle('nx:annUpdate', (p) => nxCloud.api.annUpdate(p));
  handle('nx:annDelete', (p) => nxCloud.api.annDelete(p));
  handle('nx:adminList', () => nxCloud.api.adminList());
  handle('nx:adminLock', (p) => nxCloud.api.adminLock(p));
  handle('nx:adminUnlock', (p) => nxCloud.api.adminUnlock(p));
  handle('nx:chatList', () => nxCloud.api.chatList());
  handle('nx:chatCreate', (p) => nxCloud.api.chatCreate(p));
  handle('nx:chatInvite', (p) => nxCloud.api.chatInvite(p));
  handle('nx:chatLeave', (p) => nxCloud.api.chatLeave(p));
  handle('nx:chatMessages', (p) => nxCloud.api.chatMessages(p));
  handle('nx:chatSend', (p) => nxCloud.api.chatSend(p));
  handle('nx:chatSendFile', (p, e) => nxCloud.api.chatSendFile({
    chatId: p.chatId, filePath: p.filePath, kind: p.kind,
    onProgress: (r, t) => { if (!e.sender.isDestroyed()) e.sender.send('nx:file:progress', { chatId: p.chatId, received: r, total: t, name: p.filePath }); },
  }));
  handle('nx:fileUrl', (p) => nxCloud.api.fileUrl(p));
  handle('nx:fileDataUrl', (p, e) => nxCloud.api.fileDataUrl({
    fileId: p.fileId, fileName: p.fileName,
    onProgress: (r, t) => { if (!e.sender.isDestroyed()) e.sender.send('nx:file:progress', { received: r, total: t, name: p.fileName, inline: true }); },
  }));
  handle('nx:downloadFile', (p, e) => nxCloud.api.downloadFile({
    fileId: p.fileId, fileName: p.fileName, destDir: p.destDir,
    onProgress: (r, t) => { if (!e.sender.isDestroyed()) e.sender.send('nx:file:progress', { received: r, total: t, name: p.fileName, download: true }); },
  }));
  handle('nx:packInfo', () => ({ pack: nxInject.PACK_NAME, exists: nxInject.packExists(), file: nxInject.packFile() }));

  // ---- misc ----
  handle('app:openExternal', (p) => {
    if (p && typeof p.url === 'string' && /^https?:\/\//i.test(p.url)) { shell.openExternal(p.url); return true; }
    return false;
  });
  handle('logs:history', () => logger.getHistory());
  handle('logs:open', () => { require('./main').openLogsWindow(); return true; });
  handle('dialog:openFile', async (p, e) => {
    const win = require('./main').getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      title: p.title || 'Select file',
      filters: p.filters || [],
      properties: [p.directory ? 'openDirectory' : 'openFile'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });
  handle('dialog:saveFile', async (p) => {
    const win = require('./main').getMainWindow();
    const res = await dialog.showSaveDialog(win, {
      title: p.title || 'Save file',
      defaultPath: p.defaultPath || undefined,
      filters: p.filters || [],
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });
}

module.exports = { register };
