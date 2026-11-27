import { testContinuationRecovery } from "./runtime-subagent-park-fixture.ts";

for (const scenario of ["parent", "park", "writer", "claim", "spawn", "tools"] as const) testContinuationRecovery(scenario);