import { shouldRestoreWorkObservation } from "./shared-work-client.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initializeNavigatorPanels } from "./shared-navigator-panels.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { createBackgroundTasksNavigator } from "./navigator-provider.js";
import { createManagedBackgroundFrontend } from "./managed-frontend.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";
import { deliverBackgroundTasksPrompt } from "./prompt.js";
import { closeBackgroundObservation } from "./work-observation.js";
import { readBackgroundReviewInterval, saveBackgroundReviewInterval } from "./review-settings.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  // The frontend owns native UI/delivery only. Mechanical tools run in the
  // fixed server service. Register their native definitions before the first turn.
  const {host: observedWaits, proxy, ui} = createManagedBackgroundFrontend(pi);
  const navigator = createBackgroundTasksNavigator(undefined, ui);
  initializeNavigatorPanels(pi);
  const intervalLabel = (minutes: number) => `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const reviewSetting = {
    id: "background-review-interval",
    label: "Background wait review interval",
    values: [1, 5, 10, 15, 30, 60].map(intervalLabel),
    get: () => intervalLabel(readBackgroundReviewInterval()),
    change(value: string) {
      saveBackgroundReviewInterval(Number.parseInt(value, 10));
      void observedWaits.reconcileNow().catch(() => undefined);
    },
  };
  const registerReviewSetting = () => pi.events.emit("harness-settings:register", reviewSetting);
  let stopReviewSettings: (() => void) | undefined = pi.events.on("harness-settings:request", registerReviewSetting);
  registerReviewSetting();
  // Sections on a host that renders them; text only where it renders none.
  // Returning a prompt on modern pi would set forceSystemPrompt, and the request
  // would then carry a snapshot, so sections published after it never arrive.
  pi.on("before_agent_start", (event) => deliverBackgroundTasksPrompt(event));
  registerBackgroundTasksGoalProvider(pi);
  navigator.ensureBackgroundTasksNavigatorProvider(pi);
  // Subscribed at load so a sandbox extension that publishes later is heard, and
  // asked for a snapshot in case one published before this extension existed.
  observeForegroundSandboxPolicy(pi);
  // Registered before registerTools(pi), so this runs before running tasks are resumed.
  pi.on("session_start", async (_event, ctx) => {
    stopReviewSettings ??= pi.events.on("harness-settings:request", registerReviewSetting);
    registerReviewSetting();
    registerBackgroundTasksGoalProvider(pi);
    navigator.ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_before_switch", async () => {
    closeBackgroundObservation(pi);
    observedWaits.close();
    navigator.clearBackgroundTasksNavigatorSession();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopReviewSettings?.();
    stopReviewSettings = undefined;
    closeBackgroundObservation(pi);
    // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
    observedWaits.close();
    navigator.clearBackgroundTasksNavigatorSession();
  });
  registerTools(proxy, undefined, navigator.refreshBackgroundTasksNavigator, {resumeLocal:false});
  // Registered after registerTools so the callback batcher has its session
  // context before a reconciled delivery can enqueue a parent notification.
  pi.on("session_start", (event, ctx) => {
    observedWaits.start(ctx, shouldRestoreWorkObservation(event, ctx.sessionManager));
  });
  // A fork or branch navigation does not restart the session, but it changes
  // which continuation may receive a queued callback. Update the host snapshot
  // on the same event the callback batcher uses.
  pi.on("session_tree", async (_event, ctx) => {
    observedWaits.noteParentContext(ctx);
  });
}
