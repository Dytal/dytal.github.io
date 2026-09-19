#!/usr/bin/env python3
# build_v300.py — package Neurax Launcher v3.0.0 "NX" as a FULL zip:
# launcher + nx-cloud control server + NX-UI 64x pack + probes.
# The FULL zip is a complete, from-scratch project — no previous version needed.
import os, zipfile

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-v3.0.0-NX-FULL.zip'

FULL_EXCLUDE_DIRS = {'node_modules', '.git', 'dist', 'out', 'release', '__pycache__', '.neurax-test', 'data'}
FULL_EXCLUDE_EXT = {'.pyc', '.log'}
FULL_EXCLUDE_FILES = {'package-lock.json'}
# nx-cloud ships its ONLY dependency (ws, pure JS) vendored, so the control
# server runs with ZERO npm install. Everything else node_modules stays out.
def excluded(rel):
    parts = rel.replace('\\', '/').split('/')
    if rel.startswith('nx-cloud/node_modules'):
        # keep only the ws package (and its license) — pure JS, no native bits
        allowed = rel.startswith('nx-cloud/node_modules/ws/')
        return not allowed
    if any(p in FULL_EXCLUDE_DIRS for p in parts):
        return True
    if os.path.splitext(rel)[1] in FULL_EXCLUDE_EXT:
        return True
    return os.path.basename(rel) in FULL_EXCLUDE_FILES

def collect():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        # prune everything except the vendored nx-cloud/node_modules/ws tree
        keep = set()
        for d in dirnames:
            if d not in FULL_EXCLUDE_DIRS:
                keep.add(d)
            elif d == 'node_modules' and os.path.basename(dirpath) == 'nx-cloud':
                keep.add(d)
        dirnames[:] = sorted(keep)
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if rel.startswith('.') or excluded(rel):
                continue
            out.append(rel)
    return sorted(out)

def build(zip_path, files):
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            z.write(os.path.join(ROOT, rel), os.path.join('neurax-launcher', rel))
    return os.path.getsize(zip_path)

files = collect()
must = [
    'package.json', 'PATCH-NOTES.md', 'README.md',
    'src/main/main.js', 'src/main/core/nx-cloud.js', 'src/main/core/device-identity.js',
    'src/main/core/nx-inject.js', 'src/renderer/js/nx.js', 'src/renderer/styles/nx.css',
    'src/assets/nx/NX-UI-64x.zip',
    'nx-cloud/server.js', 'nx-cloud/admin.html', 'nx-cloud/README.md',
    'nx-cloud/package.json', 'nx-cloud/START-NX-CLOUD.bat', 'nx-cloud/node_modules/ws/package.json',
    'scripts/probe-nx-cloud.js', 'scripts/probe-nx-integration.js', 'scripts/probe-nx-ui.js',
]
missing = [m for m in must if m not in files]
assert not missing, f'missing from zip: {missing}'
size = build(OUT, files)
print(f'v3.0.0 FULL: {len(files)} files, {size/1024/1024:.2f} MB -> {OUT}')
