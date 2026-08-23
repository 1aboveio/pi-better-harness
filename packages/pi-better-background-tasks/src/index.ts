import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeBackgroundWorkNavigator } from "./shared-navigator.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { clearBackgroundTasksNavigatorSession, ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  registerBackgroundTasksGoalProvider(pi);
  ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  pi.on("session_start", async (_event, ctx) => {
    registerBackgroundTasksGoalProvider(pi);
    ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator(ctx);
  });
  registerTools(pi);
}