#!/usr/bin/env bash
# Run this package's test suite against a given Pi version without touching the repo's lockfile.
#
#   scripts/test-on-pi.sh 1.2.0 [PREFIX]    (default PREFIX: <package>/.pi-compat/<version>)
#
# Installs @earendil-works/pi-coding-agent@VERSION and pi-ai@VERSION into PREFIX,
# copies the package next to them, and runs `node --test` there so every import
# resolves to that Pi and not to the workspace's.
set -euo pipefail

PI_VERSION="${1:?usage: test-on-pi.sh <pi-version> [prefix]}"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$PKG_DIR/../.." && pwd)"
PREFIX="${2:-$PKG_DIR/.pi-compat/$PI_VERSION}"

node "$ROOT_DIR/scripts/sync-shared-ssh-core.mjs"

rm -rf "$PREFIX"
mkdir -p "$PREFIX/packages/pi-better-server" "$PREFIX/scripts"
printf '{ "name": "pi-compat", "private": true }\n' > "$PREFIX/package.json"
(cd "$PREFIX" && npm install --no-audit --no-fund \
  "@earendil-works/pi-coding-agent@$PI_VERSION" "@earendil-works/pi-ai@$PI_VERSION" \
  tsx@^4.22.3 typescript@^6.0.0 @types/node@^25.0.0)

cp "$ROOT_DIR/scripts/isolate-registry.mjs" "$PREFIX/scripts/"
cp -R "$PKG_DIR/src" "$PKG_DIR/test" "$PKG_DIR/scripts" "$PKG_DIR/package.json" "$PKG_DIR/tsconfig.json" "$PREFIX/packages/pi-better-server/"
[ -d "$PKG_DIR/codex-plugin" ] && cp -R "$PKG_DIR/codex-plugin" "$PREFIX/packages/pi-better-server/"
# Background-activity regressions load the real sibling provider against this SDK.
node --input-type=module - "$ROOT_DIR" "$PREFIX" <<'NODE'
import { cpSync } from "node:fs";
import { basename, join } from "node:path";
for (const name of ["pi-better-subagents", "pi-better-background-tasks", "operation-coordinator"]) {
  cpSync(join(process.argv[2], "packages", name), join(process.argv[3], "packages", name), {
    recursive: true, filter: path => !["node_modules", ".work", ".pi-compat"].includes(basename(path)),
  });
}
NODE
# Install the consumer's declared runtime closure, not just the host's transitives.
# Its host-provided peers must keep resolving to the requested Pi above.
(cd "$PREFIX/packages/pi-better-subagents" && npm install --omit=dev --ignore-scripts --legacy-peer-deps --package-lock=false --no-audit --no-fund)
(cd "$PREFIX/packages/pi-better-background-tasks" && npm install --omit=dev --ignore-scripts --legacy-peer-deps --package-lock=false --no-audit --no-fund)

cd "$PREFIX/packages/pi-better-server"
installed="$(node -p "require('$PREFIX/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
echo "testing against pi-coding-agent $installed"
tests=("${@:3}")
if [ "${#tests[@]}" -eq 0 ]; then tests=(test/*.test.ts); fi
if [ -n "${TEST_SHARD:-}" ]; then
  tests=("--test-shard=$TEST_SHARD" "${tests[@]}")
fi
PI_RUNTIME_PACK_WORKSPACE="$ROOT_DIR" node --import tsx --import ../../scripts/isolate-registry.mjs --test --test-concurrency=4 "${tests[@]}"
