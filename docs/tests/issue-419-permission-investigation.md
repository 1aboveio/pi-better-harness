# Issue #419: Git optional locks and permission attribution

## Local evidence

The retained `sa_mutmqbr0_5` output and frozen `control/task-policy.json`
establish the following, independently of the later sandbox-disabled retry:

- The task root was `<repo>/.worktrees/dev-85-android-foundation`.
- Its `.git` file pointed to `<repo>/.git/worktrees/dev-85-android-foundation`.
- Project files was `read-write`, Outside project was `write`, and Stored
  credentials was `read`. The command ran through the trusted task runtime.
- The first inventory command included `git status --short --branch`.
- Git reported `warning: unable to unlink '<gitdir>/index.lock': Operation not
  permitted`, but exited zero. The tool result carried `isError: false`.

The administrative directory is outside the task root, under an ordinary home
folder. Its `.git` component is not a hidden *top-level home entry*, and
`worktrees` is not the disposable `.worktrees` or `*-worktrees` path class.
Under [ADR 0008](../adr/0008-write-without-delete.md), macOS permits creation
there but refuses removal. `evaluateWriteAccess` returns `allowed: true`;
`evaluateDeleteAccess` returns `allowed: false, reason: delete-denied`.

## Reproduction and mitigation

An isolated linked repository under a synthetic, non-temp home reproduces the
original warning through the actual generated Seatbelt profile:

| Optional locking | Git status exit | Warning | Lock afterwards |
| --- | --- | --- | --- |
| `GIT_OPTIONAL_LOCKS=1` | 0 | Unable to unlink; Operation not permitted | Empty `index.lock` |
| `GIT_OPTIONAL_LOCKS=0` | 0 | None | Absent |

The maintained regression runs the shared task bash executor, checks the
default inventory behavior, explicitly enables optional locking to reproduce
the warning, and probes unlink to capture the OS `EPERM`, syscall `unlink`, and
exact lock path. An unconfined status is a positive cleanup control. A new
repository inside the writable root proves required `git add` index writes
still work under the default.

```sh
PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt node --import tsx --test \
  --test-name-pattern 'confined Git inventory' packages/task-sandbox/bash.test.ts
```

Confined bash now defaults `GIT_OPTIONAL_LOCKS` to `0`, preserving inherited and
per-call overrides. Unconfined commands are unchanged. This avoids optional
index refreshes without granting unlink, broadening any path rules, disabling
required Git locks, or deleting existing lock files. Git-mutating subagents
should still use `git_clone_workspace:true` so their administrative state lives
inside the writable root.

This proves a mechanism matching the recorded local warning. It does not
establish that every later lock obstruction came from this child: historical
inode identity and the original create/unlink syscall trace were not retained.
The lock warning itself was not a failed tool result; it should not be conflated
with the separately retained tool-failure observations.

## Incident classification

No incident-classification defect was established by the report. The existing
[ADR 0006](../adr/0006-shared-failure-observations.md) intentionally separates
completion from recovery. A successful lifecycle does not resolve earlier tool
errors, and natural-language descriptions of intentional failures are not
trusted declarations.

Trusted task-runtime children can declare `expectedExitCodes` before a negative
probe. Exact later retries or a successful later command with the same declared
`operationId` establish recovery. A different remediation needs an explicit,
evidence-backed `failure_disposition` of `superseded`; intentional probes can be
disposed as `expected`. History remains retained, and delivery receipts do not
close incidents. The specific prerequisite incidents would need their own
command/evidence review before being declared handled.

## Verification

The maintained kernel regression failed with the original `taskEnv` behavior at
the assertion forbidding the exact unlink warning, and passed after adding the
optional-lock default. The complete `task-sandbox` suite passed 87 tests with
zero skips under `PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt`; its strict TypeScript
check passed. The test lint's `added.txt` text-oracle lead is a generated fixture
and actual `git diff --cached` output, not a checked-in text assertion.
All workspace typechecks passed. Focused subagent runtime/incident suites passed
62 tests, and the foreground sandbox suite passed 206 tests. Each consumer run
skipped one Linux-only case on macOS. Both generated task-sandbox copies match
the canonical source. Linux kernel execution and the full monorepo test suite
were not run for this change.

## Remote retry

[Run 37215254156, attempt 2](https://github.com/1aboveio/fmm-express/actions/runs/37215254156/attempts/2)
completed with failure at unchanged SHA
`997a9075edc91fc96b5b54c7bbae4bf8dfca7d22`:

- `Build Android debug APK` timed out after 30 minutes.
- `Real native phone journey` was skipped in this attempt.
- Evidence staging again rejected source mode `1533` decimal (`02775`) and
  command-file mode `436` decimal (`0664`), both uid `1001`.

Those are remote runner/application checks, not local Seatbelt decisions.
Disabling the local sandbox did not make that attempt pass. No application
safety checks, runner permissions, or artifact retrieval behavior were changed
as part of this investigation.