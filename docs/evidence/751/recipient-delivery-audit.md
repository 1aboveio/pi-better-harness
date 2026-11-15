# Recipient delivery audit (#763)

> **Status authority:** [Current acceptance matrix](status-index.md). This is a historical checkpoint; its open gaps and test counts are not the current completion status. Original evidence is retained below.

The registered Subagents extension supplies local and HostedSession outcome inspection and explicit consumption. HostedSession binds the real SDK extension runner. No separate socket consume API is required; permission checks remain in assignment-outcomes.ts.

## Real entrypoint evidence

`runtime-assignment-sdk.test.ts` passes both local SDK and HostedSession cases. It uses actual resource loading, registered tools, native session persistence, callback batching, a live query daemon and an offline model provider.

Each case commits an assignment terminal outcome, invokes ordinary workflow recovery, observes its structured native transcript receipt and exactly one authorized model turn, inspects through subagent_result, closes the recipient, reopens its saved session, consumes through the registered tool, and repeats consumption without changing the durable outcome. Reconnect preserves the receipt and does not start another model turn.

The HostedSession case deliberately leaves the receiver unread until its event cursor falls outside a bounded EventLog. subscribe reports truncation and clientSnapshot recovers the outcome from the actual transcript. This proves delayed receiver replay repair at the HostedSession API; it does not simulate kernel socket backpressure.

## Domain race and permission evidence

`assignment-outcomes.test.mjs`: 16 passing cases cover actual finalization, batch receipt repair, paused/inactive recipients, wrong branch, current permission restrictions, cancellation, bounded dependency log reads, and exact disposition. These cases use a stub ExtensionAPI; the real SDK tests above validate the adapter contract they rely on.

Parent exit and Goal/template edits preserving the child's execution are covered by the launch slice's real SDK runtime test, not duplicated here. Unread outcomes not independently keeping the daemon alive and bounded socket subscriber handling remain part of runtime acceptance. Review those cross-slice proofs before closing #763/#751.

## Real slow Unix subscriber

`runtime-assignment-slow-socket.test.ts` runs the production server and HostedSession with the real SDK and an offline streaming provider. The subscribed client pauses its actual Unix socket reads before assignment delivery. A pass-through observer verifies that production socket writes return false under backpressure; it neither substitutes a Duplex nor changes write behavior. The stream exceeds the bounded event log, the client disconnects, and a fresh socket receives an explicit truncated replay and repairs the exact outcome from `client_snapshot`. Registered result-tool inspection and repeated consumption retain one durable disposition and one model handoff. A separately created HostedSession receives no outcome in its snapshot or events and cannot inspect or rewrite the original recipient's disposition.

Validation: the new socket acceptance test and server typecheck pass on Node 24.21.0. Independent `npm ci --ignore-scripts` failed on the configured registry proxy with HTTP 502; validation used a separate copy of the integration worktree's freshly installed dependencies. Workspace symlinks resolve inside this worktree; SDK 0.82.1, pi-ai 0.82.1 and tsx 4.23.1 match the lockfile. No production code changed. This proves durable repair under backpressure, not bounded transport memory for an indefinitely stalled subscriber.
