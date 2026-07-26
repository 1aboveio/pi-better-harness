#!/usr/bin/env bash
# Scenario 6: a subagent survives a parallel `bash` + `read` batch (issue #17).
#
# This is the regression that made subagents unusable. A child that loads every
# installed package can inherit one that replaces builtin `bash` with a
# `detached` + `proc.unref()` spawn. In print mode the in-process `read`
# finishes, the unref'd `bash` does not hold the event loop, Node drains, and the
# child EXITS 0 MID-TURN — no `tool_execution_end` for bash, no `agent_end`.
# Exit 0 is indistinguishable from a clean finish, so it was reported as ✓
# completed. Measured: 30 recorded runs, 17 died this way, all reported success.
#
# A tool allowlist cannot fix it — the package overrode builtin `bash` at startup,
# so the `bash` in the allowlist IS the broken one. What fixes it is not LOADING
# the package: `--no-extensions -e <only what the tools need>`, which run_child
# now builds via the product resolver.
#
# The test proves both halves of the contract in one run:
#   1. every tool_execution_start has a tool_execution_end (nothing drained)
#   2. web_fetch still works, so isolation did not cost us the tools we asked for

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Scenario 6 — headless isolation survives parallel bash+read (#17)"

ID="test_isolation_$$"
WORK="$RUNTIME/isolation_work_$$"
run_child "$ID" "read,bash,edit,write,web_search,web_fetch" \
    "Do these steps in order. Step 1: in ONE single assistant message, issue TWO tool calls IN PARALLEL: bash running \`echo hi\`, and read on /etc/hosts. Step 2: call web_fetch on https://example.com. Then reply with DONE followed by the page's title." \
    "$WORK"
rc=$?

require_finished "headless isolation" "$ID" "$rc"

LOG="$RUNTIME/runs/$ID.log"

# --- 1. no tool call drained mid-flight ------------------------------------
starts=$(grep -c '"type":"tool_execution_start"' "$LOG" 2>/dev/null || echo 0)
ends=$(grep -c '"type":"tool_execution_end"' "$LOG" 2>/dev/null || echo 0)
echo "  tool_execution_start=$starts  tool_execution_end=$ends"

if [ "$starts" -lt 2 ]; then
    echo "  INCOMPLETE: model did not issue the parallel batch (only $starts tool calls)."
    echo "             Re-run, or set PI_SUBAGENT_TEST_MODEL to a model that batches."
    exit 2
fi
if [ "$starts" != "$ends" ]; then
    echo "  FAIL: $((starts - ends)) tool call(s) never finished — the child drained mid-turn."
    echo "        This is the #17 regression: an extension broke process lifetime."
    exit 1
fi
echo "  PASS: every tool_execution_start has a matching end"

# --- 2. a terminal agent event was actually reached ------------------------
# require_finished already checked this; assert explicitly so the contract is
# visible in the test body rather than implied by a helper.
if ! grep -qE '"type":"(agent_settled|agent_end)"' "$LOG"; then
    echo "  FAIL: no terminal agent event — child exited before the turn settled."
    exit 1
fi
echo "  PASS: reached a terminal agent event"

# --- 3. bash actually ran (it is the tool that gets overridden) -------------
if ! grep -q '"toolName":"bash"' "$LOG"; then
    echo "  INCOMPLETE: model never called bash, so the drain path was not exercised."
    exit 2
fi
echo "  PASS: bash ran under the isolated runtime"

# --- 4. isolation did not cost us the extension tool -----------------------
ans="$(final_answer "$ID")"
echo "  --- subagent answer ---"
echo "$ans" | sed 's/^/    /' | head -8
echo "  -----------------------"
[ -z "$ans" ] && { echo "  FAIL: run finished but produced no answer"; exit 1; }

assert_contains "web_fetch still works with only its own extension loaded" "$ans" \
    "example domain"
