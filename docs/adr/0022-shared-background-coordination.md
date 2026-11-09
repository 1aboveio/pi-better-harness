# Shared Background coordination and retention

## Status

Accepted decision for [#675](https://github.com/1aboveio/pi-better-harness/issues/675). This decision amends [ADR 0007](0007-trusted-runtime-task-boundary.md), [ADR 0017](0017-background-adapter-admission.md), and [ADR 0020](0020-observed-waits-retain-an-owner.md).

## Decision

Use one on-demand coordinator process per canonical user/state directory, shared by independent Pi processes. Standalone Background Tasks must not depend on pi-better-server. Local IPC uses a fixed short Unix socket under `/tmp/pi-bg-<uid>` or a Windows named pipe, discoverable despite differing `TMPDIR`, `TMP`, `TEMP`, agent environments, or state overrides. Concurrent starters elect one leader using a lifetime SQLite writer lock in a separate election database, not the operation database. The election database resides beside the canonical operation store in a private user and identity directory, not a process temporary directory. This avoids file publication and stale-rename split brain. Verified process identity and fencing prevent stale leaders from acting; bounded retry and backoff avoid spawn storms. Restart, disconnect, reload, and leader failure must allow recovery without losing terminal results or duplicating execution or delivery.

The coordinator owns shared event-driven task discovery, reconciliation, and maintenance. Advisory filesystem watchers observe the operation database and WAL, task creation, and active result and lost files; log changes are filtered. Events feed reconciliation coalesced over 50 ms, and watchers close on shutdown. A centralized bounded safety fallback recovers from lost notifications and crashed runners. SQLite and supervisor evidence remain authoritative; IPC notifications are not evidence of task state. The coordinator sends owner-scoped notifications, not global ticks that wake every client to repeat identical scans.

The supervisor `tasks` namespace is bootstrapped once at coordinator startup. Reconciliation and watcher retries do not recreate a removed namespace; a legitimate new supervisor launch owns its recreation. A missing namespace means evidence is unavailable, not proof that a launch failed.

Durable journal cursors are per owner, with bounded pagination. Journal trimming removes only a contiguous sequence prefix, even if wall clocks move backward. A client outside the replay horizon receives an owner-scoped snapshot and reset.

Transport receipt, completion delivery, evidence acknowledgement, and physical deletion are distinct events. An idle advisory client connection does not keep a CLI or SDK process alive, while an in-flight RPC remains referenced until its response or bounded failure. Sessions retain callback batching, suppression and deferral, owner/session/branch checks, paused Goal behavior, continuation ownership, and duplicate-delivery fences. State synchronization alone never invokes a model. Tool admission, execution permissions, and runtime control protections remain unchanged.

## Retention

Retain the existing daily seven-day legacy metadata cleanup under unified, protection-aware coordinated maintenance; do not add a competing deleter. Durable history cleanup is off by default, configurable, and previewable. The legacy seven-day policy does not silently apply to durable history. UI clear is dismissal, not physical deletion.

Provide eligibility preview and bounded cleanup. Protect unknown, running, nonterminal, and malformed records; pending or claimed callbacks and outbox entries; unconsumed waits; active evidence pins; and required resume or continuation records. Age alone does not establish that a task is dead. Delete only provably owned runtime artifacts, never user live data.

Canonical-store reservations progress from `reserved` to `deleting`, then `files-removed` and `complete`. The durable `deleting` fence is established before filesystem mutation, with a transactional protection recheck, so concurrent claims, waits, and pins cannot race cleanup. Recovery releases only untouched `reserved` entries; it resumes known deletion or leaves uncertain deletion fenced. A deletion-unknown reservation stays held. Completed tombstones prevent identity resurrection. Preserve references and recover incomplete deletion safely.

## Trade-offs and transition

Per-process timers multiply registry scans with session count. Broadcasting shared clock ticks still wakes every client to scan and does not solve that problem. A shared process adds lifecycle, IPC, election, and recovery complexity in exchange for centralized work and targeted delivery.

The additive v1 schema preserves existing record layout and readability. Insert triggers make old clients fail closed when admitting protected references; this is not transparent old-client semantics or performance. All running Pi instances must update or reload to benefit from removal of old per-session loops: the new coordinator does not silence old plugin binaries. No user session is automatically killed or reconfigured. Compatibility and migration still require verification.

## Verification contract

Use disposable fixtures, never destructive cleanup of a live registry. Test 17 independent idle clients and a large terminal history for bounded shared scans; measure actual reconcile and database accesses before and after. Exercise owner-only completion delivery, no model wake for synchronization, concurrent startup, reconnect, reload, dropped notifications, leader failure, and existing ownership and acknowledgement regressions. Test bounded preview and deletion, all protections, concurrent protection changes, and interrupted cleanup. Verify supported platform IPC and identity fencing, migration, package checks, and required CI. These are requirements, not claims of completed tests or CPU improvement.
