#!/usr/bin/env bash
# Scenario 1: a subagent uses web_fetch to fetch a page and count its words.
# Proves an extension-provided tool (web_fetch) works inside a tool-scoped child.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Scenario 1 — web_fetch word count (github.com/1aboveio/pi-better-subagents)"

ID="test_webfetch_$$"
WORK="$RUNTIME/webfetch_work_$$"
run_child "$ID" "read,bash,web_fetch,web_search" \
    "Fetch http://github.com/1aboveio/pi-better-subagents using the web_fetch tool. The tool returns the page's text directly to you. From that text, give your best count of the total number of words, plus one sentence about what the page is. Put the word count as a number in your final message. Do NOT run any shell or python commands to count — answer directly from the fetched text." \
    "$WORK"
rc=$?

require_finished "web_fetch word count" "$ID" "$rc"

ans="$(final_answer "$ID")"
echo "  --- subagent answer ---"
echo "$ans" | sed 's/^/    /' | head -12
echo "  -----------------------"
[ -z "$ans" ] && { echo "  FAIL: run finished but produced no answer"; exit 1; }

# A real fetch+count yields a multi-digit word count, and the page is this repo.
assert_contains "fetched page and produced a word count" "$ans" \
    "[0-9]{2,}" "subagent|pi-better|foreground|github|1aboveio"
