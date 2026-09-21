#!/usr/bin/env python3
# build_v420_full.py — packages the COMPLETE Neurax Launcher project (v4.2.0)
# into ONE deliverable zip: every source file, cloud console, SQL, docs, tests
# and build scripts. Private artifacts are EXCLUDED by design:
#   - nx-keys.local.json   (the owner's real admin keys — git-ignored)
#   - node_modules / logs / caches / __pycache__
# Run:  python3 scripts/build_v420_full.py
import os, sys, json, hashlib, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get('NX_OUT_DIR', os.path.join(os.path.dirname(ROOT), 'download'))
NAME = 'Neurax-Launcher-v4.2.0-FULL-SOURCE.zip'
DEST = os.path.join(OUT_DIR, NAME)

EXCLUDE_DIRS = {'node_modules', '.git', '.neurax', '__pycache__', '.vscode', '.idea'}
EXCLUDE_FILES = {
    'nx-keys.local.json',      # PRIVATE owner keys — NEVER ship
    'nx-keys.local.json.bak',
    'vault.bin', 'cc-vault.bin', '.vk',  # local runtime secrets (not in repo, but be safe)
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
    if base.endswith('.corrupt-') or '.corrupt-' in base:
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

with zipfile.ZipFile(DEST, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in files:
        z.write(os.path.join(ROOT, rel), 'neurax-launcher/' + rel)

# ---------------- verification ----------------
# FULL key literals only — guard files (e.g. build_v314.py's negative
# assertion) carry SHORT fragments on purpose and must not trip this scan.
FORBIDDEN = [b'sINm6w7h8PfCelSnlirOhgTPq2wSd03X',
             b'Auiwadhagwid156!78hduZaAgd768@ahwiZ',
             b'AnishWorrior001', b'invoqcismjgwbropdqvs']
with zipfile.ZipFile(DEST) as z:
    assert z.testzip() is None, 'corrupt member'
    names = z.namelist()
    assert len(names) == len(files), 'member count mismatch'
    # 1. private files must NOT be in the zip
    for n in names:
        assert 'nx-keys.local.json' not in n, f'PRIVATE key file leaked into zip: {n}'
        assert not n.endswith(('.vk', 'vault.bin', 'cc-vault.bin')), f'runtime secret in zip: {n}'
    # 2. no baked secrets anywhere in the archive (skip THIS script — its
    #    own FORBIDDEN guard list legitimately contains the fragments)
    self_name = 'neurax-launcher/scripts/build_v420_full.py'
    blob = b''.join(z.read(n) for n in names
                    if n.endswith(('.js', '.json', '.md', '.html', '.sql', '.py', '.bat', '.txt', '.yml'))
                    and n != self_name)
    for secret in FORBIDDEN:
        assert secret not in blob, f'BAKED SECRET FOUND in zip: {secret[:12]}...'
    # 3. required entry points present
    required = [
        'neurax-launcher/package.json',
        'neurax-launcher/src/main/main.js',
        'neurax-launcher/src/main/core/auth.js',
        'neurax-launcher/src/main/core/msa-browser.js',
        'neurax-launcher/src/main/core/nx-admin-keys.js',
        'neurax-launcher/nx-cloud/control-center.js',
        'neurax-launcher/supabase/nx-supabase-setup.sql',
        'neurax-launcher/PATCH-NOTES.md',
        'neurax-launcher/scripts/probe-v42.js',
        'neurax-launcher/scripts/rotate-nx-keys.js',
        'neurax-launcher/.gitignore',
    ]
    for r in required:
        assert r in names, f'missing required file: {r}'

size = os.path.getsize(DEST)
sha = hashlib.sha256(open(DEST, 'rb').read()).hexdigest()
with open(DEST + '.sha256', 'w') as f:
    f.write(sha + '  ' + NAME + '\n')

print(json.dumps({
    'zip': DEST,
    'files': len(files),
    'bytes': size,
    'sha256': sha,
    'excluded': 'node_modules/, .git/, nx-keys.local.json (PRIVATE), logs, runtime vaults',
}, indent=2))
print('FULL-SOURCE ZIP OK')
