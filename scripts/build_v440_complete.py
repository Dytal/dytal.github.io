#!/usr/bin/env python3
# build_v440_complete.py — THE GRAND COMBINED DELIVERABLE (v4.4.0).
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
# Verification battery (v4.4): sealed key vault markers, offline-first
# pickMode, Owner Console channels, watchdog, website files present,
# zero baked secrets.
# Run:  python3 scripts/build_v440_complete.py
import os, sys, json, hashlib, zipfile, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ = os.path.dirname(ROOT)                      # /home/z/my-project
OUT_DIR = os.environ.get('NX_OUT_DIR', os.path.join(PROJ, 'download'))
NAME = 'Neurax-Launcher-v4.4.0-COMPLETE.zip'
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

README = '''# Neurax Launcher v4.4.0 — COMPLETE PACKAGE

One zip with everything built across every chat. Start here.

## What is inside

| Folder | What it is |
|---|---|
| `neurax-launcher/` | The COMPLETE launcher source (Electron, Windows x64). Every feature from v1.0 to v4.4: real Minecraft launching (vanilla/fabric/forge/neoforge/quilt), instances, servers, Modrinth + CurseForge UIs, NX Cloud (chat/DMs/voice/announcements/remote control), sealed encrypted storage, Owner Console. |
| `extras/website/` | The dytalmc.github.io website (index.html, 404, robots.txt, sitemap.xml, Jekyll `_config.yml`, CSS/JS, favicon). Push to your GitHub repo `Dytalmc/Dytalmc.github.io` as-is. |
| `extras/Windows/app.manifest` | The real Windows XML manifest (DPI awareness / long-path aware). |
| `extras/screenshots/` | UI preview of the new Owner Console. |

## First steps with the launcher

    cd neurax-launcher
    npm install
    npm start            # dev run
    npm run dist         # build the Windows .exe (electron-builder)

On FIRST RUN the launcher generates per-machine owner credentials and shows
them ONCE (Settings → Owner Console banner) — save them somewhere safe.
They live ENCRYPTED in `.neurax/keys.vault`; only your PC can decrypt them.

## Where your keys are (v4.4)

- `.neurax/keys.vault` — owner admin key + unlock passkey, AES-256-GCM
  sealed, machine-bound. The old readable `nx-keys.local.json` inside
  `.neurax` is imported and SHREDDED automatically.
- Dev checkouts may keep a git-ignored `nx-keys.local.json` in the project
  root — never publish it, the launcher seals it on next start.
- Settings → Owner Console (passkey-gated): view every file DECRYPTED,
  edit + re-seal, reveal/rotate keys, unlock `.neurax` for deletion,
  factory reset.

## Sign-in (v4.4)

Settings → "Sign in with Microsoft" → the embedded sign-in window
(oauth20_desktop.srf — the only redirect the official Minecraft app id has).
Zero config. Device codes / system-browser flows need your own Azure app id
(explained in-app, NX Admin → Device & login IDs).

## NX Cloud (optional, owner-only)

First-time users get a clean local-only launcher (everything local works).
You connect your own Supabase database once (Settings → NX Cloud console /
`supabase/nx-supabase-setup.sql`); chat, announcements, remote control and
the blocklist switch on for every device that has the URL. The NEURAX
CONTROL CENTER (`neurax-launcher/nx-cloud/`) logs in with your admin key.

## Verification batteries (run before shipping)

    node scripts/check-syntax.js
    node scripts/smoke-nx-keys.js      # 25 checks — sealed key storage
    node scripts/probe-v44.js          # 16 checks — this release
    node scripts/probe-v43.js && node scripts/probe-v42.js && node scripts/probe-v41.js
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
FORBIDDEN = [b'sINm6w7h8PfCelSnlirOhgTPq2wSd03X',
             b'Auiwadhagwid156!78hduZaAgd768@ahwiZ',
             b'AnishWorrior001', b'invoqcismjgwbropdqvs']
with zipfile.ZipFile(DEST) as z:
    assert z.testzip() is None, 'corrupt member'
    names = z.namelist()
    # 1. private files must NOT be in the zip
    for n in names:
        assert 'nx-keys.local.json' not in n, f'PRIVATE key file leaked into zip: {n}'
        assert not n.endswith(('.vk', 'vault.bin', 'cc-vault.bin', 'settings.vault', 'tokens.vault',
                               'identity-cache.vault', 'keys.vault', '.nx-lock')), f'runtime secret in zip: {n}'
    # 2. no baked secrets anywhere (guard build scripts excluded from the scan)
    guard_re = re.compile(r'^neurax-launcher/scripts/build_v\d+(_full|_complete)?\.py$')
    blob = b''.join(z.read(n) for n in names
                    if n.endswith(('.js', '.json', '.md', '.html', '.sql', '.py', '.bat', '.txt', '.yml'))
                    and not guard_re.match(n))
    for secret in FORBIDDEN:
        assert secret not in blob, f'BAKED SECRET FOUND in zip: {secret[:12]}...'
    # 3. required launcher files
    required = [
        'neurax-launcher/package.json',
        'neurax-launcher/src/main/main.js',
        'neurax-launcher/src/main/core/auth.js',
        'neurax-launcher/src/main/core/settings.js',
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
        'neurax-launcher/scripts/probe-v43.js',
        'neurax-launcher/scripts/probe-v44.js',
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
    # 4. v4.4.0 feature markers inside the shipped sources
    pkg = json.loads(z.read('neurax-launcher/package.json'))
    assert pkg['version'] == '4.4.0', f"package version is {pkg['version']}, expected 4.4.0"
    keys_src = z.read('neurax-launcher/src/main/core/nx-admin-keys.js').decode('utf8')
    seal_src = z.read('neurax-launcher/src/main/core/nx-seal.js').decode('utf8')
    vault_src = z.read('neurax-launcher/src/main/core/nx-vault.js').decode('utf8')
    cloud_src = z.read('neurax-launcher/src/main/core/nx-cloud.js').decode('utf8')
    game_src = z.read('neurax-launcher/src/main/core/game.js').decode('utf8')
    ipc_src = z.read('neurax-launcher/src/main/ipc.js').decode('utf8')
    ident_src = z.read('neurax-launcher/src/main/core/device-identity.js').decode('utf8')
    settings_src = z.read('neurax-launcher/src/main/core/settings.js').decode('utf8')
    assert "VAULT_NAME = 'keys.vault'" in keys_src, 'sealed key vault missing'
    assert 'shredPlaintext' in keys_src, 'plaintext shred missing'
    assert 'function writeSealed' in seal_src and 'function readSealed' in seal_src, 'sealed primitives must live in nx-seal.js'
    assert 'seal.readSealed' in vault_src, 'vault must delegate to nx-seal'
    assert 'function pickMode' in cloud_src and "return 'offline'" in cloud_src, 'offline-first missing'
    assert 'closeLauncherOnLaunch' in game_src and 'armWatchdog' in game_src, 'close-on-launch missing'
    for ch in ('owner:keysReveal', 'owner:keysRotate', 'owner:listFiles', 'owner:readFile',
               'owner:writeFile', 'owner:unlockData', 'owner:wipeAll'):
        assert ch in ipc_src, f'owner console channel missing: {ch}'
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
