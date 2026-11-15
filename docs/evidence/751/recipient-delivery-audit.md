# Recipient delivery audit (#763)

The registered Subagents extension already supplies local and HostedSession outcome inspection and explicit consumption. HostedSession binds the real SDK extension runner; introducing a second raw socket consume API would duplicate permission checks in assignment-outcomes.ts.

Current evidence:

- runtime-assignment-sdk.test.ts exercises real SDK resource loading and real HostedSession binding against a live query daemon, persisted assignment outcomes and the actual subagent_result tool. Both recipient inspection and repeated explicit consumption pass. These cases disable automatic callbacks and do not prove automatic delivery.
- Existing assignment-outcomes.test.mjs: 16 passing cases cover actual finalization, batch receipt repair, paused/inactive recipients, wrong branch, current permission restrictions, cancellation, bounded dependency log reads, and exact disposition. Those cases use a stub ExtensionAPI; they are domain evidence, not a substitute for real SDK automatic delivery/reconnect acceptance.
- assignment-delivery.test.ts proves an internal fixed-recipient port shares the coordinator connection and rejects other scopes. The port is not wired into host flows and is not acceptance evidence for end-to-end delivery.

Remaining: real SDK automatic receipt and saved-session reconnect, real HostedSession event replay/slow receiver coverage, and authoritative proof that each required race preserves the original assignment recipient. No issue closure is justified yet.
