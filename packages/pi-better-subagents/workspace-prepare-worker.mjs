import { parentPort, workerData } from "node:worker_threads";
import { resolveSubagentWorkspace } from "./git-workspace.ts";
import { createIsolatedWorkspace } from "./isolated-workspace.ts";

const { options, isolated } = workerData;
if (isolated) {
    const cwd = createIsolatedWorkspace(isolated, true);
    parentPort.postMessage({ cwd, requestedSandboxDir: options.sandboxEnabled ? cwd : undefined });
} else {
    parentPort.postMessage(resolveSubagentWorkspace(options));
}
