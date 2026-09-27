/**
 * First-party finalization + result assembly for child exits.
 *
 * Kept free of the pi host package so tests can execute the real
 * parser/classifier/registry/callback path against durable run metadata.
 */

import { buildCompletionDelivery } from "./completion.ts";
import { collectRunFailures, failurePath } from "./failures.ts";
import { observeFailures } from "./shared-failure-observations.ts";
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
    writeMeta,
    type RunMeta,
} from "./registry.ts";
import { fmtElapsed, fmtSpend } from "./widget.ts";

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
    if (!outcome.incomplete && code !== null) {
        observeFailures(failurePath(id), ["orphaned", "lost"].map((status) => ({
            id: `supervision:${status}:exit-recovered`, operation: `supervision:${status}`,
            kind: "recovered" as const, incidents: [`supervision:${status}`],
        })));
    }
    if (code !== 0 || outcome.incomplete) {
        observeFailures(failurePath(id), [{ id: `exit:${code ?? "unknown"}:${outcome.classification}`,
            operation: "child-exit", kind: outcome.incomplete ? "incomplete" : "failure",
            category: "exit", summary: outcome.incomplete ? "Child exit evidence is incomplete" : `Child exited with code ${code}` }]);
    }
    meta.status = outcome.status;
    meta.lifecycleClassification = outcome.classification;
    if (outcome.incomplete) meta.failureReason = "incomplete-stream";
    meta.exitCode = code;
    meta.endedAt = Date.now();
    const callback = meta.callback !== false;
    if (callback
        && meta.completionCallbackPendingAt === undefined
        && meta.completionCallbackSentAt === undefined
        && meta.completionCallbackSuppressedAt === undefined) {
        meta.completionCallbackPendingAt = meta.endedAt;
    }
    writeMeta(meta);

    const label = meta.name ? `${meta.name} (${id})` : id;
    const verdict = outcome.verdict;
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
            `Subagent ${label} ${verdict} · ${humanStat}`,
            meta.status === "completed" ? "info" : "warning",
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
    if (callback) {
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
    request?: { cursor?: string; maxBytes?: unknown; mode?: unknown; all?: unknown },
    healthLine = "",
    scopeKey = `parent:${process.pid}`,
): string | null {
    const meta = readMeta(id);
    if (!meta) throw new Error(`Unknown run id: ${id}`);
    const st = effectiveStatus(meta);
    if (!isFinalResultStatus(st)) return null;
    return assembleSubagentResult(id, meta, request ?? {}, healthLine, scopeKey);
}
