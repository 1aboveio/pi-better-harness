/**
 * First-party finalization + result assembly for child exits.
 *
 * Kept free of the pi host package so tests can execute the real
 * parser/classifier/registry/callback path against durable run metadata.
 */

import { buildCompletionDelivery } from "./completion.ts";
import { collectRunFailures, failurePath } from "./failures.ts";
import { observeFailures } from "./shared-failure-observations.ts";
import { commitAssignmentTerminal } from "./assignment-outcomes.ts";
import {
    classifyChildExit,
    type ChildExitOutcome,
} from "./lifecycle.ts";
import { assembleSubagentResult } from "./output-payload.ts";
import { parseRunForLifecycle } from "./parse.ts";
import {
    canExitFinalize,
    effectiveStatus,
    isFinalResultStatus,
    readMeta,
    updateParkRecord,
    writeMeta,
    type RunMeta,
} from "./registry.ts";
import { fmtElapsed, fmtSpend } from "./widget.ts";
import { evaluateParkDisposition, type ParkDisposition } from "./worker-waits.ts";

export interface FinalizeHooks {
    renderWidget?: () => void;
    notify?: (message: string, level: "info" | "warning") => void;
    sendMessage?: (
        message: { customType: string; content: string; display: boolean },
        options: Record<string, unknown>,
    ) => void;
}

export interface FinalizeResult {
    applied: boolean;
    meta?: RunMeta;
    outcome?: ChildExitOutcome;
    delivery?: { content: string; options: Record<string, unknown> };
    /** Present when this exit was a park or looked like one but could not be proven. */
    park?: ParkDisposition;
}

/**
 * Finalize a run once its child exits. Idempotent: a run already marked
 * terminal is left alone. Persists lifecycle classification + failureReason
 * and builds the completion callback delivery from real log evidence.
 */
export function finalizeRun(
    id: string,
    code: number | null,
    hooks: FinalizeHooks = {},
): FinalizeResult {
    const meta = readMeta(id);
    // Coherent child-exit evidence may supersede provisional orphaned/lost
    // reconciliation, but never overwrites a true terminal record.
    if (!meta || !canExitFinalize(meta.status)) return { applied: false };

    // Lifecycle authority streams the complete NDJSON log; result text stays bounded.
    const r = parseRunForLifecycle(id);
    const outcome = classifyChildExit(code, r);
    collectRunFailures(id, meta.cwd, true);
    // A run can now end exit 0 as failed (a final request the model could not
    // serve), so "not incomplete and has an exit code" no longer means success.
    const completed = outcome.status === "completed";
    if (completed && code !== null) {
        observeFailures(failurePath(id), ["orphaned", "lost"].map((status) => ({
            id: `supervision:${status}:exit-recovered`, operation: `supervision:${status}`,
            kind: "recovered" as const, incidents: [`supervision:${status}`],
        })));
    }
    if (!completed) {
        const summary = outcome.incomplete ? "Child exit evidence is incomplete"
            : outcome.diagnostics.modelError ? `Child exited with code ${code}: ${outcome.diagnostics.modelError}`
            : `Child exited with code ${code}`;
        observeFailures(failurePath(id), [{ id: `exit:${code ?? "unknown"}:${outcome.classification}`,
            operation: "child-exit", kind: outcome.incomplete ? "incomplete" : "failure",
            category: "exit", summary }]);
    }
    meta.status = outcome.status;
    meta.lifecycleClassification = outcome.classification;
    if (outcome.incomplete) meta.failureReason = "incomplete-stream";
    meta.exitCode = code;
    meta.endedAt = Date.now();
    // A clean park finishes this ATTEMPT, not the assignment. It is only accepted
    // with a durable park record whose saved-conversation checkpoint still
    // verifies; a failed, incoherent or unverifiable exit stays an ordinary exit
    // and the recorded wait is held for its owner.
    const park = evaluateParkDisposition({
        runId: id,
        cleanExit: code === 0 && !outcome.incomplete && !outcome.diagnostics.modelError,
    });
    const parked = park.parked && park.record !== undefined;
    if (parked && park.record) {
        meta.park = park.record;
        // The rest of the attempt is complete; the assignment is still waiting.
        meta.status = "completed";
    }
    const callback = meta.callback !== false;
    if (callback
        && meta.completionCallbackPendingAt === undefined
        && meta.completionCallbackSentAt === undefined
        && meta.completionCallbackSuppressedAt === undefined) {
        if (parked) {
            // A parked attempt owes no completion callback: the continuation
            // resumes the same conversation and reports the assignment's result.
            meta.completionCallbackSuppressedAt = meta.endedAt;
            meta.completionCallbackSuppressedReason = `parked on wait ${park.record?.waitId} generation ${park.record?.generation}`;
        } else {
            meta.completionCallbackPendingAt = meta.endedAt;
        }
    }
    writeMeta(meta);
    commitAssignmentTerminal(meta);
    if (!parked && park.record) {
        // A park disposition existed but could not be proven on exit. Hold it in
        // both durable copies (park.json + metadata) so nothing resumes it; the
        // host wrapper reports the same state to the coordinator.
        updateParkRecord(id, {
            phase: "held",
            heldReason: park.reason ?? "the exit was not a clean park",
        });
    }

    const label = meta.name ? `${meta.name} (${id})` : id;
    const verdict = parked
        ? `parked · waiting for ${park.record?.waitId ?? "its dependency"}`
        : outcome.verdict;
    const el = fmtElapsed(meta.endedAt - meta.startedAt);
    const spend = fmtSpend(r.usage);
    const humanStat = `${el}${spend ? ` · ${spend}` : ""}`;
    const stat = el;

    // A finished run is no longer in the widget; redraw (and stop the ticker if
    // it was the last one).
    hooks.renderWidget?.();

    // Best-effort human toast. ctx may be stale by now; never let it throw.
    try {
        hooks.notify?.(
            `Subagent ${label} ${parked ? verdict : `${verdict} · ${humanStat}`}`,
            meta.status === "completed" || parked ? "info" : "warning",
        );
    } catch {
        /* ignore */
    }

    // buildCompletionDelivery remains the compatibility formatter for callers and
    // direct finalizer tests. Production callback:true delivery is coalesced by the
    // host wrapper; callback:false never invokes a model-message hook.
    const delivery = buildCompletionDelivery({
        id,
        label,
        verdict,
        stat,
        callback,
        incomplete: outcome.incomplete,
        lifecycleClassification: outcome.classification,
        resultText: r.finalText || r.lastActivity || "",
    });
    // A parked attempt sends nothing to the model: its assignment is still open
    // and the same conversation resumes to interpret the result.
    if (callback && !parked) {
        hooks.sendMessage?.(
            { customType: "subagent-complete", content: delivery.content, display: true },
            delivery.options,
        );
    }

    return {
        applied: true,
        meta: readMeta(id),
        outcome,
        delivery,
        ...(park.parked || park.record ? { park } : {}),
    };
}

/**
 * Assemble the user-visible `subagent_result` body from durable meta + log.
 * Returns null when the run is still live so the tool can emit its running message.
 */
export function buildSubagentResultText(id: string): string | null {
    return buildSubagentResultPayload(id);
}

/** Optional paging/raw evidence for the registered result tool. */
export function buildSubagentResultPayload(
    id: string,
    request?: { cursor?: string; maxBytes?: unknown; mode?: unknown; all?: unknown; lines?: unknown; include?: unknown; history?: unknown; tail?: unknown },
    healthLine = "",
    scopeKey = `parent:${process.pid}`,
): string | null {
    const meta = readMeta(id);
    if (!meta) throw new Error(`Unknown run id: ${id}`);
    const st = effectiveStatus(meta);
    if (!isFinalResultStatus(st)) return null;
    return assembleSubagentResult(id, meta, request ?? {}, healthLine, scopeKey);
}
