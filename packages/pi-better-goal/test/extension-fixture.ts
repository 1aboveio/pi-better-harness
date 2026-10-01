import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

// The extension snapshots wake configuration when its module loads. Exercise
// the documented defaults regardless of the invoking developer's Pi settings.
const wakeSettings = [
  "PI_BETTER_GOAL_DISABLE_WAKE",
  "PI_BETTER_EXTENSION_DISABLE_WAKE",
  "PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS",
  "PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES",
];
const previous = wakeSettings.map((key) => [key, process.env[key]] as const);
let loaded: typeof import("../src/index.js");
try {
  for (const key of wakeSettings) delete process.env[key];
  loaded = await import("../src/index.js");
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
export default loaded.default;
export const goalArgumentCompletions = loaded.goalArgumentCompletions;

export function toolContext(ctx: ExtensionContext): Parameters<ToolDefinition["execute"]>[4] {
  const context = {
    ...ctx,
    tools: [],
    async executeTool(): Promise<never> {
      throw new Error("Unexpected nested tool execution in the test fixture.");
    },
  };
  return context;
}
