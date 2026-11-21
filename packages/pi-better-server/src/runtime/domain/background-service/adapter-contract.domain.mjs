// Generated fixed launch domain from packages/pi-better-background-tasks/src/adapter-contract.ts. Do not edit directly.
import { getObservedWaitHost } from "./observed-wait-client.domain.mjs";
import { inspectMeta } from "./registry.domain.mjs";
/** Optional-peer contract, mirrored by pi-better-sandbox/background-admission.ts. */
export const BACKGROUND_ADAPTER_REQUEST = "pi-better-background-tasks:adapter-request";
export const BACKGROUND_ADAPTER_VERSION = 1;
/** The schemas belong to one registerTools invocation, never to a module singleton. */
export function advertiseBackgroundAdapter(pi, schemas) {
    const unsubscribe = pi.events?.on(BACKGROUND_ADAPTER_REQUEST, (data) => {
        const request = data;
        if (request?.version !== BACKGROUND_ADAPTER_VERSION || typeof request.name !== "string" ||
            typeof request.reply !== "function")
            return;
        const parameters = schemas.get(request.name);
        if (!parameters)
            return;
        const admission = classify(pi, request.name, request.input);
        if (admission)
            request.reply({ version: BACKGROUND_ADAPTER_VERSION, parameters, admission, executionControls: 1 });
    });
    pi.on("session_shutdown", () => { if (typeof unsubscribe === "function")
        unsubscribe(); });
}
function classify(pi, name, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return;
    const params = input;
    let action;
    switch (name) {
        case "bg_task_spawn":
            action = "spawn";
            break;
        case "bg_task_spawn_batch": {
            // A batch is a local launch only when no job is remote: per-job ssh options
            // are decided by the batch launcher, not in this trusted process.
            const jobs = Array.isArray(params.jobs) ? params.jobs : [];
            const remote = jobs.some((job) => job !== null && typeof job === "object" &&
                Boolean(job.ssh));
            return remote ? undefined : "local-launch";
        }
        case "bg_task_watch":
            action = "watch";
            break;
        case "bg_task_list":
            action = "list";
            break;
        case "bg_task_status":
            action = "status";
            break;
        case "bg_task_log":
            action = "log";
            break;
        case "bg_task_stop":
            action = "stop";
            break;
        case "bg_task":
            action = params.action;
            break;
        case "bg_status":
            if (params.action === "spawn" || params.action === "watch")
                return;
            action = params.action;
            break;
        default: return;
    }
    if (action === "spawn" || action === "watch")
        return params.ssh ? undefined : "local-launch";
    if (action === "list" || action === "status" || action === "log" || action === "clear")
        return "registry";
    if (action !== "stop" || typeof params.id !== "string" || !params.id)
        return;
    // Never trust caller flags about locality. Missing/corrupt metadata is not proof
    // of a local stop; a remote stop can execute SSH in the trusted Pi process.
    const meta = inspectMeta(params.id).meta;
    if (meta && !meta.ssh && !meta.remote && (meta.kind === "process" || meta.kind === "command_watch"))
        return "registry";
    // A durable local task has no legacy registry meta. Only the currently active
    // owning session/workspace may admit it as a registry operation; the exact tool
    // source and schema are still verified by the caller before this reply is
    // trusted. A foreign session or worker-owned id stays unauthorized.
    if (getObservedWaitHost(pi)?.ownsDurableTask(params.id) === true)
        return "registry";
}
