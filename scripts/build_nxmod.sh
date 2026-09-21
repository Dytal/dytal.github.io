#!/usr/bin/env bash
# build_nxmod.sh — compile the NX Fabric mod for Minecraft 26.1.2 WITHOUT Gradle/Loom.
#
# Why this works: Mojang stopped obfuscating the game (26.x ships mojmap-named
# classes; yarn does not exist for 26.1.2 and fabric-loader's intermediary is
# 0.0.0 = identity). A plain javac against the vanilla jar + fabric-api's nested
# event jars + modmenu produces a production-valid Fabric mod jar — no remap step.
#
# Deps (all downloaded + sha1-verified by hand into nx-mod/deps):
set -euo pipefail
ROOT=/home/z/my-project
NX=$ROOT/nx-mod
JDK=$(ls -d $ROOT/tools/jdk-25*/bin | head -1)
DEPS=$NX/deps
LIBS=$ROOT/research/libs
CP=$(printf '%s:' "$DEPS/fabricapi-nested/META-INF/jars/fabric-lifecycle-events-v1-4.1.1+df84eb3d4c.jar" \
                  "$DEPS/fabricapi-nested/META-INF/jars/fabric-rendering-v1-23.3.1+e9207d814c.jar" \
                  "$DEPS/fabricapi-nested/META-INF/jars/fabric-api-base-2.0.3+ece063234c.jar" \
                  "$DEPS/fabricapi-nested/META-INF/jars/fabric-screen-api-v1-5.1.0+981dd9b24c.jar" \
                  "$DEPS/fabric-loader.jar" "$DEPS/modmenu.jar")$ROOT/research/client-26.1.2.jar
# Mojang libraries (brigadier, gson, guava, ...) downloaded from the official 26.1.2 manifest
LIBCP=$(find "$LIBS" -name '*.jar' ! -name '*natives*' | sort | tr '\n' ':')
CP="${LIBCP}${CP}"

rm -rf "$NX/build/classes" "$NX/build/nx-1.0.0.jar"
mkdir -p "$NX/build/classes"
"$JDK/javac" -proc:none -nowarn -cp "$CP" -d "$NX/build/classes" \
  "$NX"/src/main/java/dev/neurax/nx/*.java

# package: classes + resources (fabric.mod.json, icon) at the jar root
cd "$NX/build/classes"
cp -r "$NX/src/main/resources/"* .
# gson is shipped by Minecraft itself; nothing to nest. Keep the jar lean.
zip -q -r -X "$NX/build/nx-1.0.0.jar" . -x '.*' -x '__MACOSX*'
cd "$NX"
echo "=== jar built ==="
ls -la build/nx-1.0.0.jar
unzip -l build/nx-1.0.0.jar
echo "=== sanity: fabric.mod.json parses ==="
python3 - <<'EOF'
import json, zipfile
z = zipfile.ZipFile('/home/z/my-project/nx-mod/build/nx-1.0.0.jar')
fm = json.loads(z.read('fabric.mod.json'))
assert fm['id'] == 'nx' and 'client' in fm['entrypoints'] and 'modmenu' in fm['entrypoints']
names = z.namelist()
for c in ['dev/neurax/nx/NXClient.class', 'dev/neurax/nx/NXConfig.class',
          'dev/neurax/nx/NXConfigScreen.class', 'dev/neurax/nx/NXModMenu.class',
          'assets/nx/icon.png']:
    assert c in names, c
data = z.read('dev/neurax/nx/NXClient.class')
print('OK: fabric.mod.json valid, all entrypoints + icon present')
print('NXClient.class version:', data[6] * 256 + data[7], '(69 = Java 25)')
EOF
