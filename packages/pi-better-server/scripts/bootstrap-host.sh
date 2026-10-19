#!/usr/bin/env bash
# Bootstrap a user-local pi-better-server on a host that has neither node nor pi.
#
#   scripts/bootstrap-host.sh [PREFIX]        (default PREFIX: $HOME/.pi-better-server)
#
# The runtime/server live under PREFIX; Pi packages live in the Pi agent directory.
# Nothing system-wide is touched and no root is needed. The setup pins:
#   NODE_VERSION  the Node.js runtime (>= 22.18 so .ts runs without a loader)
#   PI_VERSION    @earendil-works/pi-coding-agent
#   HARNESS_VERSION  pi-better-harness, installed as a Pi package
#   MINIMAL_TOOLS_VERSION, ASK_USER_QUESTION_VERSION, WEB_TOOLS_VERSION
#   the server    this package's own src/, copied from the checkout that holds this script
# Override package versions with environment variables. Pi registers extensions
# in PI_CODING_AGENT_DIR (default ~/.pi/agent), shared by native Pi and the daemon.
set -euo pipefail

PREFIX="${1:-${PI_SERVER_PREFIX:-$HOME/.pi-better-server}}"
NODE_VERSION="${NODE_VERSION:-24.14.1}"
PI_VERSION="${PI_VERSION:-0.82.1}"
HARNESS_VERSION="${HARNESS_VERSION:-0.31.0}"
MINIMAL_TOOLS_VERSION="${MINIMAL_TOOLS_VERSION:-2.1.4}"
ASK_USER_QUESTION_VERSION="${ASK_USER_QUESTION_VERSION:-2.13.9}"
WEB_TOOLS_VERSION="${WEB_TOOLS_VERSION:-2.13.9}"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) NODE_DIST="linux-x64" ;;
  Linux-aarch64 | Linux-arm64) NODE_DIST="linux-arm64" ;;
  Darwin-arm64) NODE_DIST="darwin-arm64" ;;
  Darwin-x86_64) NODE_DIST="darwin-x64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$PREFIX/bin"
chmod 700 "$PREFIX"

NODE_HOME="$PREFIX/node-v$NODE_VERSION-$NODE_DIST"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  tmp="$(mktemp -d "$PREFIX/.node-download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$NODE_DIST.tar.xz" -o "$tmp/node.tar.xz"
  tar -xJf "$tmp/node.tar.xz" -C "$PREFIX"
fi
export PATH="$NODE_HOME/bin:$PATH"

# Pi itself, pinned. The package.json keeps `npm` from treating $PREFIX as part of another project.
if [ ! -f "$PREFIX/package.json" ]; then
  printf '{ "name": "pi-better-server-host", "private": true }\n' > "$PREFIX/package.json"
fi
(cd "$PREFIX" && npm install --no-audit --no-fund --save-exact "@earendil-works/pi-coding-agent@$PI_VERSION")

# Register extensions with Pi, not just npm: the SDK loads configured Pi packages.
for package in \
  "npm:@vanillagreen/pi-codex-minimal-tools@$MINIMAL_TOOLS_VERSION" \
  "npm:@juicesharp/rpiv-ask-user-question@$ASK_USER_QUESTION_VERSION" \
  "npm:@juicesharp/rpiv-web-tools@$WEB_TOOLS_VERSION" \
  "npm:pi-better-harness@$HARNESS_VERSION"; do
  "$PREFIX/node_modules/.bin/pi" install "$package"
done

# The server stays outside node_modules: Node refuses to run .ts files from there.
rm -rf "$PREFIX/server"
mkdir -p "$PREFIX/server"
cp -R "$PKG_DIR/src" "$PREFIX/server/src"
printf '{ "type": "module" }\n' > "$PREFIX/server/package.json"
rev="$(git -C "$PKG_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
printf 'node %s\npi %s\npi-better-harness %s\nharness-rev %s\n' "$NODE_VERSION" "$PI_VERSION" "$HARNESS_VERSION" "$rev" > "$PREFIX/VERSIONS"
printf 'pi-codex-minimal-tools %s\nrpiv-ask-user-question %s\nrpiv-web-tools %s\n' "$MINIMAL_TOOLS_VERSION" "$ASK_USER_QUESTION_VERSION" "$WEB_TOOLS_VERSION" >> "$PREFIX/VERSIONS"

cat > "$PREFIX/bin/pi-server" <<LAUNCHER
#!/bin/sh
export PATH="$NODE_HOME/bin:\$PATH"
exec node "$PREFIX/server/src/cli.ts" "\$@"
LAUNCHER
chmod 755 "$PREFIX/bin/pi-server"

cat "$PREFIX/VERSIONS"
echo "installed: $PREFIX/bin/pi-server"
