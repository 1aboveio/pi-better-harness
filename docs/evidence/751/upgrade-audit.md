# Upgrade obligation and admission audit

> **Status authority:** [Current acceptance matrix](status-index.md). This is a historical checkpoint; its open gaps and test counts are not the current completion status. Original evidence is retained below.

The activation gate now checks durable runtime obligations in addition to HostedSession idleness. It refuses degraded observations, accepted launch intents, active resume claims, unsettled operations (including watches), and unresolved worker metadata. Upgrade status exposes blockers instead of presenting a silent wait.

A persistent SQLite trigger fences new operation registration while an activation is pending, including older bundled foreground writers. Existing operation retries remain idempotent. An exact worker-conversation assignment binding with an accepted attempt and no terminal assignment outcome can create dependencies; unrelated workspaces and completed assignments cannot use this exception. Both Background launch paths register the operation before starting the supervisor, so this fence runs before execution. New managed Subagent launch requests receive runtime-draining while pending. Revoked reservations clear the fence; proven successor startup clears the preceding manager's fence.

Validation: 17 real activation tests pass with isolated registry roots, plus the real deferred-upgrade external-registration rejection case, 5 query executor tests, 4 coordinator observer tests, unknown-writer observation, and the admission-fence SQLite test. Coordinator and Server typechecks pass. Non-isolated activation tests encountered global registry read deadlines; isolated reruns passed. This is not evidence that global inventory performance satisfies the final epic budget.

Published releases remain immutable and retained: private-runtime/installer.ts removeOwned is used only for private candidate/work directories, never published releases. Activation waits for the preceding guardian to release ownership before launching a successor.

Artifact/install/activation/standalone matrix passed 83 tests; its one opt-in network case was then enabled separately and passed. That case installs the real private Node and locked SDK through client-download fallback. The packed standalone test passed cached offline restart with evidence under .work/standalone-DW20xi. Integration with the managed-launch branch and independent review remain required before #764 is complete.
