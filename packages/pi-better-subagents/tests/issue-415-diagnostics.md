# Issue #415 Diagnostics Verification

Scope: diagnostics only. Read ADR 0006, 0007, 0009, test-quality, the subagent
context, and the goal worker's diagnosis. No commits, real credentials, cloud
calls, real process census, Android actions, permission changes, or auto-launches.
Goal canonical source, tests, and docs belong to the goal worker; the sync script
only generates its shared permission contract.

## Implemented Contract

Canonical pure validator: `packages/failure-observations/permission-blocker.ts`.
Exports `PermissionBlocker`, `PermissionResource`, `PERMISSION_RESOURCES`,
`isPermissionResource`, `isPermissionBlocker`, and `permissionBlockerKey`.
The sync script generates copies for subagents, sandbox, background tasks (the
existing failure-observation consumer), and goal. Goal imports the `.js` specifier.

`failure_disposition` accepts `permissionResource` only for `open`. Child validation
and trusted parent replay bind reports to real unresolved failed tool incidents.
The adapter supplies hashed operation identity, incident identity, and worker
context; parent replay additionally supplies the run id. Basis is always
`agent-reported`, remote outcome always `unknown`, and no policy snapshot is claimed.
Untrusted runs, unknown resources/targets, closed incidents, forged runtime fields,
and malformed metadata cannot produce actionable blockers.

Append-only disposition events, reduced observations, and closed history retain
metadata. Successful later retries retain the original report but remove it from
active result details. Error execution and existing expectedness, actionability,
recovery, delivery, and lifecycle semantics remain separate.

Actual `subagent_result` and `subagent_output` handlers expose actionable
`details.permissionBlockers`. Metadata is bounded to 32 reports and a separate
allowance of at most 4096 bytes (also bounded by the requested surface budget).
`permissionBlockersOmitted` accounts for reports not fitting that allowance.
Existing content budgets/cursors remain intact. Contextual failure rows precede
progress and use only resource enums, not the report's free-form reason, raw
command, or evidence path. They do not infer foreground denial, remote
authorization, or successful validation. Worker policy remains immutable.

## Red Before Green

The new contract test initially failed because the module was absent. The adapter
tests then failed on absent permission metadata and acceptance of forged claims.
Further regressions failed on unchanged poll/cursor revisions and a duplicate
permission disposition being mistaken for a journal gap. All are now green.

## Verified

- `node --import tsx --test packages/failure-observations/*.test.ts`: 50 passed.
- Subagent `permission_blockers`, `failures`, `subagent_output_budget`, and
  `subagent_result_display` suites with the isolated registry: 79 passed.
- Task-sandbox `process-list` and `index` suites, excluding `real selected kernel`:
  50 passed. All inventory/helper execution in that selection is synthetic.
- Sandbox `permission-settings`, `status`, `policy`, and `state` suites: 34 passed.
- All four package typechecks passed. Subagents uses its existing task-runtime
  typecheck scope.
- Shared sync run; `scripts/sync-shared-log-utils.test.mjs`: 7 passed, including
  goal's `.js` import and the other generated consumers. Total: 220 focused tests.
- `git diff --check`: passed. Test-quality lint: zero gates; the only lead is in
  goal-owned tests, outside this diagnostics change.

## Limits And Handoff

Guarded preflight blocker production is deliberately deferred. Installed Pi SDK
0.82.1's dispatcher `prepareToolCall` and `executePreparedToolCall` turn blocked
calls and thrown errors into `isError: true` plus `createErrorToolResult`, whose
details are empty. Returning a normal result from `execute` is classified as
success. Error details plus parent authenticity were not established for this
path; no stdout markers or text pattern matching were added to work around it.
No report is promoted to `policy-refusal`, `os-permission-error`, or remote
`not-started` merely because output mentions EPERM.

Synthetic tests cover credential-cache and process-inspection reports, strict
validation, trusted replay, untrusted/forged claims, active metadata and budgets,
retry history, cursor invalidation, duplicate delivery, and preservation of
execution errors. They do not prove kernel refusal transport or end-to-end goal
resume behavior. Goal owns confirmation for one same-scope retry via `/goal resume`;
changing settings alone does not resume work, and workers need a fresh launch.

## Reviewer Finding Fixes

Read test-quality and ADR 0006, with ADR 0012 and the subagent context as the
existing contract. No commits. Parent-authored ADR 0012, subagent documentation,
and goal canonical implementation remain untouched. Generated copies were
updated only through `node scripts/sync-shared-log-utils.mjs`.

Changes in this follow-up:

- `packages/failure-observations/permission-blocker.ts`: incident references admit
  bounded Responses SDK `tool:call_id|item_id` identifiers (at most 200 characters).
  Logical operation, run, and policy identities are not widened; path separators,
  whitespace, control characters, and oversized incident references are rejected.
- `packages/pi-better-subagents/child-incidents.ts` and `incident-model.ts`:
  optional `permissionResource` and `evidence` accept null as absent in both the
  tool schema and raw log replay. Recovered/superseded still require actual
  successful later evidence, and non-open permission declarations remain invalid.
- `packages/failure-observations/index.ts`: permission context is additive to full
  evidence rows, retaining the summary, occurrence count, reason, incident evidence,
  and disposition evidence. Compact permission rows do not expose raw summary,
  reason, or evidence. Fresh-launch instructions appear only when action is needed
  and describe changed settings, not an unconditional launch requirement.
- `packages/pi-better-subagents/tools.ts`: if even the omitted-only permission
  envelope cannot fit, the read fails explicitly with a larger-`max_bytes` retry
  instruction. Fitting envelopes retain exact omitted counts. Tiny reads with no
  actionable blockers retain their previous behavior.
- Focused tests in `permission-blocker.test.ts`, `permission_blockers.test.mjs`,
  `scripts/failure-observations-contract.test.mjs`, and
  `scripts/sync-shared-log-utils.test.mjs`. The canonical/vendored equality test
  now accounts for the sync script's existing permission-contract import rewrite.

### Repro And Results

Before the fixes, the new tests failed on SDK-shaped incident rejection, the
missing occurrence count in permission rows, SDK rejection of `evidence: null`,
and the absence of a tiny-budget refusal. After the fixes, all regressions pass,
including raw-vs-SDK optional-null replay, ordinary open/expected/superseded
dispositions, missing recovery evidence rejection, full-history tool cursors,
recovered compact privacy, and budgets of 1, minimum-minus-one, the exact minimum,
minimum-plus-one, 128, 512, 1024, and 4096 bytes.

- `node --import tsx --test packages/failure-observations/*.test.ts`: 52 passed.
- `node --import tsx --import ./scripts/isolate-registry.mjs --test` with subagent
  `permission_blockers`, `failures`, `health_result_diagnostics`,
  `subagent_output_budget`, `subagent_result_display`, and `tool_schema_compat`,
  plus `scripts/failure-observations-contract.test.mjs` and
  `scripts/sync-shared-log-utils.test.mjs`: 99 passed. No skips in either run.
- `npm run typecheck` for failure-observations, subagents, background tasks,
  sandbox, and goal: all passed. Subagents retains its task-runtime typecheck scope.
- Test-quality lint against `HEAD`: zero gates. Three leads: generated-source
  equality (intentional synchronization assertion) and two checks in goal-owned
  tests, which are left to the independent Reviewer.
- `git diff --check`: passed.

### Parent Handoff And Limits

The existing `permissionBlockers` / `permissionBlockersOmitted` wire fields are
unchanged. Goal's current consumer handles omitted scope through
`reportedPermissionGap`; an empty report list with a positive omitted count must
not mean all known. The only read contract change is an explicit tool failure
below the minimum metadata envelope size. Because the installed SDK does not
preserve details on thrown errors, such a call cannot itself convey a structured
goal hold: the caller must retry with a larger budget. No actionable report is
silently discarded as an empty successful read.

All permission failures and provider ids used here are synthetic. No real cloud,
credential access, process census, Android action, permission change, or worker
launch was performed. This follow-up does not prove live provider transport,
kernel refusal metadata, or the goal release journey; the independent goal
Reviewer retains that scope.
