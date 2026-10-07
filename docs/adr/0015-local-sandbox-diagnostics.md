# Local sandbox diagnostics

## Status

Accepted. Extends ADR 0014's global default storage and preserves ADR 0012's
distinction between enforcement evidence and agent-reported blockers.

## Decision

Collection is off by default. The human controls it through `/sandbox diagnostics
on|off`; its setting lives in global `settings.json` under
`piBetterHarness.sandboxDiagnostics`. Collection never uploads data, changes
permissions, or supplies authorization. It is separate from the actionable
failure journals and Goal permission holds.

Trusted policy decisions record `policy-refusal`. File-worker and process-launch
`EACCES`/`EPERM` errors record `os-permission-error`, not proof that the sandbox
caused the failure. Arbitrary command output, nonzero exits, and assistant prose
are not classification evidence. Existing agent-reported blocker journals retain
their own semantics.

Confined workers cannot write the protected global journal. They relay only
fixed, redacted reports through their existing local JSON event stream; the
parent persists these as `agent-reported`, never as confirmed policy evidence.
Per-worker ephemeral HMAC identities reveal no inputs or keys; the parent rekeys
them with the installation key. Worker correlations are local to that reporter,
not proof that an operation in another run was recovered. Persistent report
identities prevent duplicate observations when parent logs are rescanned.
No diagnostic path is added to a worker's writable permissions.
Only fixed, validated runtime categories and a constrained version string travel
with reports; records retain that reported worker metadata rather than attributing
a long-lived worker to a newer parent after reload.

Store a bounded local journal beneath `<agent-dir>/diagnostics/sandbox`. Retain at
most 2,000 observations, 1 MiB, and 30 days. Use secure modes, interprocess locking,
and atomic replacement; refuse symlinked diagnostic storage. Report retention
loss and incomplete/corrupt observations rather than claiming complete coverage.

Journal transactions use an atomic private lock directory with bounded contention
retries and no time-based eviction. A paused synchronous writer must retain
exclusivity; a lease cannot safely fence its eventual rename or unlock. An orphan
after abrupt process termination therefore blocks sampling instead of risking
silent overwrite. Stop all collectors before manually removing an empty orphan
`events.jsonl.lock` directory. File/link validation runs inside the critical
section so cooperating atomic replacements are not misclassified as unsafe.

Records contain fixed resource/tool categories, context, package version,
platform/backend, evidence basis, time, outcome, and installation-keyed HMAC
operation/policy fingerprints. No paths, command text, output, contents, tokens,
or caller-provided free text are retained. The local key is never exported.
Fingerprint matches are observed operation correlations, not remote authorization
or a statement that the policy was incorrect.

Successful retries are retained only for previously observed failed operations.
Analysis groups observations by version, backend, tool, resource, basis, and policy.
`/sandbox diagnostics summary` reports local evidence; `export` writes a redacted
JSON file at a fixed local location for deliberate sharing. Export sends nothing.

Collection failures cannot replace a tool result, bypass a denial, or weaken
enforcement. Warn about gaps without logging sensitive exception messages.

## Limits

Shell subprocess stderr is untrusted, so shell-internal permission failures are
not automatically attributed. Background launches are observed at their policy
preflight; successful launch is not successful completion of the requested work.
This is diagnostic sampling, not an OS audit trail or a security boundary against
trusted extensions. No raw-detail mode or remote telemetry is introduced.