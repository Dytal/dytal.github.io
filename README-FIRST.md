# Neurax Launcher v4.6.0 — COMPLETE PACKAGE

One zip with everything built across every chat. Start here.

## What is inside

| Folder | What it is |
|---|---|
| `neurax-launcher/` | The COMPLETE launcher source (Electron, Windows x64). Every feature from v1.0 to v4.6: real Minecraft launching (vanilla/fabric/forge/neoforge/quilt), instances, servers, Modrinth UI, NX Cloud (chat/DMs/voice/announcements/remote control) connected out of the box, sealed encrypted storage, Owner Console, and the v4.6 CRASH DOCTOR (exit-code diagnosis, auto SAFE MODE, memory clamping for integrated GPUs). |
| `extras/website/` | The dytal.github.io website (index.html, 404, robots.txt, sitemap.xml, Jekyll `_config.yml`, CSS/JS, favicon). Push to your GitHub repo `Dytal/Dytal.github.io` as-is. |
| `extras/Windows/app.manifest` | The real Windows XML manifest (DPI awareness / long-path aware). |
| `extras/screenshots/` | UI previews: Owner Console (v4.5) + crash banner with SAFE RELAUNCH (v4.6). |

## First steps with the launcher

    cd neurax-launcher
    npm install
    npm start            # dev run
    npm run dist         # build the Windows .exe (electron-builder)

## v4.6 — the Minecraft crash fix (global versions)

The reported crashes (`3221225477` / 0xC0000005 and `3221226505` /
0xC0000409) on an AMD Radeon(TM) integrated GPU were driver crashes made
worse by launcher settings. Fixed automatically on every launch:

1. **Memory clamping** — integrated GPUs share system RAM, so the heap is
   capped to a safe value (about 60 % of RAM on integrated-only machines).
   The old 14592 MB-on-16 GB starvation can never happen again. The Settings
   slider is capped the same way.
2. **Modern-JDK flags** — launches carry `--enable-native-access=ALL-UNNAMED`
   (Java 21+) and `--sun-misc-unsafe-memory-access=allow` (Java 23+).
3. **Crash Doctor** — exit codes are translated into human explanations, the
   game's own crash report is parsed, history is kept in
   `.neurax/cache/crash-history.json`, and after repeated startup crashes the
   next PLAY runs in **AUTO SAFE MODE**: every resource pack is quarantined
   to `<gameDir>/.nx-safe-mode-backup/` and restored automatically after
   10 clean minutes (or Settings → Diagnostics → Restore packs).
4. **Honest launch args** — `--xuid` / `--clientId` now carry the real Xbox
   id / MSA app id instead of a third copy of the account JWT.
5. **Clean resourcepacks scan** — the `.nx-injected-v3` marker moved out of
   `resourcepacks/` (no more "Found non-pack entry" log spam).

## Your key (v4.5 — FIXED by the owner)

The admin key AND the owner passkey are ONE value you chose:

    AAhdswedgjihsedfyg2346283jsd!

- It works on EVERY installation, on every machine — even after `.neurax`
  (or the whole launcher folder) was deleted: the sealed key vault
  (`.neurax/keys.vault`, AES-256-GCM, machine-bound) is re-seeded with it
  automatically on the next start.
- It is defined ONCE in the source: `neurax-launcher/src/main/core/nx-canonical.js`
  (`OWNER_KEY`). It is NEVER displayed in the Settings tab (that feature was
  removed in v4.5) — you already know it.
- To change it later: edit `OWNER_KEY` in that file (or run
  `node scripts/rotate-nx-keys.js <backup.txt> --random`) and rebuild; the
  new release migrates every installation on first launch.

## NX Cloud / Supabase (v4.5 — works out of the box)

- Every launcher connects DIRECTLY to the owner's Supabase database on first
  start — chat, DMs, friends, voice, announcements, remote lock and the
  blocklist all work without the NX Cloud Control Center ever having run.
- The connection string lives in ONE place: `OWNER_SUPABASE_URL` in
  `neurax-launcher/src/main/core/nx-canonical.js`. If you reset the database
  password in the Supabase dashboard, paste the new connection string there
  and rebuild.
- The NEURAX CONTROL CENTER (`neurax-launcher/nx-cloud/`,
  `START-CONTROL-CENTER.bat`) reads/writes the SAME encrypted settings and
  the SAME database — announcements and locks you publish reach every
  launcher within 5 seconds, and it logs in with the same fixed owner key.
- Database tables: run `supabase/nx-supabase-setup.sql` once in the Supabase
  SQL editor (already done for the owner's project).

## Sign-in (v4.4+)

Settings → "Sign in with Microsoft" → the embedded sign-in window
(oauth20_desktop.srf — the only redirect the official Minecraft app id has).
Zero config. Device codes / system-browser flows need your own Azure app id
(explained in-app, NX Admin → Device & login IDs).

## Verification batteries (run before shipping)

    node scripts/check-syntax.js
    node scripts/smoke-nx-keys.js      # 28 checks — fixed-key storage
    node scripts/probe-v46.js          # 20 checks — this release
    node scripts/probe-v45.js && node scripts/probe-v44.js && node scripts/probe-v43.js && node scripts/probe-v42.js && node scripts/probe-v41.js
    node scripts/probe-vault.js        # 22 checks — vault tamper-healing

Full history: `neurax-launcher/PATCH-NOTES.md`.
