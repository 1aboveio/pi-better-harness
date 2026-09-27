/**
 * Model-facing content fields for subagent callbacks (#312).
 *
 * index.ts spreads these into the shared callback batcher together with its
 * delivery/receipt closures, so the payload builders here are the production
 * ones. The measurement harness feeds the same fields through the real
 * batcher to capture actual delivered content.
 */
import type { CallbackBatchEvent, UrgentCallbackEvent } from "./shared-callback-batcher.ts";
import { activeFailures, pendingAttentionNote, pendingAttentionRows, requiresAction, terminalFailureParts,
    type FailureState } from "./shared-failure-observations.ts";
import type { RunMeta } from "./registry.ts";
import { describeTiming } from "./timing.ts";

export function runLabel(meta: Pick<RunMeta, "id" | "name">): string {
    return meta.name ? `${meta.name} (${meta.id})` : meta.id;
}

type CompletionFields = Pick<CallbackBatchEvent,
    "source" | "id" | "label" | "status" | "detailTool" | "outcome" | "failureRows" | "decision" | "incidentCount">;

type UrgentFields = Pick<UrgentCallbackEvent,
    "source" | "id" | "label" | "status" | "customType" | "content" | "detailTool" | "failureRows" | "incidentCount">;

/**
 * Lifecycle, current actionability, and retained history are separate facts (#315). Rows are the
 * actionable/incomplete incidents among `incidents` (the terminal pending set), counted exactly;
 * unclassified tool failures, expected failures, closed history, and earlier deliveries are counts.
 */
function terminalFields(state: FailureState, incidents: readonly string[]) {
    const { rows, notes } = terminalFailureParts(state, incidents);
    return { failureRows: rows.length ? rows : undefined, incidentCount: rows.length || undefined, notes };
}

function observationStatus(state: FailureState): string | undefined {
    const active = activeFailures(state);
    return [
        active.some((observation) => requiresAction(observation)) ? "action required" : "",
        active.some((observation) => observation.category === "observation-incomplete") ? "observation incomplete" : "",
    ].filter(Boolean).join("; ") || undefined;
}

/** Ordinary terminal completion: outcome, pending actionable rows, and history as counts. */
export function completionCallbackFields(meta: RunMeta, state: FailureState, incidents: readonly string[] = []): CompletionFields {
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
export function healthCallbackFields(meta: RunMeta, status: "orphaned" | "lost", state: FailureState, content: string,
    incidents: readonly string[] = []): UrgentFields {
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
export function failureAttentionFields(meta: RunMeta, state: FailureState, pending: { key: string; incidents: string[] }): UrgentFields {
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
