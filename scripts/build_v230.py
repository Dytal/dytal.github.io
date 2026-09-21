#!/usr/bin/env python3
# build_v230.py — package v2.3.0 "Neurax Client" as a diff zip: ONLY the edited +
# new files (including the 4 bundled UI packs). Extract over project root (the
# folder that contains package.json). Assumes v2.2.4 is already applied — the
# FULL zip contains everything.
import os, zipfile

ROOT = '/home/z/my-project/neurax-launcher'
OUT = '/home/z/my-project/download/Neurax-Launcher-v2.3.0-Neurax-Client.zip'
OUT_FULL = '/home/z/my-project/download/Neurax-Launcher-v2.3.0-FULL.zip'

CORE_FILES = [
    'package.json',
    'PATCH-NOTES.md',
    'src/main/core/client.js',
    'src/main/core/game.js',
    'src/main/core/settings.js',
    'src/main/core/logger.js',
    'src/main/core/paths.js',
    'src/main/ipc.js',
    'src/renderer/js/main.js',
    'src/renderer/js/pages/settings.js',
    'src/renderer/js/mock-bridge.js',
    'src/renderer/styles/base.css',
    'scripts/probe-client.js',
    'scripts/probe-client-ui.js',
    'scripts/probe-client-real.js',
]

def pack_files():
    """All 4 theme packs, every file under src/main/clientpacks/<theme>/."""
    out = []
    base = os.path.join(ROOT, 'src', 'main', 'clientpacks')
    for theme in sorted(os.listdir(base)):
        tdir = os.path.join(base, theme)
        if not os.path.isdir(tdir):
            continue
        for dirpath, _, filenames in os.walk(tdir):
            for fn in filenames:
                out.append(os.path.relpath(os.path.join(dirpath, fn), ROOT))
    return sorted(out)

PACK_FILES = pack_files()
FILES = CORE_FILES + PACK_FILES

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
            if not needles:
                continue  # presence-only check (binary assets)
            data = z.read(rel).decode('utf8')
            for needle in needles:
                assert needle in data, f'{rel} missing spot-check: {needle}'

def main():
    # spot checks: v2.2.4 features must still be present in superseding files,
    # plus every new v2.3.0 feature
    core_spots = {
        'package.json': ['"version": "2.3.0"'],
        'PATCH-NOTES.md': ['Neurax Client', 'fabric.addMods', '26.3', '1.21.11'],
        'src/main/core/client.js': [
            'fabric.addMods', 'ArgumentModCandidateFinder', 'SUPPORTED_VERSIONS',
            "'c2me-fabric'", "'sodium'", "'iris'", 'pickBestVersion',
            'enablePackInOptions', 'perfJvmArgs', 'AlwaysPreTouch',
        ],
        'src/main/core/game.js': [
            'client.prepareLaunch', 'customArgs', 'client-setup',
            'fullscreen: !!set.playFullscreen',           # v2.3.0 fullscreen
            'currentAccountForLaunch',                    # hotfix-12 intact
        ],
        'src/main/core/settings.js': [
            "version: 3", 'playFullscreen: true', 'neuraxClient: true',
            'clientFpsMode', 'clientGuiTheme',            # v2.3.0
        ],
        'src/main/core/logger.js': ["client: ns('client')"],
        'src/main/core/paths.js': ["'client', 'mods'"],
        'src/main/ipc.js': [
            'client:status', 'client:clearCache', 'client:previewStack',
            'auth:skinData',                              # hotfix-11 intact
        ],
        'src/renderer/js/main.js': ["'client-setup'", 'refreshAll'],   # hotfix-12 intact
        'src/renderer/js/pages/settings.js': [
            'Neurax Client', 'clientFpsMode', 'clientGuiTheme', 'neuraxClient',
            'client:previewStack', 'Match launcher',
            'cropSkinHead',                               # hotfix-11 intact
        ],
        'src/renderer/js/mock-bridge.js': [
            'client:status', 'client-setup', 'version: 3',
            '__neuraxDemoAccount',                        # hotfix-11 intact
        ],
        'src/renderer/styles/base.css': ['.seg-btn'],
        'scripts/probe-client.js': ['fabric.addMods', 'perfJvmArgs'],
    }
    pack_spots = {}
    for theme in ['purple', 'emerald', 'cyan', 'orange']:
        pack_spots[f'src/main/clientpacks/{theme}/pack.mcmeta'] = ['pack_format', theme.capitalize()]
        pack_spots[f'src/main/clientpacks/{theme}/assets/minecraft/textures/gui/sprites/widget/button.png'] = []
        pack_spots[f'src/main/clientpacks/{theme}/assets/minecraft/textures/gui/sprites/hud/hotbar.png'] = []
        pack_spots[f'src/main/clientpacks/{theme}/assets/minecraft/textures/gui/container/inventory.png'] = []
    all_spots = {**core_spots, **pack_spots}

    build(OUT, FILES, all_spots)
    print(f'incremental zip: {OUT}')
    print(f'  files: {len(FILES)} ({len(CORE_FILES)} core + {len(PACK_FILES)} pack files)')

    full = collect_full()
    full_spots = dict(all_spots)
    build(OUT_FULL, full, full_spots)
    print(f'FULL zip:        {OUT_FULL}')
    print(f'  files: {len(full)}')

    for p in (OUT, OUT_FULL):
        print(f'  {os.path.basename(p)}: {os.path.getsize(p) / 1024:.1f} KB')

if __name__ == '__main__':
    main()
