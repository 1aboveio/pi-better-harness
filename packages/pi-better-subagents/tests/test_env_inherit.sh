#!/usr/bin/env bash
# Scenario 3: a subagent inherits the foreground environment — THROUGH the OS
# sandbox. This is the hardening test for the gh/GH_TOKEN class of problem: any
# credential a tool needs (GH_TOKEN, API keys) reaches the subagent via env, so
# keychain-free auth works headlessly.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Scenario 3 — env inheritance through the sandbox"

# A unique marker set in THIS (foreground) shell; the child must see it.
export PI_ENV_MARKER="marker_$$_$(date +%s 2>/dev/null || echo x)"
echo "  marker: $PI_ENV_MARKER"

ID="test_env_$$"
WORK="$RUNTIME/work_$$"
# Sandboxed (writes confined to WORK) — proves env survives the sandbox wrapper.
run_child "$ID" "read,bash" \
    "Using the bash tool, run exactly this command with no extra arguments:\nprintenv PI_ENV_MARKER\nThen put exactly one line in your final answer in this format: SEEN=<the exact value printed by the command>." \
    "$WORK"
rc=$?

require_finished "env inheritance" "$ID" "$rc"

ans="$(final_answer "$ID")"
echo "  --- subagent answer ---"
echo "$ans" | sed 's/^/    /' | head -8
echo "  -----------------------"

# The child must return the exact marker on its own line, not a substring or
# a fabricated value. This proves the foreground environment crossed the OS
# sandbox boundary intact.
seen="$(printf '%s\n' "$ans" | sed -n 's/^[[:space:]]*SEEN=//p' | head -n 1)"
if [ "$seen" != "$PI_ENV_MARKER" ]; then
    echo "  FAIL: expected exact sandboxed marker SEEN=$PI_ENV_MARKER, got $(printf %q "$seen")"
    exit 1
fi
echo "  PASS: subagent inherited the exact foreground env var through the sandbox"
