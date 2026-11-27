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
PREFIX="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$PREFIX")"
NODE_HOME="$PREFIX/node-v$NODE_VERSION-$NODE_DIST"
export PATH="$NODE_HOME/bin:$PATH"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_SERVER_DIR="${PI_SERVER_DIR:-$PI_CODING_AGENT_DIR/server}"

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

# Register only runtime identity, never credentials or project/agent settings. Write atomically.
PI_BOOTSTRAP_PREFIX="$PREFIX" PI_BOOTSTRAP_NODE_HOME="$NODE_HOME" node --input-type=module <<'NODE'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const prefix = process.env.PI_BOOTSTRAP_PREFIX;
const nodeHome = process.env.PI_BOOTSTRAP_NODE_HOME;
const launcher = join(prefix, "bin", "pi-server");
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR);
const defaultServerDir = resolve(process.env.PI_SERVER_DIR);
for (const value of [launcher, agentDir, defaultServerDir]) {
  if (/[\0\r\n]/.test(value)) throw new Error("Runtime registration paths cannot contain NUL or line breaks");
}
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
writeFileSync(launcher, [
  "#!/bin/sh",
  `export PATH=${quote(join(nodeHome, "bin"))}:"$PATH"`,
  `export PI_SERVER_LAUNCHER=${quote(launcher)}`,
  `if [ -z "\${PI_CODING_AGENT_DIR:-}" ]; then export PI_CODING_AGENT_DIR=${quote(agentDir)}; fi`,
  `if [ -z "\${PI_SERVER_DIR:-}" ]; then export PI_SERVER_DIR=${quote(defaultServerDir)}; fi`,
  `exec ${quote(join(nodeHome, "bin", "node"))} ${quote(join(prefix, "server", "src", "cli.ts"))} "$@"`,
  "",
].join("\n"));
chmodSync(launcher, 0o755);
const directory = join(process.env.HOME, ".pi");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const manifest = join(directory, "remote-server.json");
const temporary = `${manifest}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify({ version: 1, agent: "pi", launcher, agentDir, defaultServerDir }) + "\n", { mode: 0o600, flag: "wx" });
renameSync(temporary, manifest);
NODE

cat "$PREFIX/VERSIONS"
echo "installed: $PREFIX/bin/pi-server"
