# Goal admission scheduler fan-out (#785)

## Behavior

Goal shares an in-flight scheduler query for equivalent admissions in one extension
instance, owner/session/execution revision, bound workflow run and timeout contract.
Success, failure and timeout remove the pending entry. A later request starts a fresh
query. Completion and live `--sync` queries retain their separate execution path.

The scheduler script, task plan, issue tree, seen bookkeeping, review files and result
files are checked before and after the query. Binding changes, including rebinding the
same plan, also invalidate the evidence. The dispatcher capability checks these inputs
again immediately before execution. Existing Goal, preference and execution fences
still reject a pause, session switch, workflow change, agent start or shutdown.

Input checks inspect run metadata and do not walk worker workspaces. Workspace activity
is read by the one scheduler process. Its activity scan affects worker diagnostics;
the admission hold uses the scheduler's retry heartbeat, whose inputs are in the run.

## Regression proof

Before the change, both the gate test and the real extension event-handler test failed:

```text
16 !== 1
```

After the change, all 249 Goal tests and its typecheck passed. The new tests cover
16 overlapping candidates, fresh evidence after settlement, changed run inputs,
scope/revision/run/timeout isolation, failure and timeout retry, child exit,
same-path rebinding, and lifecycle changes while admission is pending.

```sh
npm run verify --workspace pi-better-goal
node --import tsx scripts/performance/goal-admission-stress.mjs
```

The workspace declares Pi 0.84.4. The existing shared dependency tree and root lock
contained Pi 0.82.1, which lacks APIs already used on main. Verification used a
temporary package-local install of Pi 0.84.4 without changing repository dependencies.

## Real scheduler measurements

Measured on macOS, Node 24.21.0, on 2026-11-15. Each run submits 16 overlapping
admissions to the real gate. Four busy plan units reference a private workspace with
5,000 files. No worker or model is launched and no existing workflow is modified.

This table uses the installed `resolve-issues/scripts/next-actions.mjs` that was
observed in the live CPU bursts. Before and after use the same scheduler and fixture.

| Measurement | Before | After |
| --- | ---: | ---: |
| Scheduler processes / peak concurrent children | 16 / 16 | 1 / 1 |
| Child `statSync` calls | 320,128 | 20,008 |
| Child `readdirSync` calls | 1,344 | 84 |
| Child `readFileSync` calls | 192 | 12 |
| Caller CPU | 37.859 ms | 19.058 ms |
| Aggregate scheduler CPU | 7,409.442 ms | 140.944 ms |
| Caller + scheduler CPU | 7,447.301 ms | 160.002 ms |
| Wall time | 682.581 ms | 138.806 ms |
| Maximum caller event-loop timer lag | 10.554 ms | 2.138 ms |

These are observations from one measured pair, not timing thresholds. The process
and filesystem counts establish that overlapping candidates no longer multiply
workspace traversal. The harness records caller CPU separately from child CPU;
it exercises the gate in a Node caller, not a complete interactive Pi process.

The checked-in scheduler fixture independently reproduced 16 -> 1 processes and
320,128 -> 20,008 child stats. The harness defaults to that fixture for repeatability.
Use `--scheduler /path/to/resolve-issues/scripts/next-actions.mjs` for another build.

To compare against the unmodified gate:

```sh
git worktree add --detach /tmp/pi-before-785 3e44ce33434167df0d7b40f75ccf358144a85915
node --import tsx scripts/performance/goal-admission-stress.mjs \
  --baseline --gate /tmp/pi-before-785/packages/pi-better-goal/src/workflow-gates.ts
node --import tsx scripts/performance/goal-admission-stress.mjs
```

Set `PI_PERF_REPORT` to a report path to retain the JSON measurements.

## Unified runtime migration (#751)

This guard belongs to one Pi extension instance. Independent Pi processes retain
independent checks. Slices #754/#762/#765 must preserve this regression when moving
admission evidence into the unified runtime and prove the shared budget with real
1/5/10 Pi clients. That matrix must include scheduler children in aggregate CPU,
process, I/O and event-loop measurements. This fix creates no daemon or execution
authority and does not establish the cross-process budget.
