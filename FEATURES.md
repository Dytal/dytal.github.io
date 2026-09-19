==============================================================
  NEURAX LAUNCHER - FEATURE LIST
  Version 1.0.0
==============================================================

Owner : Anish Sandeep Bhargav  (Minecraft username: Dytalmc)
Copyright (c) 2026 Anish Sandeep Bhargav. All rights reserved.

SCOPE
This document lists every user-facing feature of Neurax
Launcher. Internal management consoles and administrative
features - the NeuraX Control Center, the NX Admin panel, and
every administrative action (remote device locking, lock
messages, announcement publishing, user management) - are
reserved for the owner alone and are intentionally NOT
included in this list.

--------------------------------------------------------------
1. GAME PLAY
--------------------------------------------------------------
- Big one-click PLAY button.
- Plays the currently selected instance.
- Or plays a base vanilla version picked from VERSIONS
  (worlds, libraries and servers are kept in a shared global
  .minecraft folder).
- Real game process: real Mojang libraries and assets, real
  progress - no simulated progress bars.

--------------------------------------------------------------
2. VERSIONS
--------------------------------------------------------------
- Every Mojang version ever released: Releases, Snapshots,
  Beta and Alpha.
- Auto-updating version manifest - new Minecraft versions
  appear automatically (manifest refresh on startup).
- Searchable list with group tabs and 4 rows visible at a
  time with smooth scrolling.

--------------------------------------------------------------
3. INSTANCES AND MOD LOADERS
--------------------------------------------------------------
- Instance system: create instances with name, Minecraft
  version, mod loader, loader version and memory.
- Supported loaders: vanilla, Fabric, Forge, NeoForge, Quilt.
- Forge and NeoForge are installed by their official
  installers (headless) and launched with a fully merged
  version JSON.
- Per-instance .minecraft folders: worlds, mods, resource
  packs, options.txt.
- Single-click selects an instance, double-click edits it.
- The INSTANCE menu resizes dynamically with the instance
  count.

--------------------------------------------------------------
4. SERVER MANAGER
--------------------------------------------------------------
- Local server engine supporting: Paper, Vanilla, Fabric,
  Forge, NeoForge, Quilt and Spigot.
- Create servers with name, type, version, memory, port and
  MOTD.
- Start / stop servers directly from the launcher.
- Live console with command input (send commands to the
  running server).
- File inspector with an auto-saving text editor.
- NBT explorer: edit level.dat-style values plus a read-only
  region view.
- Honest Spigot handling: downloads the official
  BuildTools.jar for you, or accepts a dropped-in spigot jar.

--------------------------------------------------------------
5. MODRINTH STOREFRONT
--------------------------------------------------------------
- Full in-app storefront mirroring modrinth.com - no API key
  needed.
- Search with filters: project type, loaders, categories,
  game-version dropdown and a match-my-instance switch.
- Featured grid and full project pages (description,
  gallery, version list).
- Install any specific file version of mods, resource packs,
  shaders and .mrpack modpacks.
- Install targets: any existing instance, the global folder,
  or a brand-new instance created right inside the install
  dialog (with its own MC version and loader).
- Progress toasts during downloads and installation.

--------------------------------------------------------------
6. ACCOUNTS AND LOGIN
--------------------------------------------------------------
- One-click Microsoft login (device code flow): a device code
  appears in the launcher, the browser opens automatically,
  type the code - the launcher completes the login by itself
  (XBL -> XSTS -> Minecraft services).
- Works out of the box with a built-in client id; using your
  own Azure client id is optional (Settings -> Advanced).
- Offline mode included.
- Microsoft tokens are encrypted with DPAPI via Electron
  safeStorage - plaintext tokens are never written to disk.
- Encrypted memory vault remembers your logins (offline
  names and Microsoft accounts) so one click re-fills a name
  you used before.

--------------------------------------------------------------
7. JAVA RUNTIMES
--------------------------------------------------------------
- Auto-detects installed system Java (Program Files,
  Adoptium, Corretto, Zulu, BellSoft, ~/.jdks and more).
- Automatically downloads the correct Temurin runtime
  (Java 8 / 16 / 17 / 21 / 25, depending on the Minecraft
  version) into .neurax/runtimes when needed.

--------------------------------------------------------------
8. NX CLOUD (USER SIDE)
--------------------------------------------------------------
- Connect the launcher to NX Cloud on your own Supabase
  PostgreSQL database.
- Device-bound NX identity.
- ANNOUNCEMENTS tab - read announcements inside the launcher
  with an automatic 60-second (1-minute) auto refresher that
  only re-renders when the content actually changes.
- Cloud chat (rich content up to 100 MB).
- Invites.
- 3D skin heads rendered in the UI.
- Offline grace - the launcher stays usable when the cloud
  is unreachable.
- 5-second live refresh for cloud data while connected.

--------------------------------------------------------------
9. SECURITY AND DATA PROTECTION
--------------------------------------------------------------
- Encrypted, read-only memory vault (AES-256-GCM with a
  machine-bound key file): remembered logins are stored
  encrypted - the file is unreadable garbage on any other
  PC, locked read-only, and tamper-healing (a force-edited
  file is quarantined and rebuilt automatically).
- Microsoft login tokens encrypted with DPAPI (safeStorage).
- Secure renderer bridge (contextIsolation) with a typed IPC
  surface only.
- Single-owner access model - only the owner has access and
  administrative rights over the launcher.

--------------------------------------------------------------
10. INTERFACE AND EXPERIENCE
--------------------------------------------------------------
- Clean desktop UI: Play, Versions, Instances, Servers,
  Modrinth, Announcements and Settings.
- Four instant UI themes: Emerald, Orange, Purple, Cyan.
- Window opens at 1200x800, resizable, maximizable, F11
  fullscreen - remembers its size; every component is
  responsive.
- Separate logs popup window (game / launcher / download
  logs, filterable, close/min/max) - logs are also written
  to .neurax/logs/.
- Toasts, modals, dropdowns and smooth page transitions.
- No terminal windows - ever (every spawned process is
  console-hidden).
- NX-UI 64x resource pack included.
