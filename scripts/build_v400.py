#!/usr/bin/env python3
# build_v400.py — v4.0.0 patch zip (superset of all previous patches: safe over v3.0.0+).
# NEW: low-VRAM/low-RAM engine tuning, friends + DMs (no group needed), message
#      edit/delete-for-me/delete-for-everyone, group admins/rename/delete/kick,
#      P2P voice chat, account/device blocklist (cross-device login refusal),
#      activity feed, Control Center chats/blocks/events tabs, announcement
#      banner+icon themes visible in the launcher, mock harness gated out of prod.
import os, zipfile, hashlib, json, re, subprocess, tempfile, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/home/z/my-project/download'
NAME = 'Neurax-Launcher-v4.0.0-Chat-Voice-Cloud-Control-Performance-Patch.zip'

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
    'src/renderer/js/pages/settings.js',
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
]

missing = [f for f in FILES if not os.path.isfile(os.path.join(ROOT, f))]
assert not missing, f'missing files: {missing}'

def must_contain(path, needles):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as fh:
        txt = fh.read()
    for n in needles:
        assert n in txt, f'{path}: missing marker {n!r}'

# ---- content assertions (fail the build before shipping a broken patch) ----
must_contain('package.json', ['"version": "4.0.0"'])
must_contain('src/main/main.js', ['enable-low-end-device-mode', 'disable-webgl2',
                                  'gpu-rasterization-msaa-sample-count', 'max-old-space-size=384',
                                  'setPermissionRequestHandler'])
must_contain('src/main/core/perf.js', ['PRIORITY_BELOW_NORMAL', 'setGameRunning'])
must_contain('src/main/core/game.js', ["require('./perf').setGameRunning(true)", "require('./perf').setGameRunning(false)"])
must_contain('src/main/core/nx-supabase.js', [
    'async function chatDM(', 'async function chatDelete(', 'async function chatRename(',
    'async function chatSetRole(', 'async function chatKick(', 'async function chatStar(',
    'async function msgEdit(', 'async function msgDeleteForMe(', 'async function msgDeleteForEveryone(',
    'async function friendsList(', 'async function friendAdd(', 'async function friendRemove(', 'async function friendStar(',
    'async function blockList(', 'async function blockAdd(', 'async function blockRemove(',
    'async function loginGate(', 'async function findMyBlock(', 'function logEvent(', 'async function eventsList(',
    'async function voiceJoin(', 'async function voiceTick(', 'async function voiceSignal(',
    'async function voiceUpdate(', 'async function voiceLeave(', 'async function scanVoiceRooms(',
    'async function loadChats(', 'async function resolveMsaTarget(', 'findMyBlock()', 'nx_message_deletes',
])
must_contain('src/main/core/nx-cloud.js', [
    'setLoginGate', 'chatDM', 'blockList', 'voiceJoin', 'voiceTick', 'logEvent', 'setPlayer(',
])
must_contain('src/main/core/auth.js', ['setLoginGate', 'gateOrThrow', 'BLOCKED from using Neurax'])
must_contain('src/main/ipc.js', ['nx:chatDM', 'nx:chatDelete', 'nx:chatSetRole', 'nx:chatKick', 'nx:msgEdit',
                                 'nx:msgDeleteForMe', 'nx:msgDeleteForEveryone', 'nx:friendAdd', 'nx:voiceJoin',
                                 'nx:blockAdd', 'nx:eventsList'])
must_contain('src/main/preload.js', ["'nx:voice'"])
must_contain('src/renderer/js/nx.js', [
    "from './nx-voice.js'", 'function openFriends(', 'function openChatSettings(', 'async function deleteChat(',
    'function blockForm(', 'async function openBlocklist(', 'function renderVoiceBar(', 'function joinVoice(',
    'async function editMessage(', 'async function deleteMessage(', 'nx-ann-banner', 'ICON_GLYPHS',
    'MS UUID', 'HEAD_CACHE_MAX', 'inlineMediaRemember', 'ACCESS BLOCKED',
])
must_contain('src/renderer/js/nx-voice.js', ['RTCPeerConnection', 'ICE_SERVERS', 'voiceCtl.join', 'voiceCtl.leave', 'toggleMute'])
must_contain('src/renderer/index.html', ['js/mock-bridge.js'])
must_contain('src/renderer/js/mock-bridge.js', ['devmock', 'if (window.neurax) return'])
must_contain('src/renderer/styles/nx.css', ['.nx-ann-banner', '.nx-friend-row', '.nx-voice-bar', '.nx-msg-ops',
                                            '.nx-presence-dot', '.nx-flag.block', 'no backdrop-filter'])
must_contain('nx-cloud/control-center.js', ['/api/chat/messages', '/api/chat/message/edit', '/api/chat/message/delete',
                                            '/api/chat/delete', '/api/block/add', '/api/block/remove',
                                            'nx_blocklist', 'nx_events', 'nx_voice_rooms'])
must_contain('nx-cloud/control-center.html', ['tab-chats', 'tab-blocks', 'tab-events', 'renderChats', 'blockRow', 'eventRow', 's-voice'])
must_contain('supabase/nx-supabase-setup.sql', [
    'nx_friends', 'nx_blocklist', 'nx_events', 'nx_voice_rooms', 'nx_voice_participants',
    'nx_voice_signals', 'nx_message_deletes', "kind        text not null default 'group'",
    'deleted_for_everyone', 'add column if not exists',
])

# ---- HTML inline script syntax check (control-center.html) ----
tmp = tempfile.mkdtemp()
try:
    html = open(os.path.join(ROOT, 'nx-cloud/control-center.html'), encoding='utf-8').read()
    scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
    assert scripts, 'control-center.html: no inline script found'
    for i, s in enumerate(scripts):
        f = os.path.join(tmp, f'cc-{i}.cjs')
        open(f, 'w', encoding='utf-8').write(s)
        r = subprocess.run([sys.executable, '-c', 'pass'])  # keep py happy
        node = subprocess.run(['node', '--check', f], capture_output=True, text=True)
        assert node.returncode == 0, f'control-center.html inline script {i} syntax error:\n{node.stderr}'
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---- JS syntax sweep via the project checker ----
r = subprocess.run(['node', os.path.join('scripts', 'check-syntax.js)], cwd=ROOT')]) if False else subprocess.run(['node', os.path.join(ROOT, 'scripts', 'check-syntax.js')], capture_output=True, text=True, cwd=ROOT)
assert r.returncode == 0, f'check-syntax failed:\n{r.stdout}\n{r.stderr}'

# ---- package ----
os.makedirs(OUT, exist_ok=True)
dest = os.path.join(OUT, NAME)
if os.path.exists(dest):
    os.remove(dest)
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(os.path.join(ROOT, f), f)

sha = hashlib.sha256(open(dest, 'rb').read()).hexdigest()
size = os.path.getsize(dest)
with open(os.path.join(OUT, NAME + '.sha256'), 'w') as fh:
    fh.write(f'{sha}  {NAME}\n')

print(f'OK {NAME} ({size/1024:.1f} KB)')
print(f'   sha256 {sha}')
print(f'   {len(FILES)} files · content assertions passed · HTML inline JS + all JS syntax OK')
