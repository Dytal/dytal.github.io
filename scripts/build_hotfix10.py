#!/usr/bin/env python3
# build_hotfix10.py — package v2.2.2 "Fabric/Quilt server install fix"
# as a diff zip: ONLY the edited + new files, per the user's request.
# Extract over project root (the folder that contains package.json).
# NOTE: the diff zip assumes Hotfix 9 (v2.2.1) is already applied — the FULL
# zip contains everything for a from-scratch overlay.
import os, zipfile, hashlib

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-Hotfix-10-Fabric-Server-Fix.zip'
OUT_FULL = '/home/z/my-project/download/Neurax-Launcher-v2.2.2-FULL.zip'

FILES = [
    'package.json',
    'PATCH-NOTES.md',
    'src/main/core/servers.js',
    'src/main/core/java.js',
    'scripts/probe-hotfix10.js',
]

FULL_EXCLUDE_DIRS = {'node_modules', '.git', 'dist', 'out', 'release', '__pycache__', '.neurax-test'}
FULL_EXCLUDE_EXT = {'.pyc', '.log'}

def collect_full():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in FULL_EXCLUDE_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1] in FULL_EXCLUDE_EXT:
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, ROOT)
            if rel.startswith('.'):
                continue
            out.append(rel)
    return sorted(out)

def build(zip_path, files, spot_checks):
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in files:
            z.write(os.path.join(ROOT, f), f)
    with zipfile.ZipFile(zip_path) as z:
        bad = z.testzip()
        assert bad is None, f'corrupt entry: {bad}'
        names = z.namelist()
        assert sorted(names) == sorted(files), 'zip contents mismatch'
        for rel, needles in spot_checks.items():
            data = z.read(rel).decode('utf8')
            for needle in needles:
                assert needle in data, f'{rel} missing spot-check: {needle}'

def main():
    missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
    assert not missing, f'missing files: {missing}'

    spot = {
        'package.json': ['"version": "2.2.2"'],
        'PATCH-NOTES.md': ['v2.2.2', 'fabric-server-launch.jar'],
        'src/main/core/servers.js': [
            'installFabricLike',
            '/versions/loader/${encodeURIComponent(mcVersion)}',  # correct loader-version source
            "install', 'server', mcVersion, loaderVersion",        # quilt installer args
            "'-mcversion', mcVersion, '-loaderversion', loaderVersion, '-downloadMinecraft'",  # fabric installer args
            'fabric-server-launch.jar',
            'quilt-server-launch.jar',
            'getRuntime', 'pushConsoleLine',  # hotfix 9 features still present (superset file)
        ],
        'src/main/core/java.js': [
            '.tar\\.gz$|\\.tgz$',  # tar.gz branch
            "execFile('tar', ['-xzf', destPkg",
            'COMPONENT[major]',    # existing mapping untouched
        ],
        'scripts/probe-hotfix10.js': ['BOOT', 'Done', 'fabric-server-launch.jar'],
    }
    build(OUT, FILES, spot)
    size = os.path.getsize(OUT)
    sha = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()[:16]
    print(f'OK {OUT}')
    print(f'   files: {len(FILES)}  size: {size/1024:.1f} KB  sha256[:16]: {sha}')
    for f in FILES:
        print(f'   + {f} ({os.path.getsize(os.path.join(ROOT, f))} B)')

    full_files = collect_full()
    build(OUT_FULL, full_files, spot)
    size_f = os.path.getsize(OUT_FULL)
    sha_f = hashlib.sha256(open(OUT_FULL, 'rb').read()).hexdigest()[:16]
    print(f'OK {OUT_FULL}')
    print(f'   files: {len(full_files)}  size: {size_f/1024:.1f} KB  sha256[:16]: {sha_f}')

if __name__ == '__main__':
    main()
