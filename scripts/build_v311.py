#!/usr/bin/env python3
# build_v311.py — v3.1.1 HOTFIX patch zip (superset of v3.1.0: safe over v3.0.0 OR v3.1.0).
# Fix: multi-cluster (aws-0/1/2) parallel pooler discovery + cached-host fast path
# + truthful failure diagnosis + schema self-check. No npm install, no SQL re-run.
import os, zipfile, hashlib, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v3.1.1-NX-Cloud-Connection-Fix-Patch.zip'

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

# --- integrity guards: every file must exist
missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

# spot checks (catch half-applied edits)
def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path} missing marker: {n}'

must_contain('src/main/core/nx-supabase.js', [
    'POOL_PREFIXES', "'aws-1'", 'poolerCandidates', 'gateStatus', 'checkSchema',
    'needsSchema', 'cached pooler', 'TICK_MS = 5000', 'nx_chat_members', 'adminUnlock',
])
must_contain('src/renderer/js/pages/settings.js', [
    'needsSchema', 'TABLES MISSING', 'nxSupabaseUrl', 'auth:skinData',
])
must_contain('supabase/nx-supabase-setup.sql', ['nx_identities', 'nx_file_chunks', 'nx_admin_overview', 'pgcrypto'])
must_contain('src/main/core/skin-heads.js', ['headPngFromSkin', 'generatedAvatarDataUrl'])
must_contain('src/main/core/nx-cloud.js', ["mode === 'supabase'", 'setSupabaseUrl', 'annCreate'])
must_contain('src/main/ipc.js', ['nx:setSupabaseUrl', 'nx:adminLock', 'nx:skinHead', 'auth:skinData'])
must_contain('src/renderer/js/nx.js', ['inviteToChat', 'nx-admin-bar', 'nx-offline-bar'])
must_contain('src/main/vendor/postgres/package.json', '"type":"module"')
must_contain('PATCH-NOTES.md', ['aws-1-eu-west-1', 'v3.1.1'])
must_contain('package.json', '"version": "3.1.1"')

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
    supa = z.read('neurax-launcher/src/main/core/nx-supabase.js').decode('utf8')
    assert 'aws-1' in supa and 'POOL_PREFIXES' in supa, 'zip content check failed'

print(json.dumps({
    'zip': dest, 'files': len(FILES), 'bytes': size, 'sha256': sha[:16] + '…',
}, indent=2))
print('PATCH ZIP OK')
