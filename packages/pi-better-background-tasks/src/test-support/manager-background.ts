import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { initializeNavigatorPanels } from '../shared-navigator-panels.js';
import { registerBackgroundTasksGoalProvider } from '../goal-provider.js';
import { createBackgroundTasksNavigator } from '../navigator-provider.js';
import { createBackgroundTaskRuntime } from '../runtime.js';
import { observeForegroundSandboxPolicy } from '../sandbox.js';
import { registerTools } from '../tools.js';
import { deliverBackgroundTasksPrompt } from '../prompt.js';
import { closeBackgroundObservation } from '../work-observation.js';

/** Explicit legacy manager-domain fixture, never a production frontend fallback.
 * Exercises registry recovery and mechanical runtime against a real SDK native
 * transcript. Server-owned launch/replay acceptance uses nativeBackground's
 * default extension instead. */
export function managerBackground(pi: ExtensionAPI) {
  const runtime = createBackgroundTaskRuntime();
  const navigator = createBackgroundTasksNavigator(runtime);
  initializeNavigatorPanels(pi);
  pi.on('before_agent_start', event => deliverBackgroundTasksPrompt(event));
  registerBackgroundTasksGoalProvider(pi);
  navigator.ensureBackgroundTasksNavigatorProvider(pi);
  observeForegroundSandboxPolicy(pi);
  pi.on('session_start', async (_event, ctx) => {
    runtime.resumeScheduledWork();
    registerBackgroundTasksGoalProvider(pi);
    navigator.ensureBackgroundTasksNavigator(ctx);
  });
  pi.on('session_shutdown', async () => {
    closeBackgroundObservation(pi);
    runtime.suspendScheduledWork();
    navigator.clearBackgroundTasksNavigatorSession();
  });
  registerTools(pi, runtime, navigator.refreshBackgroundTasksNavigator);
}
