#!/usr/bin/env python3
# build_v314.py — v3.1.4 patch zip (superset of v3.1.0–v3.1.3: safe over v3.0.0+).
# NEW: Windows ESM import fix (pathToFileURL), FIXED admin key + UNLOCK_PASSKEY
#      baked into nx-admin-keys.js, Settings passphrase field removed.
import os, zipfile, hashlib, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v3.1.4-Fixed-Admin-Key-Windows-Fix-Patch.zip'

FILES = [
    'PATCH-NOTES.md',
    'package.json',
    'supabase/nx-supabase-setup.sql',
    'src/main/core/nx-admin-keys.js',
    'src/main/core/nx-supabase.js',
    'src/main/core/skin-heads.js',
    'src/main/core/nx-cloud.js',
    'src/main/core/settings.js',
    'src/main/ipc.js',
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
    'src/renderer/js/nx.js',
    'src/renderer/js/pages/settings.js',
    'src/renderer/js/mock-bridge.js',
    'src/renderer/styles/nx.css',
    'nx-cloud/control-center.js',
    'nx-cloud/control-center.html',
    'nx-cloud/START-CONTROL-CENTER.bat',
    'nx-cloud/server.js',
    'nx-cloud/admin.html',
    'nx-cloud/START-NX-CLOUD.bat',
    'nx-cloud/README.md',
    'scripts/probe-nx-supabase.js',
    'scripts/probe-nx-supabase-ui.js',
    'scripts/probe-control-center.js',
    'scripts/probe-nx-cloud.js',
]

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path} missing marker: {n}'

must_contain('src/main/core/nx-admin-keys.js', ['ADMIN_KEY', 'UNLOCK_PASSKEY', 'nx-keys.local.json'])
must_contain('nx-cloud/control-center.js', [
    'statePayload', '/api/lock', '/api/unlock', '/api/ann/create', '/api/ann/delete',
    'nxcc=', 'EADDRINUSE', 'probeHolder', 'autoOpenBrowser', 'CC_VERSION',
    'pathToFileURL', 'NEURAX_ADMIN_KEY', 'nx-admin-keys',
])
must_contain('nx-cloud/control-center.html', [
    'NEURAX', 'CONTROL CENTER', 'ADMIN KEY', 'doLock', 'PUBLISH',
    'neurax-console', 'visibilitychange', 'owner admin key',
])
must_contain('src/main/ipc.js', ['UNLOCK_PASSKEY', 'Wrong owner passkey', 'nx-admin-keys'])
must_contain('src/main/core/settings.js', ['nxKeys.ADMIN_KEY', '127.0.0.1:8790', "k === 'nxAdminPass'"])
must_contain('src/renderer/js/pages/settings.js', [
    'Admin panel', 'runs automatically in the background',
])
must_contain('src/renderer/js/nx.js', ['Owner passkey', 'owner passkey'])
must_contain('nx-cloud/server.js', ['NX_PORT || 8790', 'EADDRINUSE', 'LEGACY'])
must_contain('nx-cloud/admin.html', ['LEGACY', 'NX Cloud Relay'])
must_contain('nx-cloud/START-NX-CLOUD.bat', ['legacy', '8790', 'START-CONTROL-CENTER.bat'])
must_contain('nx-cloud/START-CONTROL-CENTER.bat', ['control-center.js'])
must_contain('nx-cloud/README.md', ['START-CONTROL-CENTER.bat', '8790', 'EADDRINUSE', 'owner admin key'])
# removed settings must NOT be referenced anymore
with open(os.path.join(ROOT, 'src/renderer/js/pages/settings.js'), 'r', encoding='utf-8') as fh:
    st = fh.read()
for gone in ['Administrator passphrase', 'nxSupaInput', 'nxUrlInput', 'nxUuidText', 'Supabase connection string', 'Legacy server URL', 'saveSettings({ nxAdminPass']:
    assert gone not in st, f'settings.js still references removed setting: {gone}'
must_contain('src/main/core/nx-supabase.js', ['restart the launcher', 'POOL_PREFIXES', 'needsSchema'])
must_contain('scripts/probe-control-center.js', ['/api/lock', 'nxcc=', 'locked_until', 'EADDRINUSE fallback', 'pathToFileURL', 'NEURAX_ADMIN_KEY'])
must_contain('supabase/nx-supabase-setup.sql', ['nx_identities', 'nx_file_chunks'])
must_contain('PATCH-NOTES.md', ['CONTROL CENTER', 'v3.1.4', 'pathToFileURL', 'UNLOCK_PASSKEY'])
must_contain('package.json', '"version": "3.1.4"')

os.makedirs(OUT, exist_ok=True)
dest = os.path.join(OUT, NAME)
if os.path.exists(dest):
    os.remove(dest)

with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in FILES:
        z.write(os.path.join(ROOT, rel), 'neurax-launcher/' + rel)

size = os.path.getsize(dest)
sha = hashlib.sha256(open(dest, 'rb').read()).hexdigest()

with zipfile.ZipFile(dest) as z:
    assert z.testzip() is None, 'corrupt member'
    assert len(z.namelist()) == len(FILES), 'member count mismatch'
    keys = z.read('neurax-launcher/src/main/core/nx-admin-keys.js').decode('utf8')
    assert 'ADMIN_KEY' in keys and 'UNLOCK_PASSKEY' in keys
    assert 'sINm' not in keys and 'Auiwadhagwid156' not in keys, 'key literals must never return to the public source'
    cc = z.read('neurax-launcher/nx-cloud/control-center.js').decode('utf8')
    assert 'pathToFileURL' in cc and 'nx-admin-keys' in cc

print(json.dumps({
    'zip': dest, 'files': len(FILES), 'bytes': size, 'sha256': sha[:16] + '…',
}, indent=2))
print('PATCH ZIP OK')
