#!/usr/bin/env python3
# build_v312.py — v3.1.2 patch zip (superset of v3.1.0/v3.1.1: safe over v3.0.0+).
# NEW: Supabase-backed NEURAX CONTROL CENTER (+ START bat, README, probe).
# Launcher Settings: cloud config removed, admin passphrase + status kept.
import os, zipfile, hashlib, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v3.1.2-Control-Center-Patch.zip'

FILES = [
    'PATCH-NOTES.md',
    'package.json',
    'supabase/nx-supabase-setup.sql',
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
    'nx-cloud/README.md',
    'scripts/probe-nx-supabase.js',
    'scripts/probe-nx-supabase-ui.js',
    'scripts/probe-control-center.js',
]

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path} missing marker: {n}'

must_contain('nx-cloud/control-center.js', [
    'statePayload', '/api/lock', '/api/unlock', '/api/ann/create', '/api/ann/delete',
    'nxAdminPass', 'settings.json', 'POOL_PREFIXES', 'aws-1', 'nxcc=',
])
must_contain('nx-cloud/control-center.html', ['NEURAX', 'CONTROL CENTER', 'ADMIN KEY', 'doLock', 'PUBLISH'])
must_contain('nx-cloud/START-CONTROL-CENTER.bat', ['control-center.js'])
must_contain('nx-cloud/README.md', ['START-CONTROL-CENTER.bat', 'no longer the Control Center'])
must_contain('src/renderer/js/pages/settings.js', [
    'Administrator passphrase', 'runs automatically in the background',
])
# removed settings must NOT be referenced anymore
with open(os.path.join(ROOT, 'src/renderer/js/pages/settings.js'), 'r', encoding='utf-8') as fh:
    st = fh.read()
for gone in ['nxSupaInput', 'nxUrlInput', 'nxUuidText', 'Supabase connection string', 'Legacy server URL']:
    assert gone not in st, f'settings.js still references removed setting: {gone}'
must_contain('src/main/core/nx-supabase.js', ['restart the launcher', 'POOL_PREFIXES', 'needsSchema'])
must_contain('scripts/probe-control-center.js', ['/api/lock', 'nxcc=', 'locked_until'])
must_contain('supabase/nx-supabase-setup.sql', ['nx_identities', 'nx_file_chunks'])
must_contain('PATCH-NOTES.md', ['CONTROL CENTER', 'v3.1.2'])
must_contain('package.json', '"version": "3.1.2"')

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
    cc = z.read('neurax-launcher/nx-cloud/control-center.js').decode('utf8')
    assert '/api/state' in cc and 'nxAdminPass' in cc

print(json.dumps({
    'zip': dest, 'files': len(FILES), 'bytes': size, 'sha256': sha[:16] + '…',
}, indent=2))
print('PATCH ZIP OK')
