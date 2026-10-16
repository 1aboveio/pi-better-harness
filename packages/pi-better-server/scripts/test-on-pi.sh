#!/usr/bin/env bash
# Run this package's test suite against a given Pi version without touching the repo's lockfile.
#
#   scripts/test-on-pi.sh 1.0.0 [PREFIX]    (default PREFIX: <package>/.pi-compat/<version>)
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
cp -R "$PKG_DIR/src" "$PKG_DIR/test" "$PKG_DIR/package.json" "$PKG_DIR/tsconfig.json" "$PREFIX/packages/pi-better-server/"
[ -d "$PKG_DIR/codex-plugin" ] && cp -R "$PKG_DIR/codex-plugin" "$PREFIX/packages/pi-better-server/"

cd "$PREFIX/packages/pi-better-server"
installed="$(node -p "require('$PREFIX/node_modules/@earendil-works/pi-coding-agent/package.json').version")"
echo "testing against pi-coding-agent $installed"
node --import tsx --import ../../scripts/isolate-registry.mjs --test test/*.test.ts
