# Neurax Launcher

A real, production-grade Minecraft launcher, instance manager and server manager —
built by **Anish Sandeep Bharagav**.

Everything is real: real Mojang version manifest (every release & snapshot ever, auto-updating),
real Fabric / Quilt / Forge / NeoForge installation, real Microsoft login, real Modrinth
browsing & installing, real local server engine with a live console and an NBT file
inspector. No simulations, no fake progress bars.

---

## Feature overview

| Area | What it does |
|---|---|
| **Play** | Big PLAY button. Plays the selected instance — or, if you picked a version from VERSIONS, plays the base vanilla version of it (worlds/libraries/servers saved into `.neurax/global/.minecraft`). |
| **Versions** | Every Mojang version: Releases, Snapshots, Beta, Alpha — searchable, grouped, 4 rows visible at a time with scrolling. New versions appear automatically (manifest auto-refresh on startup). |
| **Loaders** | Instances: **vanilla, fabric, forge, neoforge, quilt**. Forge/NeoForge are installed by their official installers (headless), then launched with a fully-merged version JSON. |
| **Instances** | Create with name / version / loader / loader version / memory. INSTANCE menu resizes with the instance count. Single-click selects, double-click edits. |
| **Servers** | **paper, vanilla, fabric, forge, neoforge, quilt, spigot**. Name / type / version / memory / port / MOTD. Start/stop with a **live console** (send commands), plus a **file inspector** with auto-saving text editor and an **NBT explorer** (edit level.dat-style values, read-only region view). |
| **Modrinth** | Full storefront that mirrors modrinth.com: search with filters (type, loaders, categories, game-version dropdown, match-my-instance), featured grid, project pages (description/gallery/versions), and installs of **any specific file version** of mods, resource packs, shaders and `.mrpack` modpacks into any instance, the global folder — or a brand-new instance you create right in the install dialog (its own MC version + loader). No API key needed. |
| **Accounts** | One-click Microsoft login: press LOGIN, a device code appears, the browser opens automatically, type the code — done (XBL → XSTS → Minecraft services). Works out of the box with a built-in client id; own Azure client id optional. Tokens encrypted with DPAPI via safeStorage, offline mode included. |
| **Java** | Auto-detects system Java (Program Files, Adoptium, Corretto, Zulu, BellSoft, `~/.jdks` and more); downloads the correct Temurin runtime (Java 8/16/17/21/25 per MC version) into `.neurax/runtimes` automatically. MC 26.1+ uses Java 25. |
| **Window** | Opens 1200×800, resizable, maximizable, F11 fullscreen; every component is responsive. Remembers size. |
| **Logs** | The terminal icon opens a **separate popup window** with launcher/game/download logs (filterable, close/min/max like any window). Also written to `.neurax/logs/`. |
| **Themes** | Emerald, Orange, Purple, Cyan — instantly switches the whole UI. |
| **No terminal** | Every spawned process is console-hidden, and `electron-builder` builds a windowed exe — no console window, ever. |

## Data layout — `%APPDATA%\.neurax\`

```
.neurax/
├── settings.json            launcher settings
├── instances.json           instance metadata
├── servers.json             server metadata
├── global/.minecraft/       shared versions, libraries, assets + global saves/servers
├── instances/<id>/.minecraft/   per-instance worlds, mods, resource packs, options.txt
├── servers/<id>/            each server's jar, world, server.properties, logs
├── runtimes/                auto-downloaded Java (Temurin)
├── cache/                   version manifests + API caches (safe to clear)
├── logs/                    launcher-YYYY-MM-DD.log
├── auth/                    encrypted Microsoft tokens
└── assets/                  skins & images cache
```

## Run from source (dev)

Requires [Node.js 18+](https://nodejs.org).

```bash
npm install
npm start          # launch the app
npm run test:core  # engine smoke tests (needs internet)
```

## Build the Windows .exe (no console window)

```bash
npm install
npm run dist
```

Output lands in `dist/`:
- `Neurax Launcher Setup 2.0.0.exe` — installer (NSIS)
- `Neurax-Launcher-Portable-2.0.0.exe` — single-file portable

Both are windowed executables: no terminal window appears at any time
(`nsis`/`portable` targets are built from `electron-builder` with no console).
macOS/Linux builds: `npm run dist:all`.

## Microsoft login — one click

Press **LOGIN** (Settings) or **Sign in with Microsoft** in the Account card:

1. A device code appears in the launcher and the Microsoft page opens in your browser automatically.
2. Type the code, approve, done — the launcher completes the login by itself.

Works out of the box. Tokens are stored encrypted in `.neurax/auth/`. Optionally use your
own Azure client id (Settings → Advanced) if you prefer.

## Spigot note (honest limitation)

SpigotMC does not publish server jars directly. For `spigot` servers Neurax downloads the official
**BuildTools.jar** for you; run it once (`java -jar BuildTools.jar`, needs git + JDK) or drop a
`spigot-*.jar` into the server folder — then Start works normally.

## Tech stack

- **Electron 33** (main process = Node.js engine, renderer = vanilla JS + CSS, no build step)
- **minecraft-launcher-core** — vanilla/libraries/assets handling & game process
- Official APIs: Mojang piston-meta, Fabric meta, Quilt meta, Forge files maven, NeoForge maven,
  PaperMC fill v3, Adoptium (Java), Modrinth v2, Microsoft OAuth/XBL/XSTS
- **electron-builder** — windowed exe packaging
- Custom **NBT parser/writer** (gzip, all 13 tag types) for the world/file inspector

## Project layout

```
src/
├── main/                 Node (backend) — no UI
│   ├── main.js           window (1200×800), logs popup, single instance
│   ├── ipc.js            typed IPC surface
│   ├── preload.js        secure bridge (contextIsolation)
│   └── core/             paths, settings, store, logger, net, versions,
│                         java, auth, game, modrinth, servers, nbt, files
└── renderer/             the UI
    ├── index.html / logs.html
    ├── styles/           base, navbar, home, forms, pages, store, logs
    └── js/               state, router, components (dropdown/modal/toast),
                          pages (home, newinstance, newserver, servers,
                          settings, modrinth)
```

---

Neurax Launcher © 2026 Anish Sandeep Bharagav — MIT licensed.
Not affiliated with Mojang, Microsoft or Modrinth.
