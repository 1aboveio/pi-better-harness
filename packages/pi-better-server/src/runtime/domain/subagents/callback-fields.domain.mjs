// Generated fixed launch domain from packages/pi-better-subagents/callback-fields.ts. Do not edit directly.
import { activeFailures, pendingAttentionNote, pendingAttentionRows, requiresAction, terminalFailureParts } from "./shared-failure-observations.domain.mjs";
import { describeTiming } from "./timing.domain.mjs";
export function runLabel(meta) {
    return meta.name ? `${meta.name} (${meta.id})` : meta.id;
}
/**
 * Lifecycle, current actionability, and retained history are separate facts (#315). Rows are the
 * actionable/incomplete incidents among `incidents` (the terminal pending set), counted exactly;
 * unclassified tool failures, expected failures, closed history, and earlier deliveries are counts.
 */
function terminalFields(state, incidents) {
    const { rows, notes } = terminalFailureParts(state, incidents);
    return { failureRows: rows.length ? rows : undefined, incidentCount: rows.length || undefined, notes };
}
function observationStatus(state) {
    const active = activeFailures(state);
    return [
        active.some((observation) => requiresAction(observation)) ? "action required" : "",
        active.some((observation) => observation.category === "observation-incomplete") ? "observation incomplete" : "",
    ].filter(Boolean).join("; ") || undefined;
}
/** Ordinary terminal completion: outcome, pending actionable rows, and history as counts. */
export function completionCallbackFields(meta, state, incidents = []) {
    const status = observationStatus(state);
    const { failureRows, incidentCount, notes } = terminalFields(state, incidents);
    // Harness timing reason (deadline / ceiling / stuck) is a lifecycle fact, shown next to the status.
    const timing = describeTiming({ ...meta, status: meta.status });
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status: [meta.status, timing?.short, status].filter(Boolean).join("; "),
        detailTool: "subagent_result",
        outcome: meta.status,
        failureRows,
        ...(notes.length ? { decision: notes.join(" ") } : {}),
        incidentCount,
    };
}
/** Orphaned/lost health transition: the ATTENTION explanation, pending actionable rows, history as counts. */
export function healthCallbackFields(meta, status, state, content, incidents = []) {
    const { failureRows, incidentCount, notes } = terminalFields(state, incidents);
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status,
        customType: "subagent-health",
        content: notes.length ? `${content}\n${notes.join(" ")}` : content,
        detailTool: "subagent_result",
        failureRows,
        incidentCount,
    };
}
/** Running/orphaned failure attention: exactly the pending incidents; earlier ones are counted, never repeated. */
export function failureAttentionFields(meta, state, pending) {
    const rows = pendingAttentionRows(state, pending.incidents);
    const note = pendingAttentionNote(state, pending.incidents);
    const due = rows.length;
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status: `failure:${pending.key}`,
        customType: "subagent-failure",
        content: `Subagent ${meta.id} (${meta.status}) has ${due} failure observation${due === 1 ? "" : "s"} that need attention.${note ? ` ${note}` : ""}`,
        detailTool: "subagent_result",
        failureRows: rows,
        incidentCount: due || undefined,
    };
}
