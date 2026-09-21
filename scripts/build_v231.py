#!/usr/bin/env python3
# build_v231.py — package v2.3.1 "client everywhere: instance injection (26.1.2)"
# as a diff zip: ONLY the edited + new files. Extract over project root (the
# folder that contains package.json). The diff zip assumes v2.3.0 is already
# applied — the FULL zip contains everything.
import os, zipfile, hashlib

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-v2.3.1-Instance-Injection.zip'
OUT_FULL = '/home/z/my-project/download/Neurax-Launcher-v2.3.1-FULL.zip'

FILES = [
    'package.json',
    'PATCH-NOTES.md',
    'src/main/core/client.js',
    'src/main/core/store.js',
    'src/main/core/game.js',
    'src/main/ipc.js',
    'src/main/main.js',
    'src/main/preload.js',
    'src/renderer/js/main.js',
    'src/renderer/js/mock-bridge.js',
    'src/renderer/js/pages/settings.js',
    'src/renderer/styles/navbar.css',
    'scripts/probe-inject.js',
    'scripts/probe-inject-ui.js',
    'scripts/probe-inject-real.js',
    'scripts/build_v231.py',
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
        'package.json': ['"version": "2.3.1"'],
        'PATCH-NOTES.md': ['v2.3.1', '26.1.2', 'instances'],
        'src/main/core/client.js': [
            "const INSTANCE_SCOPE = ['26.1.2']",      # rollout scope
            'const INJECTOR_VERSION = 1',
            'async function injectInstanceInner',      # core injector
            'function hasManagedMods',                 # launch-pipeline hook
            'async function uninjectInstance',         # full restore
            'async function migrateInstances',         # startup rollout
            'function syncInstance',                   # launch catch-up
            'modsExpected',                            # forge freshness fix
            'instanceManaged',                         # prepareLaunch no-double-inject
            'function resolveStack',                   # v2.3.0 engine intact
            'fabricAddModsArg',
        ],
        'src/main/core/store.js': [
            "'neuraxClient'",                          # updateInstance allowlist
            "source: 'creation'",                      # create hook
            "source: 'update'",                        # version-edit hook
            'function deleteInstance',                 # structure intact
        ],
        'src/main/core/game.js': [
            'client.hasManagedMods(instance)',         # instance-managed launch
            'client.syncInstance(instance)',           # background catch-up
            'instanceManaged,',
            'using installed profile',                 # fabric offline fallback
            'currentAccountForLaunch',                 # hotfix-12 launch path intact
        ],
        'src/main/ipc.js': [
            "handle('client:injectInstance'",
            "handle('client:uninjectInstance'",
            "handle('client:previewStack'",            # v2.3.0 channels intact
        ],
        'src/main/main.js': [
            "require('./core/client').setBroadcaster",
            "require('./core/client').migrateInstances()",
            'width = 1200',                            # v2.3.0 window default intact
            'restoreSessionShared',                    # hotfix-12 boot intact
        ],
        'src/main/preload.js': [
            "'client:inject-progress'",
            "'client:injected'",
        ],
        'src/renderer/js/main.js': [
            "const CLIENT_SCOPE = ['26.1.2']",
            'nx-client-chip',                          # dropdown badge
            'nx-client-edit',                          # edit-modal section
            'client:injectInstance',
            'client:uninjectInstance',
            "api.on('client:injected'",                # toast/refresh listener
            'openEditInstance',                        # pre-existing flow intact
        ],
        'src/renderer/js/mock-bridge.js': [
            "case 'client:injectInstance'",
            "case 'client:uninjectInstance'",
            'instanceScope',
            'Neurax 26.1.2',                           # injected demo instance
            'setSlowChannel',                          # probe hooks intact
            "case 'auth:skinData'",                    # hotfix-11 demo intact
        ],
        'src/renderer/js/pages/settings.js': [
            'Instance injection',                      # new copy
            'function cropSkinHead',                   # hotfix-11 intact
            'clientFpsMode',                           # v2.3.0 card intact
        ],
        'src/renderer/styles/navbar.css': [
            '.nx-client-chip',
            '.nx-client-edit',
        ],
        'scripts/probe-inject.js': ['INSTANCE injection probe', 'modsExpected' if False else 'single-flight'],
        'scripts/probe-inject-ui.js': ['nx-client-chip', 'Remove clears the chip again'],
        'scripts/probe-inject-real.js': ['live Fabric loader versions', 'creation hook fully injected'],
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
