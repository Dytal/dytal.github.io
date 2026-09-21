#!/usr/bin/env python3
# build_v310.py — NX Supabase Direct patch zip (diff-only: added + edited files).
# Includes the Supabase SQL schema + vendored postgres.js so NO npm install is needed.
import os, zipfile, hashlib, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v3.1.0-NX-Supabase-Patch.zip'

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
    'scripts/probe-nx-supabase.js',
    'scripts/probe-nx-supabase-ui.js',
]

# --- integrity guards: every file must exist and be non-empty (except allowed empties)
missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

# spot checks (catch half-applied edits)
def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path} missing marker: {n}'

must_contain('supabase/nx-supabase-setup.sql', ['nx_identities', 'nx_file_chunks', 'nx_admin_overview', 'pgcrypto'])
must_contain('src/main/core/nx-supabase.js', ['TICK_MS = 5000', 'nx_chat_members', 'adminUnlock', 'POOL_REGIONS', 'nx_file_chunks'])
must_contain('src/main/core/skin-heads.js', ['headPngFromSkin', 'generatedAvatarDataUrl', "crop({ x: 8, y: 8, width: 8, height: 8 })"])
must_contain('src/main/core/nx-cloud.js', ["mode === 'supabase'", 'setSupabaseUrl', 'annCreate', 'skinHead'])
must_contain('src/main/core/settings.js', ['nxSupabaseUrl', 'nxAdminPass', 'version: 4'])
must_contain('src/main/ipc.js', ['nx:setSupabaseUrl', 'nx:adminLock', 'nx:skinHead', 'auth:skinData', 'nx:annCreate'])
must_contain('src/renderer/js/nx.js', ['inviteToChat', 'nx-admin-bar', 'openAdminDevices', 'headImg', 'nx-offline-bar'])
must_contain('src/renderer/js/pages/settings.js', ['nxSupabaseUrl', 'auth:skinData', 'Administrator passphrase'])
must_contain('src/main/vendor/postgres/package.json', '"type":"module"')
must_contain('src/renderer/js/mock-bridge.js', ['nx:skinHead', 'nx:adminList', 'nx:setSupabaseUrl'])
must_contain('package.json', '"version": "3.1.0"')

os.makedirs(OUT, exist_ok=True)
dest = os.path.join(OUT, NAME)
if os.path.exists(dest):
    os.remove(dest)

with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in FILES:
        full = os.path.join(ROOT, rel)
        z.write(full, 'neurax-launcher/' + rel)

size = os.path.getsize(dest)
sha = hashlib.sha256(open(dest, 'rb').read()).hexdigest()

# verify the zip
with zipfile.ZipFile(dest) as z:
    bad = z.testzip()
    assert bad is None, f'corrupt member: {bad}'
    names = z.namelist()
    assert len(names) == len(FILES), f'expected {len(FILES)} members, got {len(names)}'
    # content spot check inside the zip
    sql = z.read('neurax-launcher/supabase/nx-supabase-setup.sql').decode('utf8')
    assert 'nx_identities' in sql and 'nx_chat_messages' in sql
    idx = z.read('neurax-launcher/src/main/vendor/postgres/src/index.js').decode('utf8')
    assert len(idx) > 10000, 'vendored postgres index.js too small'

print(json.dumps({
    'zip': dest, 'files': len(FILES), 'bytes': size, 'sha256': sha[:16] + '…',
}, indent=2))
print('PATCH ZIP OK')
