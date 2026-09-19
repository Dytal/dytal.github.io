// check-syntax.js — syntax-check all renderer ES modules (as .mjs) + main CJS files.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
const files = [
  'src/main/main.js', 'src/main/ipc.js', 'src/main/preload.js',
  'src/main/core/net.js', 'src/main/core/java.js', 'src/main/core/game.js',
  'src/main/core/auth.js', 'src/main/core/logger.js', 'src/main/core/settings.js',
  'src/renderer/js/main.js', 'src/renderer/js/utils.js', 'src/renderer/js/state.js',
  'src/renderer/js/router.js', 'src/renderer/js/mock-bridge.js',
  'src/renderer/js/components/modal.js', 'src/renderer/js/components/toast.js',
  'src/renderer/js/components/dropdown.js',
  'src/renderer/js/pages/home.js', 'src/renderer/js/pages/newinstance.js',
  'src/renderer/js/pages/newserver.js', 'src/renderer/js/pages/servers.js',
  'src/renderer/js/pages/settings.js', 'src/renderer/js/pages/modrinth.js',
  'src/renderer/js/pages/store-common.js',
  'scripts/test-core.js',
];

let failed = 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neurax-syntax-'));
for (const rel of files) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) { console.log('MISSING  ' + rel); failed++; continue; }
  const isModule = rel.startsWith('src/renderer/');
  const tmpFile = path.join(tmp, path.basename(rel) + (isModule ? '.mjs' : '.cjs'));
  fs.copyFileSync(abs, tmpFile);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    console.log('OK       ' + rel);
  } catch (e) {
    failed++;
    console.log('FAIL     ' + rel + '\n' + String(e.stderr));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.log(`\n${failed} file(s) failed`); process.exit(1); }
console.log('\nAll syntax checks passed.');
