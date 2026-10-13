import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { createBackgroundTasksNavigator } from "./navigator-provider.js";
import { createBackgroundTaskRuntime } from "./runtime.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";
import { appendExecutionPolicy } from "./shared-execution-policy.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  const runtime = createBackgroundTaskRuntime();
  const navigator = createBackgroundTasksNavigator(runtime);
  const { ensureBackgroundTasksNavigatorProvider, ensureBackgroundTasksNavigator, clearBackgroundTasksNavigatorSession } = navigator;
  pi.on("before_agent_start", (event) => ({ systemPrompt: appendExecutionPolicy(event.systemPrompt) }));
  registerBackgroundTasksGoalProvider(pi);
  ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  // Registered before registerTools(pi), so this runs before running tasks are resumed.
  pi.on("session_start", async (_event, ctx) => {
    runtime.resumeScheduledWork();
    registerBackgroundTasksGoalProvider(pi);
    ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    clearBackgroundTasksNavigatorSession();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
    runtime.suspendScheduledWork();
    clearBackgroundTasksNavigatorSession();
  });
  registerTools(pi, runtime, navigator.refreshBackgroundTasksNavigator);
}