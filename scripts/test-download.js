// test-download.js — verifies the EPERM-hardened download path:
// 1. normal download finalizes correctly
// 2. a stale file at the destination is replaced (rename-over-locked-file case)
// 3. no leftover .part files remain
process.env.NEURAX_HOME = '/tmp/neurax-dl-' + Date.now();
const fs = require('fs');
const path = require('path');
const paths = require('../src/main/core/paths');
const { download } = require('../src/main/core/net');

(async () => {
  paths.ensureDirs();
  const dest = path.join(paths.DIRS.temp, 'dl-test.bin');
  // url → small real file (Mojang piston-meta is ~600KB json); use a tiny file instead:
  const url = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
  const bytes = await download(url, dest, { tries: 2 });
  const size = fs.statSync(dest).size;
  console.log('downloaded bytes:', bytes, '| file size:', size, bytes === size ? 'MATCH' : 'MISMATCH');
  if (bytes !== size) process.exit(1);

  // second run with a stale destination present (the case that used to EPERM)
  fs.writeFileSync(dest, 'stale-stale-stale');
  const bytes2 = await download(url, dest, { tries: 2 });
  const size2 = fs.statSync(dest).size;
  console.log('overwritten stale dest:', size2, bytes2 === size2 ? 'MATCH' : 'MISMATCH');
  if (bytes2 !== size2) process.exit(1);

  const leftovers = fs.readdirSync(paths.DIRS.temp).filter(f => f.includes('.part'));
  console.log('leftover .part files:', leftovers.length, leftovers.join(', '));
  if (leftovers.length) process.exit(1);
  console.log('download finalize: PASS');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
