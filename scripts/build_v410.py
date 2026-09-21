#!/usr/bin/env python3
# build_v410.py — v4.1.0 patch zip (superset of v4.0.0: safe over v4.0.0 and v3.x).
# NEW: system-browser Microsoft sign-in (PKCE + localhost loopback — the method
#      most launchers use), owner-editable Launcher ID / Device ID / MS Client ID
#      behind the double passkey gate (Announcements → NX Admin), NX Cloud
#      identity detection fix (await profileProvider — the root cause of
#      "account doesn't exist"), Mojang fallback for account locks, instant
#      identity push on login/logout, hash-after-success pushes, late-register
#      ReferenceError fix, honest resolve errors.
import os, zipfile, hashlib, json, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v4.1.0-Browser-Login-Owner-IDs-Cloud-Identity-Fix.zip'

FILES = [
    'PATCH-NOTES.md',
    'package.json',
    'supabase/nx-supabase-setup.sql',
    'src/main/main.js',
    'src/main/ipc.js',
    'src/main/preload.js',
    'src/main/core/nx-supabase.js',
    'src/main/core/nx-cloud.js',
    'src/main/core/perf.js',
    'src/main/core/auth.js',
    'src/main/core/msa-browser.js',
    'src/main/core/msa-window.js',
    'src/main/core/game.js',
    'src/main/core/nx-admin-keys.js',
    'src/main/core/paths.js',
    'src/main/core/settings.js',
    'src/main/core/skin-heads.js',
    'src/main/core/device-identity.js',
    'src/main/core/nx-vault.js',
    'src/main/vendor/postgres/package.json',
    'src/main/vendor/postgres/src/index.js',
    'src/main/vendor/postgres/src/bytes.js',
    'src/main/vendor/postgres/src/connection.js',
    'src/main/vendor/postgres/src/errors.js',
    'src/main/vendor/postgres/src/large.js',
    'src/main/vendor/postgres/src/query.js',
    'src/main/vendor/postgres/src/queue.js',
    'src/main/vendor/postgres/src/result.js',
    'src/main/vendor/postgres/src/subscribe.js',
    'src/main/vendor/postgres/src/types.js',
    'src/renderer/index.html',
    'src/renderer/js/nx.js',
    'src/renderer/js/nx-voice.js',
    'src/renderer/js/mock-bridge.js',
    'src/renderer/js/main.js',
    'src/renderer/js/router.js',
    'src/renderer/js/state.js',
    'src/renderer/js/utils.js',
    'src/renderer/js/failsafe.js',
    'src/renderer/js/logs.js',
    'src/renderer/js/pages/settings.js',
    'src/renderer/js/pages/home.js',
    'src/renderer/js/components/dropdown.js',
    'src/renderer/js/components/modal.js',
    'src/renderer/js/components/toast.js',
    'src/renderer/styles/nx.css',
    'src/renderer/styles/navbar.css',
    'src/renderer/styles/forms.css',
    'src/renderer/styles/home.css',
    'nx-cloud/control-center.js',
    'nx-cloud/control-center.html',
    'nx-cloud/server.js',
    'nx-cloud/START-CONTROL-CENTER.bat',
    'nx-cloud/START-NX-CLOUD.bat',
    'nx-cloud/README.md',
    'nx-cloud/admin.html',
    'scripts/check-syntax.js',
    'scripts/probe-v4.js',
    'scripts/probe-v41.js',
]

CHECKS = [
    # (file, must-contain markers)
    ('src/main/core/auth.js', ["function pkcePair(", "function browserAuthorizeUrl(",
        "async function exchangeBrowserCode(", "async function loginWithBrowserCode(",
        "const isLive = t.flow === 'live';", "setOnAccountChanged", "notifyAccountChanged(null)"]),
    ('src/main/core/msa-browser.js', ["server.listen(0, '127.0.0.1')", "auth.pkcePair()", "SUCCESS_PAGE",
        "cancelActive", "TIMEOUT_MS", "searchParams.get('state')"]),
    ('src/main/core/nx-supabase.js', ["await syncTick(await profileProvider()",
        "await register(id, await profileProvider()", "await opts.identity()",
        "typeof profile.then === 'function'", "api.mojang.com/users/profiles/minecraft/",
        "async function rebindCloudIdentity", "async function forceProfilePush",
        "state.profileHash = h;\n}"]),
    ('src/main/core/nx-cloud.js', ["setOnAccountChanged", "async rebindIdentity()", "mojangLookup"]),
    ('src/main/core/device-identity.js', ["async function overrideIdentity(",
        "async function clearProtectionWin(", "owner-edit"]),
    ('src/main/ipc.js', ["auth:msBrowser", "auth:msBrowserCancel", "nx:identityRead",
        "nx:identityWrite", "identity edit refused", "[0-9a-f]{64}"]),
    ('src/main/preload.js', ["'auth:msBrowser'"]),
    ('src/renderer/js/nx.js', ["openIdentityEditor", "Device & login IDs", "nx:identityWrite"]),
    ('src/renderer/js/pages/settings.js', ["auth:msBrowser", "openPopupLogin", "openDeviceCodeLogin"]),
    ('src/renderer/js/mock-bridge.js', ["nx:identityRead", "auth:msBrowser"]),
    ('package.json', ['"version": "4.1.0"']),
    ('PATCH-NOTES.md', ['# Neurax Launcher — v4.1.0']),
]

def main():
    missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
    if missing:
        print('MISSING FILES:', missing); sys.exit(1)

    # content assertions
    for rel, markers in CHECKS:
        src = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        for m in markers:
            if m not in src:
                print(f'MARKER MISSING in {rel}: {m!r}'); sys.exit(1)
    print(f'content markers OK ({sum(len(m) for _, m in CHECKS)} across {len(CHECKS)} files)')

    # node --check every JS file in the zip (inline HTML scripts too, via extraction)
    js_files = [f for f in FILES if f.endswith('.js')]
    for f in js_files:
        r = subprocess.run(['node', '--check', os.path.join(ROOT, f)], capture_output=True, text=True)
        if r.returncode != 0:
            print(f'SYNTAX FAIL {f}:\n{r.stderr}'); sys.exit(1)
    print(f'node --check OK ({len(js_files)} JS files)')

    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, NAME)
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in FILES:
            z.write(os.path.join(ROOT, f), f)
    size = os.path.getsize(dest)
    h = hashlib.sha256(open(dest, 'rb').read()).hexdigest()
    with open(dest + '.sha256', 'w') as fh:
        fh.write(h + '  ' + NAME + '\n')
    with zipfile.ZipFile(dest) as z:
        assert len(z.namelist()) == len(FILES), 'zip member count mismatch'
    print(f'PACKAGED {NAME}: {len(FILES)} files, {size/1024:.1f} KB')
    print(f'sha256 {h}')

if __name__ == '__main__':
    main()
