// Generated fixed launch domain from packages/pi-better-subagents/workspace-prepare-worker.mjs. Do not edit directly.
import { parentPort, workerData } from "node:worker_threads";
import { resolveSubagentWorkspace } from "./git-workspace.domain.mjs";
import { createIsolatedWorkspace } from "./isolated-workspace.domain.mjs";
const { options, isolated } = workerData;
if (isolated) {
    const cwd = createIsolatedWorkspace(isolated, true);
    parentPort.postMessage({ cwd, requestedSandboxDir: options.sandboxEnabled ? cwd : undefined });
}
else {
    parentPort.postMessage(resolveSubagentWorkspace(options));
}
