#!/usr/bin/env python3
# build_v220.py — package v2.2.0 "Modrinth Power Update" as a diff zip:
# ONLY the edited + new files, per the user's request. Extract over project root.
import os, zipfile, hashlib

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-v2.2.0-Modrinth-Update.zip'

FILES = [
    'package.json',
    'PATCH-NOTES.md',
    'src/main/core/modrinth.js',
    'src/main/ipc.js',
    'src/renderer/js/pages/modrinth.js',
    'src/renderer/js/pages/store-common.js',
    'src/renderer/js/pages/newinstance.js',
    'src/renderer/js/pages/servers.js',
    'src/renderer/js/components/toast.js',
    'src/renderer/js/mock-bridge.js',
    'src/renderer/styles/store.css',
    'scripts/probe-features.js',
    'scripts/probe-features-ui.js',
    'scripts/probe-smart.js',
    'scripts/test-core.js',
]

def main():
    missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
    assert not missing, f'missing files: {missing}'

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in FILES:
            src = os.path.join(ROOT, f)
            z.write(src, f)  # keep paths relative to project root

    # verify: integrity + contents + spot checks
    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        assert bad is None, f'corrupt entry: {bad}'
        names = z.namelist()
        assert sorted(names) == sorted(FILES), 'zip contents mismatch'
        pkg = z.read('package.json').decode()
        assert '"version": "2.2.0"' in pkg, 'version not bumped in zip'
        mr = z.read('src/main/core/modrinth.js').decode()
        assert 'pickBestVersion' in mr and 'installMrpack' in mr and 'assertCdnUrl' in mr
        sc = z.read('src/renderer/js/pages/store-common.js').decode()
        assert 'singleModdedInstance' in sc and 'versionFilterBar' in sc
        pn = z.read('PATCH-NOTES.md').decode()
        assert 'v2.2.0' in pn

    size = os.path.getsize(OUT)
    sha = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()[:16]
    print(f'OK {OUT}')
    print(f'   files: {len(FILES)}  size: {size/1024:.1f} KB  sha256[:16]: {sha}')
    for f in FILES:
        print(f'   + {f} ({os.path.getsize(os.path.join(ROOT, f))} B)')

if __name__ == '__main__':
    main()
