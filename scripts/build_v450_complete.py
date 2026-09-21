#!/usr/bin/env python3
# build_v450_complete.py — THE GRAND COMBINED DELIVERABLE (v4.5.0).
#
# Packages EVERYTHING from every chat into ONE zip:
#   neurax-launcher/        the COMPLETE launcher source (every file, incl.
#                           nx-cloud, supabase, scripts, docs, vendor)
#   extras/website/         the dytalmc.github.io SEO website pack (from the
#                           earlier NeuraX-Launcher-Website-SEO-Pack.zip)
#   extras/Windows/app.manifest  the real Windows XML app manifest
#   extras/screenshots/     Owner Console UI preview
#   extras/README-FIRST.md  what is inside + how to use every piece
#
# Private artifacts are EXCLUDED by design:
#   nx-keys.local.json, keys.vault, .vk, vault.bin, cc-vault.bin, .nx-lock,
#   settings.vault, tokens.vault, identity-cache.vault, node_modules, logs.
#
# v4.5 secret policy: the OWNER'S FIXED key (AAhdswedgjihsedfyg2346283jsd!)
# and the owner Supabase connection string are INTENTIONALLY part of the
# source (nx-canonical.js — the owner's explicit choice). The build therefore
# asserts those are PRESENT, while every BURNED credential from older builds
# must NEVER appear: the two pre-public baked keys, the v4.1.1 rotated pair.
#
# Verification battery (v4.5): canonical key + database markers, sealed key
# vault, offline-first pickMode, Owner Console channels without key display,
# watchdog, website files present, zero burned secrets.
# Run:  python3 scripts/build_v450_complete.py
import os, sys, json, hashlib, zipfile, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ = os.path.dirname(ROOT)                      # /home/z/my-project
OUT_DIR = os.environ.get('NX_OUT_DIR', os.path.join(PROJ, 'download'))
NAME = 'Neurax-Launcher-v4.5.0-COMPLETE.zip'
DEST = os.path.join(OUT_DIR, NAME)

WEBSITE_ZIP = os.path.join(OUT_DIR, 'NeuraX-Launcher-Website-SEO-Pack.zip')
MANIFEST = os.path.join(OUT_DIR, 'app.manifest')
SCREENSHOT = os.path.join(PROJ, 'tmp', 'owner-console-preview.png')

EXCLUDE_DIRS = {'node_modules', '.git', '.neurax', '__pycache__', '.vscode', '.idea'}
EXCLUDE_FILES = {
    'nx-keys.local.json', 'nx-keys.local.json.bak',   # PRIVATE owner keys — NEVER ship
    'vault.bin', 'cc-vault.bin', '.vk', 'keys.vault', # runtime secrets / sealed data
    'settings.vault', 'tokens.vault', 'identity-cache.vault', '.nx-lock',
}
EXCLUDE_EXT = {'.log', '.tmp'}

def included(rel):
    parts = rel.replace('\\', '/').split('/')
    if any(p in EXCLUDE_DIRS for p in parts[:-1]) or parts[0] in EXCLUDE_DIRS:
        return False
    base = parts[-1]
    if base in EXCLUDE_FILES:
        return False
    if os.path.splitext(base)[1] in EXCLUDE_EXT:
        return False
    if '.corrupt-' in base:
        return False
    return True

files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
    for fn in filenames:
        rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
        if included(rel):
            files.append(rel.replace('\\', '/'))
files.sort()

os.makedirs(OUT_DIR, exist_ok=True)
if os.path.exists(DEST):
    os.remove(DEST)

README = '''# Neurax Launcher v4.5.0 — COMPLETE PACKAGE

One zip with everything built across every chat. Start here.

## What is inside

| Folder | What it is |
|---|---|
| `neurax-launcher/` | The COMPLETE launcher source (Electron, Windows x64). Every feature from v1.0 to v4.5: real Minecraft launching (vanilla/fabric/forge/neoforge/quilt), instances, servers, Modrinth + CurseForge UIs, NX Cloud (chat/DMs/voice/announcements/remote control) connected out of the box, sealed encrypted storage, Owner Console. |
| `extras/website/` | The dytalmc.github.io website (index.html, 404, robots.txt, sitemap.xml, Jekyll `_config.yml`, CSS/JS, favicon). Push to your GitHub repo `Dytalmc/Dytalmc.github.io` as-is. |
| `extras/Windows/app.manifest` | The real Windows XML manifest (DPI awareness / long-path aware). |
| `extras/screenshots/` | UI preview of the new Owner Console. |

## First steps with the launcher

    cd neurax-launcher
    npm install
    npm start            # dev run
    npm run dist         # build the Windows .exe (electron-builder)

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
    node scripts/probe-v45.js          # 12 checks — this release
    node scripts/probe-v44.js && node scripts/probe-v43.js && node scripts/probe-v42.js && node scripts/probe-v41.js
    node scripts/probe-vault.js        # 22 checks — vault tamper-healing

Full history: `neurax-launcher/PATCH-NOTES.md`.
'''

with zipfile.ZipFile(DEST, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in files:
        z.write(os.path.join(ROOT, rel), 'neurax-launcher/' + rel)
    # ---- extras from the other chats ----
    z.writestr('extras/README-FIRST.md', README)
    if os.path.exists(MANIFEST):
        z.write(MANIFEST, 'extras/Windows/app.manifest')
    if os.path.exists(SCREENSHOT):
        z.write(SCREENSHOT, 'extras/screenshots/owner-console-settings.png')
    if os.path.exists(WEBSITE_ZIP):
        with zipfile.ZipFile(WEBSITE_ZIP) as wz:
            for n in wz.namelist():
                if n.endswith('/'):
                    continue
                z.writestr('extras/website/' + n, wz.read(n))

# ---------------- verification ----------------
# BURNED credentials that must NEVER ship again:
#   - the two pre-public baked secrets (v3 era)
#   - the v4.1.1-rotated admin key + passkey (superseded by the owner's fixed key in v4.5)
FORBIDDEN = [b'sINm6w7h8PfCelSnlirOhgTPq2wSd03X',
             b'Auiwadhagwid156!78hduZaAgd768@ahwiZ',
             b'CZgIVoKMuwv5uUr-pv7CXeZtrIVMjM6J',
             b'fyLtEIb9pKi7IaQX5fxB8gOWkf5MiUAKzfNkpRyE_xU']
with zipfile.ZipFile(DEST) as z:
    assert z.testzip() is None, 'corrupt member'
    names = z.namelist()
    # 1. private files must NOT be in the zip
    for n in names:
        assert 'nx-keys.local.json' not in n, f'PRIVATE key file leaked into zip: {n}'
        assert not n.endswith(('.vk', 'vault.bin', 'cc-vault.bin', 'settings.vault', 'tokens.vault',
                               'identity-cache.vault', 'keys.vault', '.nx-lock')), f'runtime secret in zip: {n}'
    # 2. no burned secrets anywhere (guard build scripts excluded from the scan)
    guard_re = re.compile(r'^neurax-launcher/scripts/build_v\d+(_full|_complete)?\.py$')
    blob = b''.join(z.read(n) for n in names
                    if n.endswith(('.js', '.json', '.md', '.html', '.sql', '.py', '.bat', '.txt', '.yml'))
                    and not guard_re.match(n))
    for secret in FORBIDDEN:
        assert secret not in blob, f'BURNED SECRET FOUND in zip: {secret[:12]}...'
    # 3. required launcher files
    required = [
        'neurax-launcher/package.json',
        'neurax-launcher/src/main/main.js',
        'neurax-launcher/src/main/core/auth.js',
        'neurax-launcher/src/main/core/settings.js',
        'neurax-launcher/src/main/core/nx-canonical.js',
        'neurax-launcher/src/main/core/nx-seal.js',
        'neurax-launcher/src/main/core/nx-vault.js',
        'neurax-launcher/src/main/core/nx-admin-keys.js',
        'neurax-launcher/src/main/core/nx-cloud.js',
        'neurax-launcher/src/main/core/device-identity.js',
        'neurax-launcher/src/main/core/game.js',
        'neurax-launcher/src/main/core/msa-window.js',
        'neurax-launcher/nx-cloud/control-center.js',
        'neurax-launcher/supabase/nx-supabase-setup.sql',
        'neurax-launcher/PATCH-NOTES.md',
        'neurax-launcher/scripts/probe-v44.js',
        'neurax-launcher/scripts/probe-v45.js',
        'neurax-launcher/scripts/smoke-nx-keys.js',
        'neurax-launcher/scripts/rotate-nx-keys.js',
        'neurax-launcher/.gitignore',
        'extras/README-FIRST.md',
        'extras/website/index.html',
        'extras/Windows/app.manifest',
        'extras/screenshots/owner-console-settings.png',
    ]
    for r in required:
        assert r in names, f'missing required file: {r}'
    # 4. v4.5.0 feature markers inside the shipped sources
    pkg = json.loads(z.read('neurax-launcher/package.json'))
    assert pkg['version'] == '4.5.0', f"package version is {pkg['version']}, expected 4.5.0"
    canon_src = z.read('neurax-launcher/src/main/core/nx-canonical.js').decode('utf8')
    keys_src = z.read('neurax-launcher/src/main/core/nx-admin-keys.js').decode('utf8')
    seal_src = z.read('neurax-launcher/src/main/core/nx-seal.js').decode('utf8')
    vault_src = z.read('neurax-launcher/src/main/core/nx-vault.js').decode('utf8')
    cloud_src = z.read('neurax-launcher/src/main/core/nx-cloud.js').decode('utf8')
    game_src = z.read('neurax-launcher/src/main/core/game.js').decode('utf8')
    ipc_src = z.read('neurax-launcher/src/main/ipc.js').decode('utf8')
    ident_src = z.read('neurax-launcher/src/main/core/device-identity.js').decode('utf8')
    settings_src = z.read('neurax-launcher/src/main/core/settings.js').decode('utf8')
    cc_src = z.read('neurax-launcher/nx-cloud/control-center.js').decode('utf8')
    # the owner's fixed key + database are intentionally part of the source
    assert "OWNER_KEY = 'AAhdswedgjihsedfyg2346283jsd!'" in canon_src, 'fixed owner key missing'
    assert 'OWNER_SUPABASE_URL' in canon_src and 'OWNER_SUPABASE_URL' in settings_src, 'owner database default missing'
    assert "require('./nx-canonical')" in keys_src, 'key resolver must use the canonical config'
    assert 'SEED_VERSION' in keys_src, 'seed-version re-seed guard missing'
    assert "VAULT_NAME = 'keys.vault'" in keys_src, 'sealed key vault missing'
    assert 'shredPlaintext' in keys_src, 'plaintext shred missing'
    assert 'function writeSealed' in seal_src and 'function readSealed' in seal_src, 'sealed primitives must live in nx-seal.js'
    assert 'seal.readSealed' in vault_src, 'vault must delegate to nx-seal'
    assert 'function pickMode' in cloud_src and "return 'offline'" in cloud_src, 'offline-first missing'
    assert 'closeLauncherOnLaunch' in game_src and 'armWatchdog' in game_src, 'close-on-launch missing'
    # key display removed; console channels intact
    for gone in ('owner:keysReveal', 'owner:keysRotate', 'owner:keysFirstRun', 'owner:keysAcknowledge'):
        assert gone not in ipc_src, f'key-display channel still shipped: {gone}'
    for ch in ('owner:keysStatus', 'owner:listFiles', 'owner:readFile', 'owner:writeFile',
               'owner:unlockData', 'owner:wipeAll'):
        assert ch in ipc_src, f'owner console channel missing: {ch}'
    assert 'settings.vault' in cc_src and 'readSealed' in cc_src, 'control-center must read the SEALED settings'
    assert 'nx-canonical.js' in cc_src, 'control-center must default to the owner database'
    assert 'softProtectWin' in ident_src, 'delete-safe protection missing'
    assert 'closeLauncherOnLaunch: false' in settings_src, 'settings default missing'

size = os.path.getsize(DEST)
sha = hashlib.sha256(open(DEST, 'rb').read()).hexdigest()
with open(DEST + '.sha256', 'w') as f:
    f.write(sha + '  ' + NAME + '\n')

print(json.dumps({
    'zip': DEST,
    'files': len(names),
    'bytes': size,
    'sha256': sha,
    'excluded': 'node_modules/, .git/, nx-keys.local.json (PRIVATE), keys.vault/.vk/vaults, logs',
}, indent=2))
print('COMPLETE ZIP OK')
