# Incremental Log Coverage

`runtime-incremental-log.test.ts` uses the real socket server and private Node
fixture. A session with 96 logs exceeds the legacy 64-entry parser working set.
After one append, it asserts one log/display projection, one health projection,
zero assignment/failure projections, one physical cursor read, appended bytes
plus a 256-byte identity check, two decoded events and two events in each fold.
The other 95 source revisions remain unchanged. Both the conversation subscriber
and active consumer receive the update. Diagnostics retain before/after counters.

`runtime-work.test.ts` exercises registered Navigator updates after an append,
result/list tools, wait/outcome changes, lineage and archive replacement, and
60 real list/detail draws with zero filesystem calls. Failure-journal attention
is covered there and by `runtime-terminal-failure-fold.test.ts` through an offline
recipient session and the real shared manager.

Display accumulates usage from every completed message it observes. A cold read
or append exceeding `PI_SUBAGENT_MAX_LOG_PARSE_BYTES` skips a prefix and reports
the existing truncation diagnostic: the subtotal must not be called complete.
Health uses its independent `PI_SUBAGENT_MAX_HEALTH_READ_BYTES` limit and reports
`rawLog.windowTruncated` when bytes were skipped. It retains structural facts,
bounded error history and open tools, not a rolling list of source events. Each
completed relevant event folds once, with no repeated traversal of old events.
The independent readers share overlapping bytes and JSON decoding in a synchronous
projection batch even when their limits differ.

`health_observation.test.mjs`, `parse_run.test.mjs`, and `log_cursor.test.mjs`
cover truncation, rewrite, cold bounds, tool pairing, retry recovery and skipped
noise. The socket test covers a complete unterminated usage event followed by its
newline and settlement: speculative display does not double bill, and health
does not commit half-lines. Per-model parser states survive unrelated tasks and
are removed with source membership. Persistence and eviction recovery belong to
unit 801; inventory scheduling and query scope versions remain unchanged here.
