import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Optional peers share only this synchronous wire contract, not a runtime import.
const REQUEST_CHANNEL = "pi-better-background-tasks:adapter-request";
const VERSION = 1;
export type BackgroundAdmission = "local-launch" | "registry";

/** Resolve trusted entries from this installation, never from event-bus claims. */
function trustedBackgroundEntries(): Set<string> {
    const own = fileURLToPath(import.meta.url);
    const base = dirname(own);
    const candidates = [
        join(base, "../pi-better-background-tasks/src/index.ts"),
        join(base, "../../extensions/background-tasks/index.ts"),
        join(base, "../pi-better-harness/extensions/background-tasks/index.ts"),
    ];
    const require = createRequire(own);
    for (const specifier of ["pi-better-background-tasks/src/index.ts", "pi-better-harness/extensions/background-tasks/index.ts"]) {
        try { candidates.push(require.resolve(specifier)); } catch { /* Optional package is absent. */ }
    }
    const entries = new Set<string>();
    for (const path of candidates) {
        try { entries.add(realpathSync(path)); } catch { /* Absent entries cannot own tools. */ }
    }
    return entries;
}

/** A familiar name is only a candidate, not evidence that its implementation is safe. */
export function isBackgroundLaunch(name: string, input: unknown): boolean {
    const action = (input as { action?: unknown } | null)?.action;
    return name === "bg_task_spawn" || name === "bg_task_watch" ||
        (name === "bg_task" && (action === "spawn" || action === "watch"));
}

export function createBackgroundAdmission(pi: ExtensionAPI, requiresExecutionControls: () => boolean = () => false) {
    const trusted = trustedBackgroundEntries();
    return (name: string, input: unknown, sourcePath?: string): BackgroundAdmission | undefined => {
        try {
            if (name !== "bg_task" && name !== "bg_status" && ![
                "bg_task_spawn", "bg_task_watch", "bg_task_list", "bg_task_status", "bg_task_log", "bg_task_stop",
            ].includes(name)) return;
            const launch = isBackgroundLaunch(name, input);
            const executionControls = launch && requiresExecutionControls();
            const expected: BackgroundAdmission = launch ? "local-launch" : "registry";
            const action = (input as { action?: unknown } | null)?.action;
            if ((name === "bg_task" || name === "bg_status") && !launch &&
                (typeof action !== "string" || !["list", "status", "log", "stop", "clear"].includes(action))) return;
            const tool = pi.getAllTools().find((candidate) => candidate.name === name);
            const source = tool?.sourceInfo?.path;
            if (!source || !isAbsolute(source) || !trusted.has(realpathSync(source)) ||
                (sourcePath !== undefined && sourcePath !== source)) return;
            let admission: BackgroundAdmission | undefined;
            // No cache: late loads and reloads must prove the current registration.
            // The bus proves compatibility only. Source and schema identity tie the
            // reply to the owning registration, just like the shared task guard.
            pi.events.emit(REQUEST_CHANNEL, {
                version: VERSION, name, input, executionControls,
                reply(value: unknown) {
                    const reply = value as { version?: unknown; parameters?: unknown; admission?: unknown; executionControls?: unknown } | null;
                    if (reply?.version === VERSION && reply.parameters === tool.parameters &&
                        reply.admission === expected && (!executionControls || reply.executionControls === 1)) {
                        admission = expected;
                    }
                },
            });
            const current = pi.getAllTools().find((candidate) => candidate.name === name);
            if (current?.parameters !== tool.parameters || current?.sourceInfo?.path !== source) return;
            return admission;
        } catch { return undefined; }
    };
}
