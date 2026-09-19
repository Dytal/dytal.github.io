==============================================================
  NEURAX LAUNCHER - PRIVACY POLICY
  Version 1.0.0 | Effective date: September 20, 2026
==============================================================

Owner and operator : Anish Sandeep Bhargav
Minecraft username : Dytalmc
Applies to         : Neurax Launcher (the "Launcher", the "App")

--------------------------------------------------------------
1. WHO WE ARE
--------------------------------------------------------------
Neurax Launcher is developed, owned and operated solely by
Anish Sandeep Bhargav (Minecraft username: Dytalmc). This
policy explains what data the Launcher stores, what it sends
over the internet, and how that data is protected. The
Launcher is not affiliated with Mojang, Microsoft, Modrinth
or Supabase; those services have their own privacy policies.

--------------------------------------------------------------
2. DATA STORED LOCALLY ON YOUR PC
--------------------------------------------------------------
The Launcher keeps all of its data in a single folder
(%APPDATA%\.neurax\ on Windows), which contains:

- settings.json - your launcher settings.
- instances.json / servers.json - your instances and servers.
- global/.minecraft/ and instances/<id>/.minecraft/ - game
  files, libraries, assets, worlds, mods and resource packs.
- servers/<id>/ - each server's jar, world, properties and
  logs.
- runtimes/ - auto-downloaded Java runtimes.
- cache/ - version manifests and API caches (safe to clear).
- logs/ - launcher log files.
- auth/ - Microsoft login tokens, ENCRYPTED with the Windows
  DPAPI provider through Electron safeStorage. Plaintext
  tokens are never written to disk.
- vault.bin - the encrypted memory vault (see section 3).
- .vk - a 32-byte machine-bound key file used to derive the
  vault encryption key.
- assets/ - skin and image caches.

All of this stays on your PC. None of it is transmitted to
the owner.

--------------------------------------------------------------
3. THE ENCRYPTED MEMORY VAULT
--------------------------------------------------------------
The Launcher remembers your logins (offline names and
Microsoft accounts) and the owner's access keys inside an
encrypted, read-only vault file:

- ENCRYPTED: AES-256-GCM authenticated encryption. The key is
  derived from a random per-machine key file (.vk) mixed with
  a pepper baked into the build. The vault file alone is
  unreadable on any other PC, and the key file alone is
  meaningless random bytes. Opening the vault in an editor
  shows only ciphertext - no plaintext logins or keys.
- READ-ONLY: the file is locked read-only after every write,
  so editors refuse to save changes back to it.
- TAMPER-HEALING: if the file is force-edited anyway, its
  cryptographic tag rejects the change; the broken file is
  quarantined and a fresh vault is built automatically.

You can delete the vault file at any time - it safely
rebuilds on the next start, and you can never be locked out.

--------------------------------------------------------------
4. DATA SENT OVER THE INTERNET
--------------------------------------------------------------
The Launcher talks directly to official, public APIs so it
can function. It sends only the technical requests needed
for the feature you are using:

- Mojang (piston-meta) - the Minecraft version manifest.
- Fabric / Quilt meta, Forge and NeoForge maven - loader
  information and installers.
- PaperMC - Paper server jars.
- Adoptium - Java runtime downloads.
- Modrinth (v2 API) - search results, project pages and
  mod / resource pack / shader / modpack downloads.
- Microsoft / Xbox Live / XSTS / Minecraft services - only
  when you sign in with Microsoft (device code login).

The Launcher contains NO analytics, NO telemetry and NO
tracking. Nothing is reported back to the owner. Your data
is never sold or rented to anyone.

--------------------------------------------------------------
5. MICROSOFT ACCOUNT DATA
--------------------------------------------------------------
When you use one-click Microsoft login:
- The Launcher receives your Minecraft profile (username,
  UUID and skin) and access tokens.
- Tokens are stored only on your PC, encrypted with DPAPI
  (see section 2), and are used only to start the game with
  your account.
- You stay signed in across restarts via silent session
  restore; logging out removes the stored tokens.
- Offline mode stores only the username you type, locally.

--------------------------------------------------------------
6. NX CLOUD DATA (YOUR OWN DATABASE)
--------------------------------------------------------------
If you connect NX Cloud, the Launcher stores cloud data
(device identity, announcements, chat messages, invite
state) in the Supabase PostgreSQL database that YOU supply.
That database is yours and lives under your own account -
nobody else has access to it. If you never connect NX Cloud,
no cloud data exists.

--------------------------------------------------------------
7. WHO CAN ACCESS YOUR DATA
--------------------------------------------------------------
- Local data: only you (and programs you run on your PC).
- Cloud data: only holders of your own database credentials.
- The Launcher has no backdoor for third parties: no one
  other than the owner of the App is granted any access,
  administrative rights or control, and no third party can
  reach your local files or your database through it.

--------------------------------------------------------------
8. DATA RETENTION AND DELETION
--------------------------------------------------------------
You keep full control:
- Delete %APPDATA%\.neurax\ to erase every trace of the
  Launcher (settings, instances, servers, logs, tokens,
  vault) from your PC.
- Logging out removes stored Microsoft tokens.
- Deleting your cloud database (or the rows in it) erases
  your cloud data.
- Uninstalling the Launcher does not delete
  %APPDATA%\.neurax\ - remove the folder manually if you
  want a full cleanup.

--------------------------------------------------------------
9. CHILDREN'S PRIVACY
--------------------------------------------------------------
The Launcher is a game launcher and does not knowingly
collect personal information from anyone, because it does
not send any personal information to anyone at all.
Microsoft account handling for children is governed by
Microsoft's own policies when you sign in.

--------------------------------------------------------------
10. SECURITY
--------------------------------------------------------------
Your data is protected with: DPAPI-encrypted login tokens,
AES-256-GCM encrypted read-only vault storage, Electron
contextIsolation with a typed IPC surface, and no network
service opened on your PC by default. No method of
transmission or storage is 100% secure, but the Launcher is
built so that nobody ever needs your data in the first
place.

--------------------------------------------------------------
11. CHANGES TO THIS POLICY
--------------------------------------------------------------
If this policy changes, the new version will be published
together with the release it applies to, and the version
number and effective date at the top of this file will be
updated.

--------------------------------------------------------------
12. CONTACT
--------------------------------------------------------------
Owner: Anish Sandeep Bhargav
Minecraft username: Dytalmc

Copyright (c) 2026 Anish Sandeep Bhargav. All rights reserved.
