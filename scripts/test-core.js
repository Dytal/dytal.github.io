// test-core.js — offline/online smoke tests for the Neurax engine (run: npm run test:core)
// Exercises: paths, settings, store, NBT round-trip, version manifest, provider APIs.
process.env.NEURAX_HOME = process.env.NEURAX_HOME || '/tmp/neurax-test-' + Date.now();

const assert = require('assert');
const paths = require('../src/main/core/paths');

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Neurax core tests — data root:', paths.NEURAX);

  await test('paths: creates the .neurax tree', () => {
    paths.ensureDirs();
    for (const d of Object.values(paths.DIRS)) {
      assert.ok(require('fs').existsSync(d), d + ' missing');
    }
  });

  await test('settings: defaults load & persist', () => {
    const s = require('../src/main/core/settings');
    s.load();
    s.set({ theme: 'cyan' });
    assert.strictEqual(s.get().theme, 'cyan');
    assert.strictEqual(require('../src/main/core/paths').readJSON(paths.DIRS.root + '/settings.json').theme, 'cyan');
    s.set({ theme: 'emerald' });
  });

  await test('store: instance & server CRUD', () => {
    const store = require('../src/main/core/store');
    const inst = store.createInstance({ name: 'TestInstance', version: '1.21.4', loader: 'fabric', loaderVersion: '0.16.9', memoryMB: 2048 });
    assert.ok(store.getInstance(inst.id));
    assert.ok(require('fs').existsSync(store.instanceGameDir(inst.id)));
    store.updateInstance(inst.id, { name: 'Renamed' });
    assert.strictEqual(store.getInstance(inst.id).name, 'Renamed');
    assert.strictEqual(store.deleteInstance(inst.id).name, 'Renamed');
    assert.strictEqual(store.getInstance(inst.id), null);

    const srv = store.createServer({ name: 'TestSrv', type: 'paper', version: '1.21.4', memoryMB: 1024, port: 25599, motd: 'hi' });
    assert.ok(store.getServer(srv.id));
    assert.strictEqual(store.deleteServer(srv.id).id, srv.id);
  });

  await test('nbt: full round-trip (gzip, all tag types)', () => {
    const nbt = require('../src/main/core/nbt');
    const root = {
      name: '',
      value: { $compound: {
        s: { type: 8, value: 'hello' },
        i: { type: 3, value: -42 },
        l: { type: 4, value: 9007199254740993n },
        f: { type: 5, value: 1.5 },
        d: { type: 6, value: 3.14159 },
        b: { type: 7, value: { $bytes: Buffer.from([9, 8, 7]) } },
        list: { type: 9, itemType: 8, value: { $list: ['a', 'b'] } },
        nested: { type: 10, value: { $compound: { x: { type: 3, value: 1 } } } },
        ia: { type: 11, value: { $intarray: [5, 6] } },
        la: { type: 12, value: { $longarray: [7n] } },
      } },
    };
    const back = nbt.parse(nbt.serialize(root, { gzip: true }));
    const c = back.value.$compound;
    assert.strictEqual(c.s.value, 'hello');
    assert.strictEqual(c.l.value, 9007199254740993n);
    assert.deepStrictEqual([...c.b.value.$bytes], [9, 8, 7]);
    assert.strictEqual(c.nested.value.$compound.x.value, 1);
  });

  await test('nbt: parses a real player-style gzipped payload', () => {
    const nbt = require('../src/main/core/nbt');
    const fake = { name: '', value: { $compound: { Data: { type: 10, value: { $compound: { LevelName: { type: 8, value: 'World' } } } } } } };
    const parsed = nbt.parse(nbt.serialize(fake));
    assert.strictEqual(parsed.value.$compound.Data.value.$compound.LevelName.value, 'World');
  });

  if (process.env.NEURAX_OFFLINE) {
    console.log('\n(online tests skipped — NEURAX_OFFLINE set)');
  } else {
    await test('versions: Mojang manifest (all releases + snapshots)', async () => {
      const v = require('../src/main/core/versions');
      const all = await v.getAllVersions();
      assert.ok(all.groups.Releases.length > 50, 'releases');
      assert.ok(all.groups.Snapshots.length > 10, 'snapshots');
      assert.ok(all.latest.release);
    });

    await test('versions: fabric + forge + neoforge metadata', async () => {
      const v = require('../src/main/core/versions');
      const fab = await v.getFabricLoaderVersions('1.21.4');
      assert.ok(fab.length > 0);
      const forge = await v.getForgeVersions('1.21.4');
      assert.ok(forge.length > 0);
      const neo = await v.getNeoForgeVersions('1.21.4');
      assert.ok(neo.length > 0);
    });

    await test('modrinth: real search returns hits', async () => {
      const mr = require('../src/main/core/modrinth');
      const res = await mr.search({ q: 'sodium', projectType: 'mod', limit: 5 });
      assert.ok(res.hits.length > 0);
      assert.ok(res.hits[0].downloads > 1000);
    });

    await test('game: version json merge (inheritsFrom flattening)', async () => {
      const g = require('../src/main/core/game');
      const parent = { id: '1.20.1', libraries: [{ name: 'parent-lib' }], arguments: { game: ['--parent'], jvm: ['-Dp=1'] }, mainClass: 'net.minecraft.client.main.Main' };
      const child = { inheritsFrom: '1.20.1', id: 'x-forge', libraries: [{ name: 'forge-lib' }], arguments: { game: ['--child'], jvm: ['-Df=2'] }, mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher' };
      const merged = g.mergeVersionJson(child, parent);
      assert.strictEqual(merged.libraries.length, 2);
      assert.strictEqual(merged.mainClass, child.mainClass);
      assert.ok(merged.arguments.game.includes('--parent') && merged.arguments.game.includes('--child'));
      assert.ok(!merged.inheritsFrom);
    });

    await test('java: correct java major per MC version', () => {
      const j = require('../src/main/core/java');
      assert.strictEqual(j.javaMajorFor('1.12.2'), 8);
      assert.strictEqual(j.javaMajorFor('1.16.5'), 8);
      assert.strictEqual(j.javaMajorFor('1.17.1'), 16);
      assert.strictEqual(j.javaMajorFor('1.18.2'), 17);
      assert.strictEqual(j.javaMajorFor('1.20.4'), 17);
      assert.strictEqual(j.javaMajorFor('1.20.5'), 21);
      assert.strictEqual(j.javaMajorFor('1.21.4'), 21);
      assert.strictEqual(j.javaMajorFor('26.0'), 21);
      assert.strictEqual(j.javaMajorFor('26.1'), 25); // MC 26.1+ requires Java 25
      assert.strictEqual(j.javaMajorFor('26.3'), 25);
      assert.strictEqual(j.javaMajorFor('27.1'), 25);
    });

    await test('java: parses `java -version` output from stdout OR stderr', () => {
      // java -version prints to STDERR — the old code only read stdout, so every
      // JDK looked undetectable and the launcher re-downloaded Java every launch.
      const j = require('../src/main/core/java');
      assert.strictEqual(j.parseJavaVersion('openjdk version "25.0.4.1" 2026-01-20'), 25);
      assert.strictEqual(j.parseJavaVersion('openjdk version "21.0.5" 2024-10-15'), 21);
      assert.strictEqual(j.parseJavaVersion('openjdk version "17.0.2" 2022-01-18'), 17);
      assert.strictEqual(j.parseJavaVersion('java version "1.8.0_402"\nJava(TM) SE Runtime Environment'), 8);
      assert.strictEqual(j.parseJavaVersion('openjdk version "26" 2026-03-17'), 26);
      assert.strictEqual(j.parseJavaVersion(''), 0);
      assert.strictEqual(j.parseJavaVersion(null), 0);
      assert.strictEqual(j.parseJavaVersion('total garbage, no version here'), 0);
    });

    await test('modrinth: pickBestVersion picks the LATEST working version', () => {
      const mr = require('../src/main/core/modrinth');
      const vs = [
        { version_number: '2.0', loaders: ['fabric'], game_versions: ['1.21.4'] },
        { version_number: '1.9', loaders: ['fabric'], game_versions: ['1.21.1'] },
        { version_number: '1.0', loaders: ['forge'], game_versions: ['1.21.4'] },
      ];
      assert.strictEqual(mr.pickBestVersion(vs, { loader: 'fabric', gameVersion: '1.21.4' }).version_number, '2.0');
      assert.strictEqual(mr.pickBestVersion(vs, { loader: 'forge', gameVersion: '1.21.4' }).version_number, '1.0');
      // no version lists that game version → fall back to the LATEST version
      // matching the loader (the renderer's compat check then re-validates it)
      assert.strictEqual(mr.pickBestVersion(vs, { loader: 'fabric', gameVersion: '1.20' }).version_number, '2.0');
      // no constraints → newest overall
      assert.strictEqual(mr.pickBestVersion(vs, {}).version_number, '2.0');
      assert.strictEqual(mr.pickBestVersion([], {}), null);
    });

    await test('modrinth: server installs route to plugins/ or mods/ by loaders', () => {
      const mr = require('../src/main/core/modrinth');
      assert.strictEqual(mr.folderFor('mod', { type: 'server' }, ['paper', 'purpur']), 'plugins');
      assert.strictEqual(mr.folderFor('plugin', { type: 'server' }, ['paper']), 'plugins');
      assert.strictEqual(mr.folderFor('mod', { type: 'server' }, ['fabric', 'forge']), 'mods');
      assert.strictEqual(mr.folderFor('mod', { type: 'instance' }, ['fabric']), 'mods');
      assert.strictEqual(mr.folderFor('shader', { type: 'instance' }, []), 'shaderpacks');
      assert.strictEqual(mr.folderFor('resourcepack', null, []), 'resourcepacks');
    });

    await test('modrinth: safeJoin refuses modpack path traversal', () => {
      const mr = require('../src/main/core/modrinth');
      const path = require('path');
      assert.throws(() => mr.safeJoin('/tmp/game', '../../evil.jar'), /Unsafe path/);
      assert.throws(() => mr.safeJoin('/tmp/game', 'mods/../../evil.jar'), /Unsafe path/);
      assert.strictEqual(mr.safeJoin('/tmp/game', 'mods/a.jar'), path.resolve('/tmp/game/mods/a.jar'));
    });
  }

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nAll core tests passed.');
})();
