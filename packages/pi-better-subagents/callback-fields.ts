/**
 * Model-facing content fields for subagent callbacks (#312).
 *
 * index.ts spreads these into the shared callback batcher together with its
 * delivery/receipt closures, so the payload builders here are the production
 * ones. The measurement harness feeds the same fields through the real
 * batcher to capture actual delivered content.
 */
import type { CallbackBatchEvent, UrgentCallbackEvent } from "./shared-callback-batcher.ts";
import { activeFailures, formatFailureLines, type FailureState } from "./shared-failure-observations.ts";
import type { RunMeta } from "./registry.ts";

export function runLabel(meta: Pick<RunMeta, "id" | "name">): string {
    return meta.name ? `${meta.name} (${meta.id})` : meta.id;
}

type CompletionFields = Pick<CallbackBatchEvent,
    "source" | "id" | "label" | "status" | "detailTool" | "outcome" | "failureRows" | "incidentCount">;

type UrgentFields = Pick<UrgentCallbackEvent,
    "source" | "id" | "label" | "status" | "customType" | "content" | "detailTool" | "failureRows" | "incidentCount">;

/** Ordinary terminal completion: outcome plus every active incident row for exact counting. */
export function completionCallbackFields(meta: RunMeta, state: FailureState): CompletionFields {
    const unresolved = Object.values(state.observations).filter((observation) => observation.status === "unresolved");
    const observationStatus = unresolved.some((observation) => observation.category === "observation-incomplete")
        ? "observation incomplete" : unresolved.length ? "unresolved failure observations" : undefined;
    const active = activeFailures(state);
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status: observationStatus ? `${meta.status}; ${observationStatus}` : meta.status,
        detailTool: "subagent_result",
        outcome: meta.status,
        failureRows: active.length ? formatFailureLines(state) : undefined,
        incidentCount: active.length || undefined,
    };
}

/** Orphaned/lost health transition: the ATTENTION explanation plus incident rows. */
export function healthCallbackFields(meta: RunMeta, status: "orphaned" | "lost", state: FailureState, content: string): UrgentFields {
    const rows = formatFailureLines(state);
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status,
        customType: "subagent-health",
        content,
        detailTool: "subagent_result",
        failureRows: rows.length ? rows : undefined,
        incidentCount: rows.length || undefined,
    };
}

/** Running/orphaned failure attention: why attention is needed plus incident rows. */
export function failureAttentionFields(meta: RunMeta, state: FailureState, pending: { key: string; incidents: string[] }): UrgentFields {
    const rows = formatFailureLines(state);
    const due = pending.incidents.length;
    return {
        source: "subagent",
        id: meta.id,
        label: runLabel(meta),
        status: `failure:${pending.key}`,
        customType: "subagent-failure",
        content: `Subagent ${meta.id} (${meta.status}) has ${due} unresolved failure observation${due === 1 ? "" : "s"} that need attention.`,
        detailTool: "subagent_result",
        failureRows: rows,
        incidentCount: rows.length || undefined,
    };
}
