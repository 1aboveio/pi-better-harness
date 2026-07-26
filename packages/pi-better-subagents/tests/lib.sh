#!/usr/bin/env bash
# Shared helpers for pi-better-subagents integration tests.
#
# These run the SAME child invocation `subagent_spawn` builds in index.ts
# (pi -p --mode json, tool allowlist, subagent-tool denylist, positional
# prompt), then parse the result the SAME way parse.ts does. They exercise the
# real subagent execution path — a tool-scoped child doing real work — without
# depending on a foreground LLM to place the tool call. The extension's
# spawn/registry/parse/callback/sandbox plumbing is verified separately.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${TMPDIR:-/tmp}/pi-better-subagents-tests"
SESS="$RUNTIME/sessions"

# Overridable knobs.
CHILD_MODEL="${PI_SUBAGENT_TEST_MODEL:-minimax-cn/MiniMax-M3}"
TEST_TIMEOUT="${PI_SUBAGENT_TEST_TIMEOUT:-300}"

mkdir -p "$SESS"

# ext_args TOOLS [MODEL]
#   Prints the `--no-extensions -e <path> ...` flags index.ts would build for
#   this tool allowlist, computed by the SAME resolver the extension uses
#   (extensions.mjs + config.json) so tests can never drift from the product.
#
#   This isolation is load-bearing, not cosmetic: a child that loads every
#   installed package can inherit one that overrides builtin `bash` with an
#   unref'd detached spawn, which drains the event loop and exits 0 mid-turn.
#   See test_headless_isolation.sh and the README.
ext_args() {
    REPO_DIR="$REPO_DIR" node -e '
        const [tools, model] = process.argv.slice(1);
        const { readFileSync, existsSync } = require("node:fs");
        const { homedir } = require("node:os");
        const { join } = require("node:path");
        const repo = process.env.REPO_DIR;
        import(join(repo, "extensions.mjs")).then(({ resolveExtensions, extensionArgs }) => {
            let cfg = {};
            try { cfg = JSON.parse(readFileSync(join(repo, "config.json"), "utf-8")); } catch {}
            const r = resolveExtensions({ tools, model: model || undefined, config: cfg });
            const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
            const { args, missing } = extensionArgs(r, (spec) => {
                if (spec === "self") return repo;
                const p = spec.startsWith("npm:")
                    ? join(agentDir, "npm", "node_modules", spec.slice(4)) : spec;
                return existsSync(p) ? p : undefined;
            });
            if (missing.length) { console.error("missing extensions: " + missing.join(", ")); process.exit(1); }
            console.log(args.join("\n"));
        });
    ' "$1" "${2:-}"
}

# require_macos_sandbox
#   Exit 0 with SKIP on non-macOS / missing sandbox-exec. Security tests that
#   need kernel confinement call this first (macOS-only for now; see issue #5).
require_macos_sandbox() {
    if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/sandbox-exec ]; then
        echo "  SKIP: OS write-sandbox tests require macOS sandbox-exec (see issue #5 for Linux)."
        exit 0
    fi
}

# _write_sandbox_profile FILE WRITABLE_DIR
#   Mirrors sandbox.ts: reads/network open, writes confined to WRITABLE_DIR plus
#   the system paths pi needs. Keep in sync with sandbox.ts.
_write_sandbox_profile() {
    local file="$1" raw="$2" dir
    mkdir -p "$raw" "$(dirname "$file")"
    # Match sandbox.ts realpathSync: sandbox-exec evaluates canonical paths
    # (/tmp → /private/tmp on macOS).
    dir="$(cd "$raw" 2>/dev/null && pwd -P || echo "$raw")"
    cat > "$file" <<EOF
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "$dir"))
(allow file-write* (subpath "$HOME/.pi"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/dev"))
EOF
}

# run_sandboxed_bash SANDBOX_DIR BASH_SCRIPT
#   Runs `bash -c SCRIPT` under the SAME sandbox-exec profile subagent children
#   use (via run_child SANDBOX_DIR / extension sandbox.ts). cwd is SANDBOX_DIR.
#   No model involved — deterministic confinement checks. Prints script stdout.
#   Returns the sandboxed bash exit code.
run_sandboxed_bash() {
    local sbxdir="$1" script="$2"
    local prof rc
    mkdir -p "$RUNTIME/runs" "$sbxdir"
    prof="$RUNTIME/runs/sbx_bash_$$_$RANDOM.sb"
    _write_sandbox_profile "$prof" "$sbxdir"
    # Use the resolved writable root as cwd (same as run_child).
    local runcwd; runcwd="$(cd "$sbxdir" && pwd -P)"
    ( cd "$runcwd" && /usr/bin/sandbox-exec -f "$prof" /bin/bash -c "$script" )
}

# build_sandbox_command PROFILE WRITABLE_DIR PI_BIN PI_ARG...
#   Emits the exact product-selected command and argv as a JSON array. JSON
#   preserves embedded newlines in individual argv tokens.
#   Calling sandbox.ts directly keeps Linux bubblewrap test execution coupled to
#   the same backend selection and wrapper construction that subagent_spawn uses.
build_sandbox_command() {
    local profile="$1" writable_dir="$2" pi_bin="$3"
    shift 3
    REPO_DIR="$REPO_DIR" node --experimental-strip-types --input-type=module -e '
        import { join } from "node:path";
        import { pathToFileURL } from "node:url";
        const [profilePath, writableDir, home, piBin, ...piArgs] = process.argv.slice(1);
        const { maybeBuildSandboxCommand } = await import(
            pathToFileURL(join(process.env.REPO_DIR, "sandbox.ts")).href,
        );
        const command = maybeBuildSandboxCommand({
            profilePath,
            writableDir,
            home,
            piBin,
            piArgs,
        }, { sandboxEnabled: true, explicitSandbox: true });
        if (!command) throw new Error("sandbox backend did not produce a wrapper command");
        process.stdout.write(JSON.stringify([command.file, ...command.fileArgs]));
    ' "$profile" "$writable_dir" "$HOME" "$pi_bin" "$@"
}

# read_sandbox_command FILE
#   Rebuilds the command array emitted by build_sandbox_command without using
#   newline as an argv delimiter. POSIX argv cannot contain NUL, so it is safe
#   as the decoded record separator for Bash.
read_sandbox_command() {
    local wrapper="$1" decoded="$1.argv" arg
    # shellcheck disable=SC2016 # Node expands the template literal, not Bash.
    if ! node -e '
        const input = require("node:fs").readFileSync(0, "utf8");
        let argv;
        try {
            argv = JSON.parse(input);
            if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
                throw new Error("expected an array of NUL-free strings");
            }
        } catch (error) {
            console.error(`invalid sandbox command transport: ${error.message}`);
            process.exit(1);
        }
        for (const arg of argv) process.stdout.write(`${arg}\0`);
    ' < "$wrapper" > "$decoded"; then
        rm -f "$decoded"
        return 1
    fi

    command=()
    while IFS= read -r -d '' arg; do command+=("$arg"); done < "$decoded"
    rm -f "$decoded"
}

# run_child ID TOOLS PROMPT [SANDBOX_DIR]
#   Runs the child as the extension does and writes the JSON stream to
#   $RUNTIME/runs/ID.log. With SANDBOX_DIR set, uses the product-selected OS
#   sandbox command (sandbox-exec on macOS, bubblewrap on Linux) and runs in the
#   confined directory. Returns exit code (124 on timeout).
run_child() {
    local id="$1" tools="$2" prompt="$3" sbxdir="${4:-}"
    local log="$RUNTIME/runs/$id.log"
    mkdir -p "$RUNTIME/runs"

    local runcwd="$SESS"
    if [ -n "$sbxdir" ]; then
        mkdir -p "$sbxdir"
        runcwd="$sbxdir"
    fi

    # Load only the extensions backing these tools, exactly as index.ts does.
    # No --exclude-tools for the subagent tools: this package isn't loaded in the
    # child at all, so recursion is prevented by absence rather than by denial.
    local -a ext=()
    while IFS= read -r line; do [ -n "$line" ] && ext+=("$line"); done < <(
        REPO_DIR="$REPO_DIR" ext_args "$tools" "$CHILD_MODEL"
    )

    local pi_bin
    pi_bin="$(command -v pi)" || {
        echo "  FAIL: pi CLI is unavailable" >&2
        return 1
    }
    local -a pi_args=(
        -p --mode json
        --session-dir "$SESS" --session-id "$id"
    )
    pi_args+=("${ext[@]}")
    pi_args+=(--model "$CHILD_MODEL" --tools "$tools" "$prompt")

    local -a command=("$pi_bin" "${pi_args[@]}")
    if [ -n "$sbxdir" ]; then
        local wrapper="$RUNTIME/runs/$id.wrapper"
        if ! build_sandbox_command "$RUNTIME/runs/$id.sb" "$sbxdir" "$pi_bin" "${pi_args[@]}" > "$wrapper"; then
            echo "  FAIL: product sandbox command construction failed" >&2
            return 1
        fi
        if ! read_sandbox_command "$wrapper"; then
            echo "  FAIL: product sandbox command reconstruction failed" >&2
            return 1
        fi
        if [ "${#command[@]}" -eq 0 ]; then
            echo "  FAIL: product sandbox command was empty" >&2
            return 1
        fi
    fi

    # A portable timeout wrapper (macOS has no `timeout`): background + watchdog.
    # stdin MUST be closed (< /dev/null): `--mode json` otherwise waits on stdin
    # forever. The extension spawns children with stdin "ignore" for this reason.
    ( cd "$runcwd" && "${command[@]}" < /dev/null ) > "$log" 2>&1 &
    local pid=$!
    local waited=0
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$waited" -ge "$TEST_TIMEOUT" ]; then
            # Kill the whole run, not just the subshell: pi spawns detached
            # children (and a sandbox-exec wrapper) that would otherwise orphan
            # and pile up. The run id is unique, so pkill on it is safe.
            kill -TERM "$pid" 2>/dev/null
            pkill -f "$id" 2>/dev/null
            sleep 1
            kill -KILL "$pid" 2>/dev/null; pkill -9 -f "$id" 2>/dev/null
            return 124
        fi
        sleep 2; waited=$((waited + 2))
    done
    wait "$pid"
}

# final_answer ID  ->  prints the child's parsed final answer (mirrors parse.ts)
final_answer() {
    python3 - "$RUNTIME/runs/$1.log" <<'PY'
import json, sys
final = last = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    s = line.strip()
    if not s or s[0] != "{":
        continue
    try:
        e = json.loads(s)
    except Exception:
        continue
    t = e.get("type")
    def text(m):
        c = (m or {}).get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "".join(b.get("text", "") for b in c
                            if isinstance(b, dict) and b.get("type") == "text").strip()
        return ""
    if t == "agent_end":
        for m in reversed(e.get("messages", [])):
            if m.get("role") == "assistant" and text(m):
                final = text(m); break
    if t == "message_end":
        m = e.get("message", {})
        if m.get("role") == "assistant" and text(m):
            last = text(m)
print(final or last)
PY
}

# run_finished ID  ->  0 if the child reached a terminal event, 1 if cut off.
run_finished() {
    grep -qE '"type":"(agent_settled|agent_end)"' "$RUNTIME/runs/$1.log" 2>/dev/null
}

# require_finished LABEL ID RC  ->  prints INCOMPLETE and exits 2 if the run
# didn't finish (timeout/flake), so a cut-off run is never reported as a wrong
# answer. Returns 0 when the run completed.
require_finished() {
    local label="$1" id="$2" rc="$3"
    if [ "$rc" = 124 ] || ! run_finished "$id"; then
        echo "  INCOMPLETE: '$label' did not finish within ${TEST_TIMEOUT}s (model latency)."
        echo "             Re-run, or raise PI_SUBAGENT_TEST_TIMEOUT / set PI_SUBAGENT_TEST_MODEL."
        exit 2
    fi
}

# assert_contains LABEL TEXT PATTERN...  (all patterns must match, case-insensitive)
assert_contains() {
    local label="$1"; shift
    local text="$1"; shift
    local ok=1 pat
    for pat in "$@"; do
        if ! grep -qiE "$pat" <<<"$text"; then
            ok=0; echo "    ✗ expected to match: /$pat/"
        fi
    done
    if [ "$ok" = 1 ]; then echo "  PASS: $label"; return 0
    else echo "  FAIL: $label"; return 1; fi
}

test_banner() { echo; echo "=== $* ==="; echo "  model: $CHILD_MODEL  timeout: ${TEST_TIMEOUT}s"; }
