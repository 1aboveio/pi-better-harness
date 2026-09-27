import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeBackgroundWorkNavigator } from "./shared-navigator.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { clearBackgroundTasksNavigatorSession, ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
import { resumeScheduledWork, suspendScheduledWork } from "./runtime.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  registerBackgroundTasksGoalProvider(pi);
  ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  // Registered before registerTools(pi), so this runs before running tasks are resumed.
  pi.on("session_start", async (_event, ctx) => {
    resumeScheduledWork();
    registerBackgroundTasksGoalProvider(pi);
    ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
    suspendScheduledWork();
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator(ctx);
  });
  registerTools(pi);
}