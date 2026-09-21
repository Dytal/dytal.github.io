// ipc.js — typed IPC surface between renderer and engine.
'use strict';
const { ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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
const ownerGrant = require('./core/nx-owner-grant'); // v1.0 — owner device grants (Settings + Announcements)
const identity = require('./core/device-identity');
const nxInject = require('./core/nx-inject'); // v1.0 — purge-only (injection removed)
const crashDoctor = require('./core/crash-doctor');
const client = require('./core/client'); // v1.0 — Neurax Client optimization stack
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
  // v4.6 crash-diagnostics surface
  handle('app:showFile', (p) => {
    try { if (p && p.file && fs.existsSync(p.file)) { shell.showItemInFolder(p.file); return true; } } catch { /* ignore */ }
    return false;
  });
  handle('diag:summary', async () => crashDoctor.diagSummary());
  handle('diag:armSafeMode', (p) => ({ armed: crashDoctor.armSafeMode((p && p.reason) || 'requested by the player') }));
  handle('diag:restorePacks', () => {
    const results = [];
    try {
      for (const inst of store.listInstances()) {
        results.push({ target: inst.name, ...crashDoctor.restoreSafeModeBackups(store.instanceGameDir(inst.id)) });
      }
    } catch (e) { logger.core.warn('diag:restorePacks instances: ' + e.message); }
    results.push({ target: 'global', ...crashDoctor.restoreSafeModeBackups(DIRS.minecraft) });
    return { results };
  });
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
  // v4.2 DEFAULT login: DEVICE CODE with the official Minecraft app id — the
  // method most apps use (GitHub CLI / VS Code / Azure CLI). No redirect_uri
  // exists in this flow, so Microsoft can never reject a redirect again.
  handle('auth:msStart', async (p, e) => {
    const acc = await auth.loginMicrosoft((p.clientId || settingsMod.get().msClientId || '').trim(), (userCode, uri) => {
      e.sender.send('auth:deviceCode', { userCode, verificationUri: uri });
      // convenience: open the Microsoft device-login page in the system browser right away
      shell.openExternal(uri).catch(() => {});
    });
    // v4: activity feed — the owner sees every Microsoft login in the Control Center
    if (acc && acc.name) nxCloud.api.logEvent({ kind: 'login', details: { name: acc.name, uuid: acc.uuid || '', type: acc.type, via: 'device-code' } });
    return acc;
  });
  handle('auth:msCancel', () => { auth.cancelDeviceFlow(); return true; });
  // easiest path: embedded sign-in window (no codes) — official Minecraft MSA app
  handle('auth:msWindow', async (p, e) => {
    const acc = await require('./core/msa-window').openMicrosoftLogin({
      clientId: (p.clientId || settingsMod.get().msClientId || '').trim(),
      broadcast: (stage, message) => {
        if (!e.sender.isDestroyed()) e.sender.send('auth:msWindow', { stage, message });
      },
    });
    // v4: activity feed — the owner sees every Microsoft login in the Control Center
    if (acc && acc.name) nxCloud.api.logEvent({ kind: 'login', details: { name: acc.name, uuid: acc.uuid || '', type: acc.type } });
    return acc;
  });
  handle('auth:msWindowCancel', () => { require('./core/msa-window').cancelActive(); return true; });
  // v4.2: system-browser PKCE + loopback — the Prism/ATLauncher method. Needs
  // the owner's OWN Azure client id (the built-in Minecraft app id has no
  // localhost redirect registered; msa-browser refuses without one).
  handle('auth:msBrowser', async (p, e) => {
    const acc = await require('./core/msa-browser').openMicrosoftBrowserLogin({
      clientId: (p.clientId || settingsMod.get().msClientId || '').trim(),
      broadcast: (stage, message) => {
        if (!e.sender.isDestroyed()) e.sender.send('auth:msBrowser', { stage, message });
      },
    });
    if (acc && acc.name) nxCloud.api.logEvent({ kind: 'login', details: { name: acc.name, uuid: acc.uuid || '', type: acc.type, via: 'browser' } });
    return acc;
  });
  handle('auth:msBrowserCancel', () => { require('./core/msa-browser').cancelActive(); return true; });
  handle('auth:logout', () => {
    try { nxVault.forgetAccount(); } catch {} // vault keeps the login HISTORY — only the active mirror clears
    try {
      const a = require('./core/auth').getSessionInfo();
      if (a && a.profileName) nxCloud.api.logEvent({ kind: 'logout', details: { name: a.profileName } });
    } catch {}
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
    // v1.0 FIX: the announcements-tab unlock now verifies against the
    // AUTHORITATIVE resolved owner key first (the vault mirror is only a
    // fallback), and a successful check creates the PERSISTENT DEVICE GRANT
    // — the same grant the Settings Owner Console uses, so both tabs always
    // agree and the key only has to be typed once per device.
    const got = String((p && p.pass) || '');
    const want = nxKeys.UNLOCK_PASSKEY || nxVault.launcherVault().get().unlockPasskey;
    if (got !== want) throw new Error('Wrong owner key.');
    let grant = null;
    try { grant = ownerGrant.verify(got); } catch { /* grant persistence is best-effort */ }
    try { nxVault.noteAdminUnlock(); } catch {}
    return { ok: true, deviceGranted: !!(grant && grant.persisted) };
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
  handle('nx:chatDM', (p) => nxCloud.api.chatDM(p));
  handle('nx:chatInvite', (p) => nxCloud.api.chatInvite(p));
  handle('nx:chatLeave', (p) => nxCloud.api.chatLeave(p));
  handle('nx:chatDelete', (p) => nxCloud.api.chatDelete(p));
  handle('nx:chatRename', (p) => nxCloud.api.chatRename(p));
  handle('nx:chatSetRole', (p) => nxCloud.api.chatSetRole(p));
  handle('nx:chatKick', (p) => nxCloud.api.chatKick(p));
  handle('nx:chatStar', (p) => nxCloud.api.chatStar(p));
  handle('nx:chatMessages', (p) => nxCloud.api.chatMessages(p));
  handle('nx:msgEdit', (p) => nxCloud.api.msgEdit(p));
  handle('nx:msgDeleteForMe', (p) => nxCloud.api.msgDeleteForMe(p));
  handle('nx:msgDeleteForEveryone', (p) => nxCloud.api.msgDeleteForEveryone(p));
  handle('nx:friendsList', () => nxCloud.api.friendsList());
  handle('nx:friendAdd', (p) => nxCloud.api.friendAdd(p));
  handle('nx:friendRemove', (p) => nxCloud.api.friendRemove(p));
  handle('nx:friendStar', (p) => nxCloud.api.friendStar(p));
  // v1.0 — invitations with accept/reject + live notifications
  handle('nx:invitesList', () => nxCloud.api.invitesList());
  handle('nx:friendRespond', (p) => nxCloud.api.friendRespond(p));
  handle('nx:inviteRespond', (p) => nxCloud.api.inviteRespond(p));
  // v4: voice calls
  handle('nx:voiceJoin', (p) => nxCloud.api.voiceJoin(p));
  handle('nx:voiceTick', (p) => nxCloud.api.voiceTick(p));
  handle('nx:voiceSignal', (p) => nxCloud.api.voiceSignal(p));
  handle('nx:voiceUpdate', (p) => nxCloud.api.voiceUpdate(p));
  handle('nx:voiceLeave', (p) => nxCloud.api.voiceLeave(p));
  // v4: owner blocklist + activity feed
  handle('nx:blockList', () => nxCloud.api.blockList());
  handle('nx:blockAdd', (p) => nxCloud.api.blockAdd(p));
  handle('nx:blockRemove', (p) => nxCloud.api.blockRemove(p));
  handle('nx:eventsList', (p) => nxCloud.api.eventsList(p));
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
  handle('nx:packInfo', () => ({ pack: nxInject.PACK_NAME, exists: false, removed: true })); // v1.0 — injection removed; kept so old mock bridges do not break

  // ---- v4.1: OWNER identity editing (Launcher ID / Device ID / MS Client ID) ----
  // Readable anytime; WRITING requires the owner passkey again (verified here,
  // server-side — the renderer's session flag alone never grants this).
  handle('nx:identityRead', () => {
    const id = identity.getIdentity() || {};
    return {
      uuid: id.uuid || '',
      fingerprint: id.fingerprint || '',
      source: id.source || '',
      file: id.file || null,
      msClientId: settingsMod.get().msClientId || '',
      cloudUuid: (nxCloud.publicState() && nxCloud.publicState().uuid) || '',
      appVersion: require('../../package.json').version,
    };
  });
  handle('nx:identityWrite', async (p) => {
    const got = String((p && p.pass) || '');
    const want = nxKeys.UNLOCK_PASSKEY || nxVault.launcherVault().get().unlockPasskey;
    const passOk = (got === want) || ownerGrant.isGranted();
    if (!passOk) throw new Error('Wrong owner key — identity edit refused.');
    const uuid = String((p && p.uuid) || '').trim().toLowerCase();
    const fp = String((p && p.fingerprint) || '').trim().toLowerCase();
    const cid = String((p && p.msClientId) || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
      throw new Error('Launcher ID must be a full UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).');
    }
    if (!/^[0-9a-f]{64}$/.test(fp)) {
      throw new Error('Device ID must be the 64-character hardware fingerprint.');
    }
    if (cid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) {
      throw new Error('Client ID must be an Azure app id (GUID) — or empty for the built-in one.');
    }
    const applied = await identity.overrideIdentity({ uuid, fingerprint: fp });
    settingsMod.set({ msClientId: cid });
    let cloud = null;
    try { cloud = await nxCloud.api.rebindIdentity(); } catch (e) { cloud = { error: e.message }; }
    try { nxCloud.api.logEvent({ kind: 'identity-edit', details: { uuid, previous: applied.previousUuid || '' } }); } catch {}
    return {
      applied, cloud,
      identity: identity.getIdentity(),
      msClientId: settingsMod.get().msClientId,
    };
  });

  /* ================================================================= v1.0
     OWNER DEVICE GRANT — the owner key is typed ONCE (Settings Owner Console
     or the ANNOUNCEMENTS tab); a correct key grants the session instantly,
     persists a sealed grant in .neurax and mirrors it to the cloud. On the
     next launch the saved grant auto-restores: the device stays granted
     without re-typing, as long as the key itself has not changed. */
  handle('owner:verifyKey', (p) => ownerGrant.verify((p && p.pass) || ''));
  handle('owner:grantStatus', () => ownerGrant.status());
  handle('owner:revoke', (p) => ownerGrant.revoke({ forget: !!(p && p.forget) }));

  /* ================================================================= v1.0
     NEURAX CLIENT — the optimization stack (Sodium + Lithium + Iris + C2ME +
     FerriteCore + ImmediatelyFast + EntityCulling + Krypton + Dynamic FPS +
     the bundled NX core) for Fabric/Quilt instances. */
  handle('client:status', () => client.status());
  handle('client:inject', (p) => client.injectInstance({ instanceId: p.instanceId, force: !!p.force, source: 'manual' }));
  handle('client:uninject', (p) => client.uninjectInstance({ instanceId: p.instanceId }));
  handle('client:clearCache', () => client.clearResolveCache());

  /* ================================================================= v4.5
     OWNER CONSOLE — the launcher's own "about this app's files" panel.
     Every file Neurax creates is listed; sealed (encrypted) files can be
     VIEWED DECRYPTED and EDITED (re-sealed on save); the data folder can be
     unlocked for deletion or fully wiped (factory reset). Sensitive actions
     are passkey-gated. v4.5: the owner keys are FIXED (nx-canonical.js) and
     are NEVER displayed in the UI — the reveal/rotate/first-run-banner
     feature was removed by the owner's request. */

  // helper: every sensitive Owner Console action requires owner access —
  // v1.0: EITHER the device grant (typed once / auto-restored) OR the key
  // passed with THIS call (so one wrong follow-up can never undo a success).
  const requireOwnerPass = (p) => {
    if (ownerGrant.isGranted()) return true;
    const got = String((p && p.pass) || '');
    const want = nxKeys.UNLOCK_PASSKEY || nxVault.launcherVault().get().unlockPasskey;
    if (got && got === want) {
      try { ownerGrant.verify(got); } catch { /* persistence is best-effort */ }
      try { nxVault.noteAdminUnlock(); } catch {}
      return true;
    }
    throw new Error('Wrong owner key.');
  };

  const SEALED_MAGIC = Buffer.from('NXVB1\0', 'ascii');
  const isSealedFile = (f) => {
    try { const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(6); fs.readSync(fd, b, 0, 6, 0); return b.equals(SEALED_MAGIC); } finally { fs.closeSync(fd); } } catch { return false; }
  };

  // curated file map: everything the launcher itself creates (no game dirs)
  const ownerFiles = () => {
    const entries = [];
    const push = (dir, names) => {
      for (const n of names) {
        const f = path.join(dir, n);
        let bytes = 0, mtime = 0, exists = false;
        try { const st = fs.statSync(f); bytes = st.size; mtime = st.mtimeMs; exists = true; } catch {}
        if (!exists) continue;
        entries.push({ name: n, dir: path.basename(dir) === path.basename(DIRS.root) ? '' : path.basename(dir), file: f, bytes, mtime, sealed: isSealedFile(f) });
      }
    };
    push(DIRS.root, ['keys.vault', 'nx-keys.local.json', 'settings.vault', 'settings.json', 'vault.bin', 'cc-vault.bin', 'identity-cache.vault', 'device-grant.vault', 'instances.json', 'servers.json', '.vk', '.nx-lock']);
    push(DIRS.auth, ['tokens.vault', 'tokens.json']);
    push(path.join(DIRS.root, 'identity'), ['device-identity.json']);
    return entries;
  };

  handle('owner:keysStatus', () => {
    const set = settingsMod.get();
    const source = nxKeys.KEYS_SOURCE;
    // v4.5 — metadata ONLY: no key material is ever sent to the renderer.
    return {
      source,
      sourceLabel: source === 'env' ? 'Environment variables (this session)'
        : source === 'sealed' ? 'Sealed key vault (.neurax/keys.vault — encrypted)'
        : source === 'canonical' ? 'Owner fixed key — sealed key vault (.neurax/keys.vault)'
        : source === 'file' ? 'Legacy plaintext key file (read-only data root)'
        : source === 'vault-ephemeral' ? 'In-memory only (vault mirror)'
        : 'Owner fixed key (in-memory seed)',
      keysFile: nxKeys.sealedKeysFile(),
      ackedAt: set.keysAcknowledgedAt || null,
      firstRunPending: false, // v4.5 — the first-run key banner was removed
    };
  });

  // v4.5 — the key-display channels (first-run banner, acknowledge, reveal,
  // rotate) were REMOVED by the owner's request: the fixed owner key
  // (nx-canonical.js) is never displayed in the settings tab, and rotation
  // from the UI is gone. The key material lives only in the sealed key vault
  // on each machine.

  handle('owner:listFiles', (p) => {
    requireOwnerPass(p);
    return { root: DIRS.root, files: ownerFiles() };
  });

  handle('owner:readFile', (p) => {
    requireOwnerPass(p);
    const f = String((p && p.file) || '');
    // path must be one of the curated entries — no arbitrary file reads
    const entry = ownerFiles().find((e) => e.file === f);
    if (!entry) throw new Error('This file is not part of the launcher data set.');
    if (entry.sealed) {
      const data = nxVault.readSealed(path.dirname(entry.file), entry.file);
      return { name: entry.name, sealed: true, kind: 'json', content: JSON.stringify(data ?? {}, null, 2) };
    }
    if (entry.name === '.vk') return { name: entry.name, sealed: false, kind: 'binary', content: '', note: '32 machine-bound random bytes — the encryption root. Never copy it between PCs.' };
    if (entry.name.endsWith('.json') || entry.name === '.nx-lock') {
      return { name: entry.name, sealed: false, kind: 'json', content: fs.readFileSync(entry.file, 'utf8') };
    }
    return { name: entry.name, sealed: false, kind: 'binary', content: '', note: 'Binary encrypted vault file.' };
  });

  handle('owner:writeFile', (p) => {
    requireOwnerPass(p);
    const f = String((p && p.file) || '');
    const content = String((p && p.content) ?? '');
    const entry = ownerFiles().find((e) => e.file === f);
    if (!entry) throw new Error('This file is not part of the launcher data set.');
    if (entry.name === '.vk' || entry.name === 'vault.bin' || entry.name === 'cc-vault.bin') {
      throw new Error('This file is managed by the engine and cannot be edited here.');
    }
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('Invalid JSON — fix the syntax and try again.'); }
    if (entry.sealed) {
      nxVault.writeSealed(path.dirname(entry.file), entry.file, parsed); // re-sealed instantly
      return { ok: true, sealed: true };
    }
    if (entry.name.endsWith('.json')) {
      pathsMod.writeJSON(entry.file, parsed);
      return { ok: true, sealed: false };
    }
    throw new Error('This file cannot be edited.');
  });

  /** Strip launcher write-protections recursively (chmod only — attributes are
   *  handled by device-identity.unprotectAll / attrib on Windows) so Explorer
   *  can always delete/move the folder. Capped for huge game folders. */
  const releaseTree = (dir, cap = 20000) => {
    let n = 0;
    const walk = (d) => {
      if (n >= cap) return;
      let list = [];
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (n >= cap) return;
        const f = path.join(d, e.name);
        try {
          if (e.isDirectory()) { walk(f); continue; }
          fs.chmodSync(f, 0o666);
          n++;
        } catch { /* best effort */ }
      }
    };
    walk(dir);
    return n;
  };

  handle('owner:unlockData', async (p) => {
    requireOwnerPass(p);
    const releasedIdentity = await identity.unprotectAll();
    const unlocked = releaseTree(DIRS.root);
    logger.core.info(`Owner Console: data folder unlocked (identity anchors: ${releasedIdentity.length}, files chmod'd: ${unlocked})`);
    return { releasedIdentity, unlocked, root: DIRS.root };
  });

  handle('owner:wipeAll', async (p) => {
    requireOwnerPass(p);
    if (String((p && p.confirm) || '').trim().toUpperCase() !== 'DELETE') {
      throw new Error('Type DELETE to confirm the full factory reset.');
    }
    // stop everything the launcher runs
    try { require('./core/game').stopGame(); } catch {}
    try { for (const r of require('./core/servers').listRunning() || []) { try { require('./core/servers').forceKill(r); } catch {} } } catch {}
    const releasedIdentity = await identity.unprotectAll();
    const unlocked = releaseTree(DIRS.root);
    const { shell } = require('electron');
    const { app } = require('electron');
    const results = { identityAnchors: releasedIdentity, unlockedFiles: unlocked, trashed: [], errors: [] };
    for (const dir of [DIRS.root, identity.protectedDir()]) {
      try {
        if (fs.existsSync(dir)) {
          const ok = await shell.trashItem(dir);
          results.trashed.push({ dir, ok });
          if (!ok) results.errors.push(`Could not move ${dir} to the Recycle Bin (a file may be open — close the game/editors and try again).`);
        }
      } catch (e) { results.errors.push(`${dir}: ${e.message}`); }
    }
    try { nxCloud.api.logEvent({ kind: 'factory-reset', details: { errors: results.errors.length } }); } catch {}
    // relaunch into a fresh first-run (new identity, new keys → disclosure banner)
    const hardFail = results.errors.length && !results.trashed.some((t) => t.dir === DIRS.root && t.ok);
    if (!hardFail) {
      setTimeout(() => { try { app.relaunch(); app.exit(0); } catch {} }, 1200);
    }
    return results;
  });

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
