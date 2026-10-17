# Reload/SSH callback timeout diagnosis

## Scope

Base: `eb765213891415036de8a1d3d230c0aef010330a` (freshly fetched
`origin/main`). Work checkout: `/Users/exoulster/projects/pi-reload-callback-fix`.
The release evidence checkout and the parent checkout were not edited.
No product code, release metadata, suite ordering, callback policy, or timeout
was changed.

## Cause

The durability test replaced `AgentSession.sendCustomMessage` with a recorder
that did not forward the message. The shared callback batcher deliberately holds
later follow-ups after handing off the first one until Pi starts the requested
agent run (`awaitingRun` in `packages/callback-batcher/index.ts`). The recorder
prevented that run from starting. When the local and direct-SSH children finished
in the same batch the test passed; when their completions formed separate batches,
the second callback remained pending forever, despite its task being succeeded.

A marker-controlled reproduction finished the local child, waited for its
callback, then finished the direct-SSH child. It reproduced the reported
second-task completion timeout twice. Removing the first reload still reproduced
it, ruling out reload as a necessary trigger. The original timed focused test
passed in this checkout, as did the root script tests in the initial full run;
the original full-run timing failure was not independently reproduced unchanged.
The controlled reproduction exercises the same children, extension entry files,
real reload, registry success check, and callback timeout as the recorded failure.

## Change

The session fixture now uses an offline provider and records **and forwards**
`sendCustomMessage`, retaining the real Pi run lifecycle. Provider registration
survives reload. No network requests or real credentials are needed.

The existing regression uses separate release markers instead of timed child
exits, keeping both children alive through reload and requiring separate callback
batches. It verifies both durable receipts, no suppression, two actual model turns
containing the respective completions, and no duplicate delivery after another
reload. Existing journal, cursor, and SSH watch checks remain in place.

## Verification

Environment: Node `v24.14.1`, codex-cli `0.159.2`, tmux `3.6a`.
All log paths below are local evidence outside the checkout.

Focused regression command (run from the work checkout):

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test \
  --test-name-pattern 'local and direct-SSH' \
  scripts/reload-ssh-durability.e2e.test.mjs
```

- Before the fixture fix: two failures, each `timed out waiting for bg_..._2 completion callback`, approximately 17 seconds. Logs: `/tmp/pi-reload-callback-minimized-red-1.log`, `/tmp/pi-reload-callback-minimized-red-2.log`.
- Temporary no-reload probe: the same second-task timeout. Log: `/tmp/pi-reload-callback-without-reload-red.log`. The probe was removed.
- After the fixture fix: two passes. Logs: `/tmp/pi-reload-callback-minimized-green-1.log`, `/tmp/pi-reload-callback-minimized-green-2.log`.
- Full focused file: 3 passed, 1 opt-in live-SSH skip, 0 failures. Command: `node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/reload-ssh-durability.e2e.test.mjs`. Log: `/tmp/pi-reload-callback-focused-green.log`.
- Full original verification command: `PI_CODING_AGENT_DIR=/tmp/pi-reload-callback-agent npm run verify`, exit 0, including workspace typechecks and tests. The private agent directory existed before the run. Root scripts: 153 passed, 10 skipped, 0 failed; the separated-exit regression passed in about 2.1 seconds. Log: `/tmp/pi-reload-callback-full-green.log`.
- Diff-scoped test-quality lint: `node /Users/exoulster/.pi/agent/skills/test-quality/scripts/lint-tests.mjs --diff eb765213891415036de8a1d3d230c0aef010330a`, no findings. `git diff --check` passed.

The initial full verification attempt failed in unrelated sandbox tests because
the selected isolated agent directory did not yet exist. Its reload/SSH tests
passed. That setup error was corrected by creating the directory, without
changing sandbox tests. Log: `/tmp/pi-reload-callback-baseline-verify.log`.

Live network SSH was not run; the always-on SSH scenarios use the existing local
fake SSH transport. The failure would have been prevented by retaining the real
session lifecycle and controlling child exits independently of wall-clock timing.
