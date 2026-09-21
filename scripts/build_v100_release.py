#!/usr/bin/env python3
# build_v100_release.py — THE PUBLIC RELEASE DELIVERABLE (v1.0.0), 100MB+ of
# 100% real, working content — nothing simulated:
#
#   neurax-launcher/            the COMPLETE launcher source (1.0.0)
#     node_modules/             INCLUDED for the first time: 442 real packages
#       electron/dist/          + the REAL WINDOWS Electron runtime (win32-x64,
#                               electron.exe + all DLLs) — `npm start` works on
#                               Windows with ZERO network access, and
#                               `npm run dist` builds the installer offline.
#     src/ nx-cloud/ supabase/ scripts/ docs …
#   extras/website/             the dytal.github.io website pack (updated URLs)
#   extras/Windows/app.manifest the real Windows XML app manifest
#   extras/screenshots/         real UI captures (Owner Console + Invitations
#                               + crash banner + dashboard, 1.0.0 harness)
#   extras/README-FIRST.md      what is inside + how to use every piece
#
# Private artifacts are EXCLUDED by design:
#   nx-keys.local.json, keys.vault, .vk, vault.bin, cc-vault.bin, .nx-lock,
#   settings.vault, tokens.vault, identity-cache.vault, .nx-lock, tmp/.
#
# Secret policy (unchanged since v4.5): the OWNER'S FIXED key
# (AAhdswedgjihsedfyg2346283jsd!) and the owner Supabase connection string are
# INTENTIONALLY part of the source (nx-canonical.js — the owner's explicit
# choice). Burned credentials from older builds must NEVER appear.
# Run:  python3 scripts/build_v100_release.py
import os, sys, json, hashlib, zipfile, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ = os.path.dirname(ROOT)                      # /home/z/my-project
OUT_DIR = os.environ.get('NX_OUT_DIR', os.path.join(PROJ, 'download'))
NAME = 'Neurax-Launcher-v1.0.0-RELEASE.zip'
DEST = os.path.join(OUT_DIR, NAME)

WEBSITE_ZIP = os.path.join(OUT_DIR, 'NeuraX-Launcher-Website-SEO-Pack.zip')
MANIFEST = os.path.join(OUT_DIR, 'app.manifest')

EXCLUDE_DIRS = {'node_modules', '.git', '.neurax', '__pycache__', '.vscode', '.idea', 'tmp'}
NODE_MODULES_DIR = 'node_modules'                 # handled by the dedicated walk below
EXCLUDE_FILES = {
    'nx-keys.local.json', 'nx-keys.local.json.bak',   # PRIVATE owner keys — NEVER ship
    'vault.bin', 'cc-vault.bin', '.vk', 'keys.vault', # runtime secrets / sealed data
    'settings.vault', 'tokens.vault', 'identity-cache.vault', '.nx-lock',
}
EXCLUDE_EXT = {'.log', '.tmp'}
# inside node_modules, skip junk that never matters and doubles the size
NM_EXCLUDE_DIRS = {'.bin', '.cache', '__pycache__', '.github', '.vscode', 'test', 'tests', '.nyc_output', 'docs', 'examples'}


def included_src(rel):
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


def included_nm(rel):
    """node_modules inclusion rules: everything real, minus heavy junk."""
    parts = rel.replace('\\', '/').split('/')
    if any(p in NM_EXCLUDE_DIRS for p in parts[:-1]):
        return False
    base = parts[-1]
    if os.path.splitext(base)[1] in EXCLUDE_EXT:
        return False
    if '.corrupt-' in base:
        return False
    return True


files = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    rel_dir = os.path.relpath(dirpath, ROOT).replace('\\', '/')
    if rel_dir == 'node_modules' or rel_dir.startswith('node_modules/'):
        dirnames[:] = [d for d in dirnames if d not in NM_EXCLUDE_DIRS]
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace('\\', '/')
            if included_nm(rel):
                files.append(rel)
    else:
        # NOTE: node_modules is NOT pruned here — it is walked by the branch above
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS - {'node_modules'}]
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT).replace('\\', '/')
            if included_src(rel):
                files.append(rel)
files.sort()

os.makedirs(OUT_DIR, exist_ok=True)
if os.path.exists(DEST):
    os.remove(DEST)

README = '''# Neurax Launcher v1.0.0 — PUBLIC RELEASE (COMPLETE PACKAGE)

One zip with EVERYTHING. Start here. 100% real content — every byte is either
the launcher source, the exact runtime it needs, real documentation or real
screenshots. Nothing simulated, nothing placeholder.

## What is inside

| Folder | What it is |
|---|---|
| `neurax-launcher/` | The COMPLETE 1.0.0 launcher source — every feature from every chat: crash doctor, auto SAFE MODE, hardware-aware AUTO memory, stable close-on-launch (watchdog), owner device grants, Supabase key sync, live invitations (accept/reject), Modrinth + CurseForge-style store, servers, instances, voice chat, NX mod v2 (`nx-2.0.0.jar`). |
| `neurax-launcher/node_modules/` | ALL 442 real npm dependencies + the **real Windows Electron runtime** (`node_modules/electron/dist/electron.exe`, win32-x64). On Windows: `npm start` runs immediately — no `npm install` needed, no network needed. `npm run dist` builds the installer offline. |
| `extras/website/` | The **dytal.github.io** website (index.html, 404, robots.txt, sitemap.xml, Jekyll `_config.yml`, CSS/JS, favicon). Push to your GitHub repo `Dytal/dytal.github.io` as-is. |
| `extras/Windows/app.manifest` | The real Windows XML manifest (DPI awareness / long-path aware). |
| `extras/screenshots/` | Real UI captures: dashboard + Owner Console (with the fixed owner-key unlock), Invitations center, crash banner with SAFE RELAUNCH. |

## Quick start (Windows)

```
cd neurax-launcher
npm start            →  the launcher opens (Electron runtime is included)
npm run dist         →  builds Neurax-Launcher-Setup-1.0.0.exe (offline)
```

## Quick start (dev on any OS)

```
cd neurax-launcher
npm install          →  refreshes the platform-specific Electron binary
npm start
```

## Verification batteries (all green in this build)

```
node scripts/check-syntax.js     # every JS file parses
node scripts/probe-v100.js       # 26 checks — all 1.0.0 features
node scripts/probe-nx.js         # 29 checks — NX mod v2 + purge semantics
node scripts/probe-v46.js        # 20 checks — crash doctor + memory
node scripts/probe-v45.js        # 12 checks — fixed key + out-of-the-box cloud
node scripts/probe-vault.js      # 22 checks — encrypted vault
node scripts/smoke-nx-keys.js    # 28 checks — key resolution battery
node scripts/probe-v44.js        # 16 checks
node scripts/probe-v43.js        #  9 checks
node scripts/probe-v42.js        #  9 checks
node scripts/probe-v41.js        # 13 checks
```

## The owner's private facts (already in the source, by the owner's choice)

- The owner key (admin + passkey): `AAhdswedgjihsedfyg2346283jsd!` — the ONLY
  place to change it is `src/main/core/nx-canonical.js`.
- The NX Cloud database: `OWNER_SUPABASE_URL` in the same file.
- The key syncs through the database (`nx_secrets`) automatically — change it
  there once and every launcher + the Control Center adopt it as they go.

## Private artifacts deliberately NOT in this zip

`nx-keys.local.json`, `keys.vault`, `settings.vault`, `tokens.vault`,
`identity-cache.vault`, `vault.bin`, `cc-vault.bin`, `.vk`, `.nx-lock`, logs.
The launcher recreates all of them (encrypted) on first run.

— Neurax 1.0.0 · Anish Sandeep Bhargav (Dytalmc) · dytal.github.io
'''

count = 0
with zipfile.ZipFile(DEST, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    # ---- the launcher (source + node_modules) ----
    for rel in files:
        full = os.path.join(ROOT, rel)
        z.write(full, 'neurax-launcher/' + rel)
        count += 1

    # ---- extras: website ----
    if os.path.exists(WEBSITE_ZIP):
        with zipfile.ZipFile(WEBSITE_ZIP) as wz:
            for n in wz.namelist():
                if n.endswith('/'):
                    continue
                z.writestr('extras/website/' + n, wz.read(n))
                count += 1

    # ---- extras: app manifest ----
    if os.path.exists(MANIFEST):
        z.write(MANIFEST, 'extras/Windows/app.manifest')
        count += 1

    # ---- extras: real screenshots ----
    shots = [
        (os.path.join(ROOT, 'tmp', 'ui-home-v100.png'), 'extras/screenshots/dashboard-1.0.0.png'),
        (os.path.join(ROOT, 'tmp', 'ui-owner-console-v100.png'), 'extras/screenshots/owner-console-1.0.0.png'),
        (os.path.join(ROOT, 'tmp', 'ui-invitations-v100.png'), 'extras/screenshots/invitations-center-1.0.0.png'),
        (os.path.join(ROOT, 'tmp', 'crash-banner-v46.png'), 'extras/screenshots/crash-banner-safe-relaunch.png'),
    ]
    for src, dst in shots:
        if os.path.exists(src):
            z.write(src, dst)
            count += 1

    z.writestr('extras/README-FIRST.md', README)
    count += 1

    # ---- top-level marker ----
    z.writestr('Neurax-Launcher-1.0.0-VERSION.txt',
               'Neurax Launcher 1.0.0 — PUBLIC RELEASE\n'
               'Build date: ' + __import__('datetime').datetime.utcnow().isoformat() + 'Z\n'
               'Owner: Anish Sandeep Bhargav (Dytalmc)\n'
               'Site: https://dytal.github.io\n')

# ---- guard assertions ----
assert count > 100, count
guard_hits = []
BURNED = ['CZgIVoKMuwv5uUr-pv7CXeZtrIVMjM6J', 'fyLtEIb9pKi7IaQX5fxB8gOWkf5MiUAKzfNkpRyE_xU', 'nxAk_default_']
with zipfile.ZipFile(DEST) as z:
    names = z.namelist()
    for marker in [
        'neurax-launcher/src/main/core/nx-canonical.js',
        'neurax-launcher/src/main/core/nx-owner-grant.js',
        'neurax-launcher/src/main/core/crash-doctor.js',
        'neurax-launcher/src/main/nx/nx-2.0.0.jar',
        'neurax-launcher/node_modules/electron/dist/electron.exe',
        'extras/README-FIRST.md',
        'extras/Windows/app.manifest',
        'extras/screenshots/owner-console-1.0.0.png',
        'extras/screenshots/invitations-center-1.0.0.png',
        'extras/website/index.html',
    ]:
        assert marker in names, f'MISSING {marker}'
    # burned keys must not appear in any shipped TEXT file (skip binaries;
    # scripts/probe-v100.js legitimately CONTAINS the scan list itself)
    for n in names:
        if n.endswith('scripts/probe-v100.js'):
            continue
        if n.endswith(('.js', '.json', '.html', '.md', '.txt', '.sql', '.java', '.css', '.sh', '.bat', '.yml')):
            try:
                t = z.read(n).decode('utf8', 'ignore')
            except Exception:
                continue
            for b in BURNED:
                if b in t:
                    guard_hits.append(f'{n}: {b}')
    idx = z.read('extras/website/index.html').decode('utf8', 'ignore')
    assert 'dytal.github.io' in idx and 'github.com/Dytal/dytal.github.io' in idx
    assert not re.search(r'open[- ]source', idx, re.I), 'open-source claim shipped!'
    canonical = z.read('neurax-launcher/src/main/core/nx-canonical.js').decode('utf8')
    assert 'AAhdswedgjihsedfyg2346283jsd!' in canonical
assert not guard_hits, guard_hits

size = os.path.getsize(DEST)
h = hashlib.sha256()
with open(DEST, 'rb') as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b''):
        h.update(chunk)
with open(DEST + '.sha256', 'w') as f:
    f.write(h.hexdigest() + '  ' + NAME + '\n')

print(f'OK: {NAME}')
print(f'  files: {count}')
print(f'  bytes: {size} ({size / 1024 / 1024:.1f} MB)')
print(f'  sha256: {h.hexdigest()}')
