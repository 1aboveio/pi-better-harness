# Issue #415 Goal Implementation

## Ownership

Manual edits are limited to `packages/pi-better-goal/**`; no commits were made.
The canonical permission contract and generated
`src/shared-permission-blocker.ts` came from the diagnostics worker, not this
implementation. Failure observations, subagents, sandbox, and sync scripts were
not edited by this worker. No cloud calls, real credentials, process inventory,
or Android operations were performed.

Read the original `test/issue-415-diagnosis.md`, ADR 0006/0007/0009, and the
test-quality skill and its principles/lint references before implementation.

## Changes

- `src/permission-hold.ts`: consumes the shared validator/key helper, validates
  bounded parent-produced structured reports, and replays independent append-only
  blocker/release/consumption/gap records. The logical key excludes incidental
  worker, policy, incident references and remote uncertainty, while preserving
  context, resource, operation, and runtime versus agent-reported basis.
- `src/index.ts`: actual `tool_result` handler adopts actionable worker reports
  from the registered canonical subagent entry, not arbitrary tool names or
  prose. Pauses with `permission-blocker`, invalidates pending timers/audits, and
  preserves the hold across conversation, background drains, settings, workflow
  prompts, interrupts, and reload. Human command/hotkey releases one retry;
  model `goal_resume` remains interrupt-only. Resume never resets this history.
- `src/types.ts`, `src/goal-state.ts`: persist and reconstruct the pause reason.
- `src/continuation.ts`: assistant rewording does not change an observable-action
  fingerprint. Assistant-only turns retain their existing text identity.
- `test/extension.test.ts`: focused handler tests, existing repro refinement,
  and generic retry-budget regression coverage.
- `docs/usage.md`: structured adoption, authority history, scope limits, and
  enforcement limitations.

## Repro Refinement

The original diagnosis file remains unchanged. Both original issue-415 test
scenarios remain: rephrasing unchanged denials, and replay followed by an
ordinary question or unrelated background completion. They now exercise the
specified `tool_result.details.permissionBlockers` contract through the actual
registered handler. An actionable parent report holds immediately rather than
waiting for the generic ten-retry threshold; assertions now check paused state
and `pauseReason`, not a generic active-goal retry hold.

The original synthetic read/process error messages remain fixtures, never
executed commands. A separate prose-only regression preserves the original
eleven-turn reproduction and proves that summary rewording cannot refill the
generic ten-retry budget. Existing generic input/background resets still pass.

## Verification

Run from repository root, without source-syncing lifecycle scripts:

```sh
npm --ignore-scripts run verify -w packages/pi-better-goal
node --import tsx --import ./scripts/isolate-registry.mjs --test --test-name-pattern='issue #415' packages/pi-better-goal/test/extension.test.ts
node /Users/exoulster/.pi/agent/skills/test-quality/scripts/lint-tests.mjs --files packages/pi-better-goal/test/extension.test.ts,packages/pi-better-goal/test/continuation.test.ts
git diff --check -- packages/pi-better-goal
```

Package typecheck and all 142 tests pass. Focused issue-415 run: 28 tests pass,
zero failed/skipped. The package suite also passed before the final malformed
replay case was added (141 tests). Test lint: zero gates; four count leads are
the existing documented ten-retry allowance and its prose-rewording regression.
Whitespace check passes. Early verification exposed a changed Escape-workflow
prompt phrase and an exact-optional fixture typing error; both were fixed and
verified by the passing full suite.

The focused cases cover actual handlers, sticky replay, command/hotkey single
retry, same denial re-hold, append-only history, fresh worker/policy references,
basis distinction, unrelated-success non-recovery, settings/workflow/Escape,
pending timers and in-flight audits, untrusted/malformed/oversized reports,
history/scope exhaustion, pending-release reload, and malformed persisted
evidence. Existing preferences, Escape, clocks, and generic continuation tests
remain green.

## Reviewer Follow-ups (P1/P2)

Manual edits for these follow-ups remain inside `packages/pi-better-goal/**`;
no commits, canonical/shared generated edits, or diagnostics changes were made.
The parent's `reportedPermissionGap` omission handling is preserved.

- P1: producer validation also recognizes the actual harness source owner:
  `pi-better-harness`, exact `extensions/subagents/index.ts`, the shipped literal
  default re-export, and a resolved canonical subagent manifest/`index.ts` pair.
  Standalone validation remains supported. There is no dynamic import or prose
  parsing and no tool-name-only admission.
- P2: recognized permission-authority kinds with a matching goal id and malformed
  version, timestamp, or blocker now mark replay saturated/incomplete, count as
  authority history, consume retry authority, and retain other valid evidence.
  Later valid releases cannot reverse that gap. Unrelated goals and generic
  history remain unaffected. Existing finite limits and append-only writes remain.
- The packaging fixture copies source into a disposable tree, runs the real
  `scripts/stage-harness-dependencies.mjs`, packs/extracts the resulting harness
  tarball, and loads both wrapper and standalone entries through the actual SDK.
  Goal handler tests consume the SDK's registered source metadata, not a fabricated
  standalone path. npm lifecycle scripts are disabled to avoid concurrent source
  syncing. No workers are started and no process census is performed.
- Negative fixtures cover absent/wrong harness ownership, wrong wrapper path,
  executable suffix, prose-only re-export, dynamic import, wrong target path,
  wrong target package, and missing canonical target. Both blocker adoption and
  omission authority must be rejected.
- Partial-corruption replay cases cover hold version/blocker/time, nonfinite
  time, malformed releases, retry-finished records, and gaps. They check release
  refusal before startup, command/hotkey refusal after reload, no timer wake,
  preservation of valid evidence and original history, and unrelated-record
  isolation. The original fully-invalid-evidence regression still passes.

Verification from repository root:

```sh
npm --ignore-scripts run verify -w packages/pi-better-goal
node /Users/exoulster/.pi/agent/skills/test-quality/scripts/lint-tests.mjs --files packages/pi-better-goal/test/extension.test.ts,packages/pi-better-goal/test/permission-producer-fixture.ts
git diff --check -- packages/pi-better-goal
```

Latest full result: typecheck and all 168 tests pass, zero failures or skips.
The separate `--test-name-pattern='issue #415'` run passes all 54 focused tests,
also with zero failures or skips. The new packaging fixture passes its explicit
untracked-file whitespace check (`git diff --no-index --check` returns 1 for the
new file versus `/dev/null`, with no whitespace diagnostics).
Before the production fixes, focused regressions reproduced rejection of the
SDK-loaded bundled wrapper and all eight partial-corruption cases; the real
standalone entry and source negatives passed. Test lint has zero gates and five
leads: four existing retry-budget count assertions, and the installed manifest
consumed to select the SDK-loaded wrapper. Assertions observe handlers/replay,
not source/config text equality. Whitespace verification passes.

Trust remains based on the host-owned registered source plus installed package
identity/content. This does not authenticate a deliberately counterfeit installed
package bearing the same manifest and shim, or create a runtime security boundary.
The independent Architect's bundled callback trust recommendation is pending;
the parent owns any cross-package integration. Records whose goal id is missing
or unknown, or whose authority kind is unrecognizable, cannot safely be attributed
to this goal and are ignored. No recovery, product policy, or broad architecture
decision is introduced by these fixes.

## Final Parent Verification

After integrating both implementation halves and addressing independent review:

- Goal typecheck and 171 tests passed, including installed-bundle SDK provenance,
  malformed partial replay, omitted-only scope, and manifest-declaration checks.
- Subagent typecheck and 862 tests passed; five platform tests skipped.
- Sandbox typecheck and 206 tests passed; one platform test skipped.
- Background-task typecheck and 260 tests passed; two platform tests skipped.
- Canonical journal, shared consumer, sync, and packaging suite: 66 passed.
- Existing real-TUI pause/question/resume journey passed.
- Test-quality lint had zero gates; generic retry-count and packaging-fixture
  leads were inspected. Generated contracts match their canonical sources.

The bundled producer requires the harness manifest's explicit extension,
dependency, and bundle declarations, the complete shipped literal wrapper, and
its canonical subagent package target. Partially malformed matching-goal records
and omitted parent reports preserve known evidence but refuse retry release.
Diagnostics review fixes also cover actual Responses-provider incident IDs,
SDK-normalized optional null arguments, full history evidence after recovery,
and output budgets too small for a metadata envelope.

## Remaining Limits

- This bounds autonomous retry turns, not commands inside one model turn or
  already running children. No at-most-one-command enforcement is claimed.
  Same-operation/scope instructions are prompt constraints; existing task
  guards enforce actual permissions.
- Adoption relies on the host-owned registered source path and the known
  parent producer's actionable-report contract. It is not a new security
  boundary against arbitrary trusted runtime extensions. Parent cross-package
  tests/review own proof of producer actionability and transport.
- Foreground reports are deliberately unsupported until diagnostics proves a
  guarded transport. Unsupported/malformed reports are ignored, never treated
  as success or authority to broaden retry scope.
- Resume and unrelated success cannot recover an incident. A released turn
  without a new blocker also returns to the hold, and reload does not replay
  dispatch. Matching incident recovery remains diagnostics-owned; existing
  explicit goal-completion controls are unchanged.
- History is bounded per goal (32 logical blockers, 128 authority records with
  closing capacity reserved). Full or incomplete scope refuses future release;
  prior evidence remains intact. Session append durability remains the host's
  existing responsibility.
