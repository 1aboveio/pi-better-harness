#!/usr/bin/env bash
# Regression: the product-selected sandbox wrapper must preserve a pi argv
# token containing an embedded newline as one argument.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib.sh
source "$DIR/lib.sh"

test_banner "sandbox wrapper argv preserves embedded newlines"

ID="sandbox-wrapper-argv-newline-$$-$RANDOM"
WORK="$RUNTIME/$ID-work"
WRAPPER="$RUNTIME/runs/$ID.wrapper"
PROFILE="$RUNTIME/runs/$ID.sb"
PROMPT=$'first prompt line\nsecond prompt line'
PI_BIN="/usr/bin/printf"
PI_ARGS=(--mode json --session-id "$ID" "$PROMPT")

mkdir -p "$WORK" "$RUNTIME/runs"
build_sandbox_command "$PROFILE" "$WORK" "$PI_BIN" "${PI_ARGS[@]}" > "$WRAPPER"

command=()
read_sandbox_command "$WRAPPER"

start=-1
for ((i = 0; i < ${#command[@]}; i++)); do
    if [ "${command[$i]}" = "$PI_BIN" ]; then
        start=$i
        break
    fi
done

if [ "$start" -lt 0 ]; then
    echo "  FAIL: product wrapper omitted pi executable" >&2
    exit 1
fi

for ((i = 0; i < ${#PI_ARGS[@]}; i++)); do
    actual="${command[$((start + i + 1))]:-}"
    if [ "$actual" != "${PI_ARGS[$i]}" ]; then
        printf '  FAIL: pi argv token %d changed during wrapper handoff\n' "$i" >&2
        exit 1
    fi
done

if [ "${#command[@]}" -ne "$((start + ${#PI_ARGS[@]} + 1))" ]; then
    echo "  FAIL: wrapper handoff added or split pi argv tokens" >&2
    exit 1
fi

echo "  PASS: product wrapper preserves every pi argv token, including embedded newline"
