/**
 * First-party finalization + result assembly for child exits.
 *
 * Kept free of the pi host package so tests can execute the real
 * parser/classifier/registry/callback path against durable run metadata.
 */

import { buildCompletionDelivery } from "./completion.ts";
import {
    classifyChildExit,
    formatSubagentResult,
    resolveLifecycle,
    type ChildExitOutcome,
} from "./lifecycle.ts";
import { parseRunForLifecycle, tailLog } from "./parse.ts";
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
    meta.status = outcome.status;
    meta.lifecycleClassification = outcome.classification;
    if (outcome.incomplete) meta.failureReason = "incomplete-stream";
    meta.exitCode = code;
    meta.endedAt = Date.now();
    writeMeta(meta);

    const label = meta.name ? `${meta.name} (${id})` : id;
    const verdict = outcome.verdict;
    const el = fmtElapsed(meta.endedAt - meta.startedAt);
    const spend = fmtSpend(r.usage);
    const stat = `${el}${spend ? ` · ${spend}` : ""}`;
    const tools = r.toolCalls.length ? r.toolCalls.join(", ") : undefined;

    // A finished run is no longer in the widget; redraw (and stop the ticker if
    // it was the last one).
    hooks.renderWidget?.();

    // Best-effort human toast. ctx may be stale by now; never let it throw.
    try {
        hooks.notify?.(
            `Subagent ${label} ${verdict} · ${stat}`,
            meta.status === "completed" ? "info" : "warning",
        );
    } catch {
        /* ignore */
    }

    const callback = meta.callback !== false; // default: trigger completion
    // buildCompletionDelivery is the single place sendMessage content/options are
    // assembled. resultText is accepted here so callers/tests can pass it without
    // breaking, but it is NEVER put into content — the result lives in subagent_result.
    const delivery = buildCompletionDelivery({
        id,
        label,
        verdict,
        stat,
        tools,
        callback,
        incomplete: outcome.incomplete,
        lifecycleClassification: outcome.classification,
        resultText: r.finalText || r.lastActivity || "",
    });
    hooks.sendMessage?.(
        { customType: "subagent-complete", content: delivery.content, display: true },
        delivery.options,
    );

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
    const meta = readMeta(id);
    if (!meta) throw new Error(`Unknown run id: ${id}`);
    const st = effectiveStatus(meta);
    // Non-final statuses (running / orphaned) have no final result body.
    if (!isFinalResultStatus(st)) return null;

    const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
    // Re-derive lifecycle diagnostics from the complete stream even when meta is stale.
    const r = parseRunForLifecycle(id);
    const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
    const spend = fmtSpend(r.usage);
    const statSeg = ` · ${el}${spend ? ` · ${spend}` : ""}`;
    const tools = r.toolCalls.length ? ` · tools: ${r.toolCalls.join(", ")}` : "";
    const lifecycle = resolveLifecycle(meta, r);
    return formatSubagentResult({
        id,
        status: st,
        exitCode: exit,
        statSeg,
        toolsSeg: tools,
        run: r,
        rawLogTail: tailLog(id, 40),
        lifecycle,
    });
}
