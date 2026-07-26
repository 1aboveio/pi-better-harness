#!/usr/bin/env bash
# Run all pi-better-subagents integration tests; summarize PASS/FAIL.
#
# Usage:
#   tests/run_all.sh
#   PI_SUBAGENT_TEST_MODEL=minimax-cn/MiniMax-M3 tests/run_all.sh
#   PI_SUBAGENT_TEST_TIMEOUT=300 tests/run_all.sh
#
# Note: these make real model calls and hit the network (and require `gh` auth),
# so they are slow and can flake on model latency. They are smoke tests, not CI.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tests=(
    "$DIR/test_sandbox_applied.sh"
    "$DIR/test_sandbox_deny_outside.sh"
    "$DIR/test_web_fetch.sh"
    "$DIR/test_gh_issues.sh"
    "$DIR/test_env_inherit.sh"
    "$DIR/test_headless_isolation.sh"
)
declare -a results
fail=0

for t in "${tests[@]}"; do
    bash "$t"
    rc=$?
    name="$(basename "$t")"
    case "$rc" in
        0) results+=("PASS        $name") ;;
        2) results+=("INCOMPLETE  $name  (flake — re-run)"); fail=1 ;;
        *) results+=("FAIL        $name"); fail=1 ;;
    esac
    # Breathe between tests so back-to-back model calls don't rate-limit.
    sleep 10
done

echo
echo "======== summary ========"
printf '%s\n' "${results[@]}"
echo "========================="
exit "$fail"
