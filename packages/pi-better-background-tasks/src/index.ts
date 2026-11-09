import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeBackgroundWorkNavigator } from "./shared-navigator.ts";
import { initializeNavigatorPanels } from "./shared-navigator-panels.ts";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.js";
import { clearBackgroundTasksNavigatorSession, ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
import { resumeScheduledWork, suspendScheduledWork } from "./runtime.js";
import { createObservedWaitHost } from "./observed-waits.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { observeForegroundSandboxPolicy } from "./sandbox.js";
import { registerTools } from "./tools.js";
import { deliverBackgroundTasksPrompt } from "./prompt.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  // Created before registerTools so the tools can resolve it lazily; the durable
  // store opens on session activation and closes on switch/unload.
  const observedWaits = createObservedWaitHost(pi, {
    notifyParent: (notification, delivery) => {
      getCallbackBatcher(pi).enqueue({
        source: "background-task",
        id: notification.taskId,
        label: notification.taskId,
        status: notification.waitId
          ? `${notification.status}; wait ${notification.waitId} ready`
          : notification.status,
        detailTool: "bg_task_status",
        outcome: notification.outcome,
        callback: true,
        // The batcher can hold the event across a busy turn or a session switch.
        // Receipt is the durable outbox/sidecar acknowledgement, not enqueue.
        getSuppressionReason: () => observedWaits.isParentOriginActive(notification.origin, notification.branchId)
          ? undefined
          : "the originating session or branch is no longer active",
        onDelivered: () => delivery.delivered(),
        onSuppressed: (reason) => delivery.defer(reason ?? "callback delivery was suppressed"),
      });
    },
  });
  initializeNavigatorPanels(pi);
  // Sections on a host that renders them; text only where it renders none.
  // Returning a prompt on modern pi would set forceSystemPrompt, and the request
  // would then carry a snapshot, so sections published after it never arrive.
  pi.on("before_agent_start", (event) => deliverBackgroundTasksPrompt(event));
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
    observedWaits.close();
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
    observedWaits.close();
    suspendScheduledWork();
    clearBackgroundTasksNavigatorSession();
    disposeBackgroundWorkNavigator(ctx);
  });
  registerTools(pi);
  // Registered after registerTools so the callback batcher has its session
  // context before a reconciled delivery can enqueue a parent notification.
  pi.on("session_start", async (_event, ctx) => {
    observedWaits.start(ctx);
  });
  // A fork or branch navigation does not restart the session, but it changes
  // which continuation may receive a queued callback. Update the host snapshot
  // on the same event the callback batcher uses.
  pi.on("session_tree", async (_event, ctx) => {
    observedWaits.noteParentContext(ctx);
  });
}