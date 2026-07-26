#!/usr/bin/env bash
# Scenario: sandboxed subagent children cannot write outside sandbox_dir.
#
# Kernel-enforced: under the same sandbox-exec profile as subagent_spawn /
# run_child (mirrors sandbox.ts), creating a file OUTSIDE the writable root
# must fail, and the file must not appear on disk.
#
# Important: the profile also allows $HOME/.pi, /private/var/folders, and
# /private/tmp (pi needs them). The "outside" probe must NOT sit under those
# paths — $TMPDIR on macOS is under /private/var/folders and would false-pass.
# We use a directory directly under $HOME instead.
#
# Deterministic — no model call. macOS only; skips elsewhere until issue #5.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Sandbox deny — cannot write outside sandbox_dir"

require_macos_sandbox

ID="test_sbx_out_$$"
# Writable jail for the sandboxed process (under RUNTIME is fine — that's the
# intended sandbox_dir, and /private/var/folders is also globally allowed, but
# the jail is still the confined "work" root for inside positive control).
WORK="$RUNTIME/sbx_work_$ID"

# Outside probe: MUST be outside every allow-subpath in sandbox.ts:
#   sandbox_dir, $HOME/.pi, /private/var/folders, /private/tmp, /dev
OUTSIDE_DIR="$HOME/pi-better-subagents-sbx-deny-$ID"
OUTSIDE_FILE="$OUTSIDE_DIR/should_not_exist.txt"
MARKER="outside_leak_${ID}"

cleanup() {
    rm -rf "$WORK" "$OUTSIDE_DIR"
}
trap cleanup EXIT

rm -rf "$WORK" "$OUTSIDE_DIR"
mkdir -p "$WORK" "$OUTSIDE_DIR"

# Sanity: outside path is not under an always-allowed prefix.
OUTSIDE_ABS="$(cd "$OUTSIDE_DIR" && pwd -P)/should_not_exist.txt"
case "$OUTSIDE_ABS" in
    /private/var/folders/*|/var/folders/*|/private/tmp/*|/tmp/*|"$HOME/.pi"/*)
        echo "  FAIL: outside probe path sits under a profile-allowed prefix: $OUTSIDE_ABS"
        exit 1
        ;;
esac

# Precondition: outside path is writable without the sandbox.
if ! echo "probe" > "$OUTSIDE_DIR/.probe" 2>/dev/null; then
    echo "  FAIL: pretest — cannot write to outside dir without sandbox ($OUTSIDE_DIR)"
    exit 1
fi
rm -f "$OUTSIDE_DIR/.probe" "$OUTSIDE_FILE"

# Under the subagent sandbox, attempt write to absolute path outside WORK.
set +e
out="$(run_sandboxed_bash "$WORK" "echo $MARKER > \"$OUTSIDE_ABS\" 2>/tmp/sbx_err_$$; echo EXIT:\$?; cat /tmp/sbx_err_$$ 2>/dev/null; rm -f /tmp/sbx_err_$$" 2>&1)"
rc=$?
set -e

echo "  outside_abs: $OUTSIDE_ABS"
echo "  --- sandboxed outside-write output ---"
echo "$out" | sed 's/^/    /' | head -30
echo "  --------------------------------------"

# The write must not succeed: file must be absent (kernel deny).
if [ -f "$OUTSIDE_FILE" ] || [ -f "$OUTSIDE_ABS" ]; then
    echo "  FAIL: file was created outside sandbox_dir: $OUTSIDE_ABS"
    echo "  content: $(cat "$OUTSIDE_ABS" 2>/dev/null | head -c 200)"
    exit 1
fi
echo "  PASS: no file created outside sandbox_dir"

# Prefer seeing a non-zero exit from the redirect (EXIT:n with n!=0). File
# absence is still authoritative if EXIT line is missing.
if echo "$out" | grep -qE 'EXIT:0'; then
    echo "  FAIL: sandboxed write to outside path reported EXIT:0 (should be denied)"
    exit 1
fi
if echo "$out" | grep -qE 'EXIT:[1-9]'; then
    echo "  PASS: sandboxed outside write returned non-zero exit"
else
    echo "  PASS: outside file absent (exit code line not required)"
fi

# Positive control: inside write still works (sandbox not accidentally deny-all).
INSIDE="$WORK/still_allowed.txt"
set +e
in_out="$(run_sandboxed_bash "$WORK" "echo still_ok > still_allowed.txt && cat still_allowed.txt" 2>&1)"
in_rc=$?
set -e
if [ "$in_rc" -ne 0 ] || [ ! -f "$INSIDE" ]; then
    echo "  FAIL: positive control — write inside sandbox_dir failed after outside deny check"
    echo "  --- output ---"; echo "$in_out" | sed 's/^/    /'
    exit 1
fi
echo "  PASS: writes inside sandbox_dir still succeed (not deny-all)"

echo "  OK: sandbox denies writes outside sandbox_dir"
exit 0
