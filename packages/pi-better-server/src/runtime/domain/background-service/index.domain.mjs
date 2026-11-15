// Generated fixed launch domain from packages/pi-better-background-tasks/src/index.ts. Do not edit directly.
import { initializeNavigatorPanels } from "./shared-navigator-panels.domain.mjs";
import { registerBackgroundTasksGoalProvider } from "./goal-provider.domain.mjs";
import { createBackgroundTasksNavigator } from "./navigator-provider.domain.mjs";
import { createBackgroundTaskRuntime } from "./runtime.domain.mjs";
import { createManagedBackgroundFrontend } from "./managed-frontend.domain.mjs";
import { observeForegroundSandboxPolicy } from "./sandbox.domain.mjs";
import { registerTools } from "./tools.domain.mjs";
import { deliverBackgroundTasksPrompt } from "./prompt.domain.mjs";
import { closeBackgroundObservation } from "./work-observation.domain.mjs";
export default function backgroundTasksExtension(pi) {
    // The frontend owns native UI/delivery only. Mechanical tools run in the
    // fixed server service; this runtime supplies registration metadata only.
    const runtime = createBackgroundTaskRuntime();
    const { host: observedWaits, proxy, ui } = createManagedBackgroundFrontend(pi);
    const navigator = createBackgroundTasksNavigator(runtime, ui);
    initializeNavigatorPanels(pi);
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
        runtime.resumeScheduledWork();
        registerBackgroundTasksGoalProvider(pi);
        navigator.ensureBackgroundTasksNavigator(ctx);
    });
    pi.on("session_before_switch", async () => {
        closeBackgroundObservation(pi);
        observedWaits.close();
        navigator.clearBackgroundTasksNavigatorSession();
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        closeBackgroundObservation(pi);
        // /reload, session replacement, and quit load a fresh instance; stop this one's timers (#324).
        observedWaits.close();
        runtime.suspendScheduledWork();
        navigator.clearBackgroundTasksNavigatorSession();
    });
    registerTools(proxy, runtime, navigator.refreshBackgroundTasksNavigator, { resumeLocal: false });
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
