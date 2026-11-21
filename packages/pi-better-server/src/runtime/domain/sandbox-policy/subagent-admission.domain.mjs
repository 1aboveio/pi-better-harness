// Generated fixed launch domain from packages/pi-better-sandbox/subagent-admission.ts. Do not edit directly.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
const REQUEST_CHANNEL = "pi-better-subagents:execution-adapter-request";
const VERSION = 1;
function trustedEntries() {
    const own = fileURLToPath(import.meta.url);
    const base = dirname(own);
    const candidates = [
        join(base, "../pi-better-subagents/index.ts"),
        join(base, "../../extensions/subagents/index.ts"),
        join(base, "../pi-better-harness/extensions/subagents/index.ts"),
    ];
    const require = createRequire(own);
    for (const specifier of ["pi-better-subagents", "pi-better-subagents/index.ts", "pi-better-harness/extensions/subagents/index.ts"]) {
        try {
            candidates.push(require.resolve(specifier));
        }
        catch { /* Optional peer is absent. */ }
    }
    const entries = new Set();
    for (const path of candidates) {
        try {
            entries.add(realpathSync(path));
        }
        catch { /* Missing entries cannot own a tool. */ }
    }
    return entries;
}
/** Restrictive launch policies require the current host-owned source and schema. */
export function createSubagentExecutionAdmission(pi) {
    const trusted = trustedEntries();
    return (name) => {
        try {
            if (name !== "subagent_spawn" && name !== "subagent_spawn_batch")
                return false;
            const tool = pi.getAllTools().find((candidate) => candidate.name === name);
            const source = tool?.sourceInfo?.path;
            if (!tool || !source || !isAbsolute(source) || !trusted.has(realpathSync(source)))
                return false;
            let admitted = false;
            pi.events.emit(REQUEST_CHANNEL, {
                version: VERSION, name,
                reply(value) {
                    const reply = value;
                    if (reply?.version === VERSION && reply.parameters === tool.parameters)
                        admitted = true;
                },
            });
            const current = pi.getAllTools().find((candidate) => candidate.name === name);
            return admitted && current?.parameters === tool.parameters && current.sourceInfo?.path === source;
        }
        catch {
            return false;
        }
    };
}
/** Explicit opt-in uses the retained profile even when its default switch is Off. */
export function requestsSubagentSandbox(name, input) {
    const value = input;
    if (name === "subagent_spawn")
        return value?.sandbox === true;
    return name === "subagent_spawn_batch" && Array.isArray(value?.jobs) && value.jobs.some((job) => {
        const sandbox = job?.sandbox;
        return (sandbox == null ? value.shared?.sandbox : sandbox) === true;
    });
}
