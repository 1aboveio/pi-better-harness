# Recipient delivery audit (#763)

The registered Subagents extension supplies local and HostedSession outcome inspection and explicit consumption. HostedSession binds the real SDK extension runner. No separate socket consume API is required; permission checks remain in assignment-outcomes.ts.

## Real entrypoint evidence

`runtime-assignment-sdk.test.ts` passes both local SDK and HostedSession cases. It uses actual resource loading, registered tools, native session persistence, callback batching, a live query daemon and an offline model provider.

Each case commits an assignment terminal outcome, invokes ordinary workflow recovery, observes its structured native transcript receipt and exactly one authorized model turn, inspects through subagent_result, closes the recipient, reopens its saved session, consumes through the registered tool, and repeats consumption without changing the durable outcome. Reconnect preserves the receipt and does not start another model turn.

The HostedSession case deliberately leaves the receiver unread until its event cursor falls outside a bounded EventLog. subscribe reports truncation and clientSnapshot recovers the outcome from the actual transcript. This proves delayed receiver replay repair at the HostedSession API; it does not simulate kernel socket backpressure.

## Domain race and permission evidence

`assignment-outcomes.test.mjs`: 16 passing cases cover actual finalization, batch receipt repair, paused/inactive recipients, wrong branch, current permission restrictions, cancellation, bounded dependency log reads, and exact disposition. These cases use a stub ExtensionAPI; the real SDK tests above validate the adapter contract they rely on.

Parent exit and Goal/template edits preserving the child's execution are covered by the launch slice's real SDK runtime test, not duplicated here. Unread outcomes not independently keeping the daemon alive and bounded socket subscriber handling remain part of runtime acceptance. Review those cross-slice proofs before closing #763/#751.
