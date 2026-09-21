#!/usr/bin/env python3
# build_v315.py — v3.1.5 patch zip (superset of v3.1.0–v3.1.4: safe over v3.0.0+).
# NEW: encrypted read-only memory vault (CC + launcher), CC .neurax root path fix,
#      lock-message typing preserved across the 5s refresh, 1-min announcements
#      auto-refresh in the launcher, probe-boot.js + probe-vault.js.
import os, zipfile, hashlib, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v3.1.5-Memory-Vault-Refresh-Fixes-Patch.zip'

FILES = [
    'PATCH-NOTES.md',
    'package.json',
    'supabase/nx-supabase-setup.sql',
    'src/main/core/nx-vault.js',
    'src/main/core/nx-admin-keys.js',
    'src/main/core/paths.js',
    'src/main/core/nx-supabase.js',
    'src/main/core/skin-heads.js',
    'src/main/core/nx-cloud.js',
    'src/main/core/settings.js',
    'src/main/core/auth.js',
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
    'scripts/probe-vault.js',
    'scripts/probe-boot.js',
]

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path} missing marker: {n}'

must_contain('src/main/core/nx-vault.js', [
    'AES-256-GCM', 'createCipheriv', 'scryptSync', 'NXVB1', 'getAuthTag',
    'rememberLogin', 'rememberCcSession', 'forgetCcSession', 'noteAdminUnlock',
    'rememberedLogins', 'MAX_LOGINS', 'chmodSync', 'corrupt-',
])
must_contain('src/main/core/nx-admin-keys.js', [
    'ADMIN_KEY', 'UNLOCK_PASSKEY', 'nx-keys.local.json',
])
must_contain('nx-cloud/control-center.js', [
    'statePayload', '/api/lock', '/api/unlock', '/api/ann/create', '/api/ann/delete',
    'EADDRINUSE', 'probeHolder', 'pathToFileURL', 'neurax-console',
    "CC_VERSION = '3.1.5'",
    'core\', \'paths.js\'',          # .neurax root resolved via the launcher paths.js (v3.1.5 path fix)
    'nx-vault.js', 'ccVault', 'rememberCcSession', 'forgetCcSession',  # memory vault
])
must_contain('nx-cloud/control-center.html', [
    'snapshotEdits', 'restoreEdits',              # typing survives the 5s refresh
    'insts-${d.uuid}',                            # stable details ids
    'remembered (encrypted)',                     # login hint mentions memory
])
must_contain('src/main/core/auth.js', [
    'rememberLogin', 'nx-vault',
])
must_contain('src/main/ipc.js', [
    'noteAdminUnlock', 'vault:status', 'vault:remembered', 'forgetAccount',
    'UNLOCK_PASSKEY', 'unlockPasskey',
])
must_contain('src/renderer/js/pages/settings.js', [
    'Encrypted memory vault', 'vault:remembered', 'Remembered logins',
])
must_contain('src/renderer/js/nx.js', [
    'startAnnAutoRefresh', '60000', 'passkey',
])
must_contain('src/main/core/settings.js', ['nxAdminPass', '127.0.0.1:8790'])
must_contain('src/main/core/paths.js', ["'.neurax'", 'NEURAX_HOME'])
must_contain('scripts/probe-vault.js', ['tampered vault heals', 'probe-vault'])
must_contain('scripts/probe-boot.js', ['REMEMBERED', 'vault.bin'])
must_contain('scripts/probe-control-center.js', [
    'REMEMBERED LOGIN', 'cc-vault.bin', 'snapshotEdits', "$XDG_CONFIG_HOME/.neurax",
])

# negative assertions (regression guards)
def must_not_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n not in txt, f'{path} must NOT contain: {n}'

must_not_contain('nx-cloud/control-center.js', ['function neuraxRoot'])  # old private root resolver gone
must_not_contain('src/renderer/js/pages/settings.js', ['Administrator passphrase'])

with open(os.path.join(ROOT, 'package.json'), 'r', encoding='utf-8') as fh:
    assert '"version": "3.1.5"' in fh.read(), 'package.json version must be 3.1.5'

os.makedirs(OUT, exist_ok=True)
dest = os.path.join(OUT, NAME)
if os.path.exists(dest):
    os.remove(dest)
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for rel in FILES:
        z.write(os.path.join(ROOT, rel), rel)

size = os.path.getsize(dest)
sha = hashlib.sha256(open(dest, 'rb').read()).hexdigest()
with zipfile.ZipFile(dest) as z:
    assert len(z.namelist()) == len(FILES), 'member count mismatch'
print(json.dumps({'zip': dest, 'files': len(FILES), 'bytes': size, 'sha256': sha[:16] + '…'}))
