# Background ownership migration

The native Background extension registers the existing tools and UI, but execution goes through the fixed server adapter. The frontend holds no coordinator connection or mechanical reconciliation timer. The server adapter borrows the root mutation store and uses the shared query-worker snapshot; unchanged recipients do not each enumerate legacy metadata or reconcile operations. Navigator rendering reads cached data. Explicit selection and observation refresh load evidence.

Protected request grants capture native session/workspace/branch identity, PID/start identity, tool schema, arguments and current Background permissions. The server validates the grant and schema, intersects captured restrictions with the fresh mandatory profile, and checks authority again immediately before external dispatch. A durable request journal returns prior results or exact prepared identities after an interrupted dispatch; it never silently retries an uncertain external launch. New parent admissions are refused during upgrade drain. Worker launches retain their captured Background profile and re-read mandatory settings before preparation and dispatch.

Native completion and urgent delivery remain in the real frontend callback batcher. The server records delivery only after an authenticated native receipt. Reconnect replay checks exact structured native transcript IDs. A dedicated pending-callback index preserves legacy callbacks older than the Navigator's 30-second visible retention. Context switches queue a fresh observation and discard old detail responses.

## Verification

- Actual standalone SDK + server: spawn, exact request replay, wait, kill foreground, server terminal publication, reopen native session, status, logs, stop, mandatory permission refusal, native completion receipt.
- Fixed adapter: new-admission drain refusal, accepted replay, changed request/schema refusal, interrupted receipt recovery.
- Canonical host: 64 observed-waits tests, including authority revocation after registration and before process spawn.
- Native UI: 60 render reads issue zero provider requests; explicit selection fills evidence; normal/urgent structured transcript replay avoids duplicate delivery; delayed refresh survives session switch.
- Navigator: 43 tests passed. Permission/query/journal focused run: 23 tests passed. Background/Server/Subagents/coordinator typechecks passed.
- Full process resource run with real guardian, server, two HostedSessions, worker, runner, command, two legacy commands and 1/5/10 native clients: coordinator connections 2 and derived connections 1 throughout. Shared semantic refresh/reconcile, legacy inventories/index reads and terminal metadata rereads were zero during unchanged windows. Active-command supervision metadata reads were reported separately (14/12/154 over approximately 3/3/60 seconds), not represented as historical reads. The last ten-client RPC p95 was 1.46 ms; this is a measurement, not a portable latency guarantee.

## Remaining integration gates

The five old Background extension fixtures still assume a local foreground host and incomplete fake SDK contexts: cached-factory-lifecycle, failure-attention-lifecycle, golden-path, e2e, sandbox-kernel (32 failures, 17 passes in that targeted run). They require migration to actual native/server entry or explicit canonical-domain fixtures. This is separate from the passing actual native acceptance test. Linux, packed standalone and current integrated worker-continuation tests must be rerun after integration; this document does not claim the whole epic is complete.
