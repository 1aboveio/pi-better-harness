// Generated canonical terminal publication. Do not edit directly.
import { existsSync, statSync } from "node:fs";
import { taskDeadline } from "./shared-operation-coordinator/src/task-lifetime.mjs";
function terminalOutcome(status) {
    switch (status) {
        case "succeeded": return "succeeded";
        case "cancelled": return "cancelled";
        case "lost": return "lost";
        default: return "failed";
    }
}
function evidenceFor(inspection) {
    const paths = inspection.logs;
    const evidence = [];
    const result = inspection.result;
    const lost = inspection.lost;
    const terminalRef = result ? "result.json" : "lost.json";
    const summary = result
        ? `status=${result.status} exit=${result.exitCode ?? "null"} timedOut=${result.timedOut ? "true" : "false"}${result.groupCleanup ? ` groupCleanup=${result.groupCleanup}` : ""}`
        : `status=lost detailLost=true`;
    evidence.push({
        operationId: "",
        terminalRevision: 0,
        kind: "terminal-record",
        ref: terminalRef,
        summary,
        detailLost: !result,
    });
    for (const [label, path] of [["stdout", paths.stdout], ["stderr", paths.stderr]]) {
        try {
            const size = existsSync(path) ? statSync(path).size : 0;
            if (size <= 0)
                continue;
            evidence.push({
                operationId: "",
                terminalRevision: 0,
                kind: "log",
                ref: path,
                summary: `${label} retained (${size} bytes)`,
                detailLost: false,
            });
        }
        catch { /* a reclaimed log costs detail, never the outcome */ }
    }
    return evidence;
}
/** Shared terminal publication contract for the host and fixed server cancel adapter. */
export function supervisorTerminalPublication(operation, inspection, refs = evidenceFor(inspection)) {
    const status = inspection.status;
    const endedAt = inspection.result?.endedAt ?? inspection.lost?.recordedAt;
    const expired = endedAt !== undefined && endedAt >= taskDeadline(Math.min(operation.createdAt, inspection.launch.createdAt));
    const outcome = expired ? "failed" : terminalOutcome(status);
    return {
        operationId: operation.operationId,
        eventId: `${operation.taskId}:${inspection.result?.endedAt ?? inspection.lost?.recordedAt ?? inspection.observedAt}:${status}`,
        outcome, owner: operation.owner,
        evidence: refs.map(ref => ({ kind: ref.kind, ref: ref.ref, ...(ref.summary ? { summary: ref.summary } : {}), detailLost: ref.detailLost })),
        ...(outcome === "lost" ? { detailLost: true } : {}),
        reason: expired ? "24-hour task lifetime exceeded" : inspection.result ? `supervisor ${status} exit=${inspection.result.exitCode ?? "null"}` : "supervisor lost: no terminal evidence",
    };
}
