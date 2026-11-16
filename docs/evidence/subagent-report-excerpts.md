# Subagent report excerpt verification

## Reproduced failure

A 106,732-byte workspace workflow could not be retained as assignment evidence.
The original report implementation rejected the source because it exceeded
65,536 bytes. A process exit of zero then produced a failed assignment with a
generic completion-unverified reason. A private replay against the installed
runtime reproduced this failure twice; a 4,096-byte source passed twice.

## Implemented contract

- Each whole-file snapshot or explicitly selected byte excerpt retains at most
  65,536 bytes. Larger source files remain readable through `offset` and
  `max_bytes`, with source size and range retained beside the digest.
- A refused report can be corrected before commitment. The latest authenticated
  validation or evidence refusal is retained and cleared after correction.
- Read-only workspace access is sufficient; the trusted host retains the report
  outside the worker workspace.
- Incomplete reports retain remaining work and actual permission or external-input
  blockers. Terminal reasons distinguish incomplete work from rejected reporting
  and process failure, preserving the independent process status and exit code.
- Accepted reports remain immutable, including retries after source mutation.
  Reordered blocker object keys preserve the same request identity.

## Verification

The actual authenticated bridge, finalizer, coordinator, projection and existing
continuation paths passed all 64 focused checks:

```sh
cd packages/pi-better-subagents
node --import tsx --import ./tests/isolate-registry.mjs --test --test-concurrency=1 \
  tests/assignment-report.test.mjs tests/operation_bridge.test.mjs \
  tests/worker-waits-bridge.test.mjs tests/assignment-outcomes.test.mjs \
  tests/assignment_projection.test.mjs tests/continuation-runtime.test.mjs
```

Both Subagents and Server typechecks and `git diff --check` passed. An earlier
parallel run encountered a completion-notification timing failure; the standalone
outcome suite subsequently passed all 17 checks, and the complete focused run
passed serially.

Independent Spec and Standards reviews found two additional defects: schema
rejections bypassed the report handler, and blocker object key order affected
retry identity. Both were reproduced before correction. Both reviews then found
no remaining blockers in the incremental patch.

An isolated npm installation of the packed Harness and Server passed acceptance
against its staged immutable runtime, using private Node 24.14.1 and Pi SDK 1.4.0:

- The installed authenticated bridge retained the requested 4,096 bytes from the
  actual 106,732-byte workflow with read-only authority. Oversized and schema
  refusals remained actionable, correction succeeded, retry after source mutation
  returned the retained snapshot, and exit zero committed a successful outcome.
- The installed Harness loaded all 11 extensions through a real Pi SDK session.
  A real background process started, completed, wrote its marker, and exposed its
  retained log. The isolated session and daemon were shut down afterward.

## Remaining Delivery

This report-protocol delivery does not add automatic retries of unfinished local
work or freeze extension implementations across runtime upgrades. Those changes
need the durable continuation and launch-authority contract. The live shared
runtime was left running while active workers and background runners remained;
the installation acceptance used an isolated prefix and private runtime root.
