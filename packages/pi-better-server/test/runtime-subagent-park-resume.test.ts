import { testContinuationRecovery } from "./runtime-subagent-park-fixture.ts";

for (const scenario of ["result", "bootstrap", "published", "lease"] as const) testContinuationRecovery(scenario);