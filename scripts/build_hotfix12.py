#!/usr/bin/env python3
# build_hotfix12.py — package v2.2.4 "boot unblocked / no more random 15s failsafe"
# as a diff zip: ONLY the edited + new files. Extract over project root (the
# folder that contains package.json). NOTE: the diff zip assumes Hotfix 11
# (v2.2.3) is already applied — the FULL zip contains everything.
import os, zipfile, hashlib

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-Hotfix-12-Boot-Unblocked.zip'
OUT_FULL = '/home/z/my-project/download/Neurax-Launcher-v2.2.4-FULL.zip'

FILES = [
    'package.json',
    'PATCH-NOTES.md',
    'src/main/core/auth.js',
    'src/main/main.js',
    'src/main/core/game.js',
    'src/renderer/js/state.js',
    'src/renderer/js/main.js',
    'src/renderer/js/failsafe.js',
    'src/renderer/js/pages/settings.js',
    'src/renderer/js/mock-bridge.js',
    'scripts/probe-hotfix12.js',
    'scripts/probe-hotfix12-ui.js',
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
        'package.json': ['"version": "2.2.4"'],
        'PATCH-NOTES.md': ['v2.2.4', '15 seconds', 'background'],
        'src/main/core/auth.js': [
            'function restoreSessionShared',          # single shared chain
            'provisional: true',                      # instant display account
            'function currentAccountForLaunch',       # real-token launch path
            'restoreSessionShared',                   # exported
            'function getSkinData',                   # hotfix-11 feature still present (superset file)
        ],
        'src/main/main.js': [
            'auth.restoreSessionShared()',            # engine boot shares the chain
            "send('auth:restored', acc)",
        ],
        'src/main/core/game.js': [
            'auth.currentAccountForLaunch()',         # launches never provisional
        ],
        'src/renderer/js/state.js': [
            'export async function refreshAll',       # network refresh split out
            'network (settings come from disk',       # local-only boot comment
            'export async function boot',
            'syncServerEvent',                        # hotfix-9 feature intact
        ],
        'src/renderer/js/main.js': [
            'refreshAll()',                           # background engine data
            '__neuraxBootStage',
            'on(EVENTS.ACCOUNT, welcomeBack)',
            'emit(EVENTS.ACCOUNT, acc)',              # late account reaches pages
        ],
        'src/renderer/js/failsafe.js': [
            "stuck at",                               # honest stage message
            "old.remove()",                           # auto-dismiss on late boot
            '__neuraxBootStage',
        ],
        'src/renderer/js/pages/settings.js': [
            'no refreshAccount() here',               # router-hang fix marker
            'on(EVENTS.ACCOUNT',                      # live chip subscription
            'function cropSkinHead',                  # hotfix-11 head avatar intact
            'function headAvatar',
        ],
        'src/renderer/js/mock-bridge.js': [
            'setSlowChannel',                         # probe hook
            "case 'auth:skinData'",                   # hotfix-11 demo handler intact
            'makeDemoSkin',
        ],
        'scripts/probe-hotfix12.js': ['currentAccountForLaunch', 'restoreSessionShared', 'provisional'],
        'scripts/probe-hotfix12-ui.js': ['20000', 'LateUser', '__neuraxBootStage'],
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
