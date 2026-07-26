import type { ParsedRun } from "./parse.ts";
import type { RunMeta, RunStatus } from "./registry.ts";

/** Named lifecycle quality for a finished (or terminal) subagent run. */
export type LifecycleClassification =
    | "complete"
    | "incomplete_no_terminal_event"
    | "incomplete_open_tools"
    | "failed_exit"
    | "killed"
    | "timed_out"
    | "orphaned"
    | "lost";

export interface LifecycleDiagnostics {
    /** Whether the child log contained agent_end or agent_settled. */
    sawTerminalEvent: boolean;
    /** Count of tool starts without a matching end. */
    unmatchedToolCount: number;
    /** Human-readable unmatched tool summary (empty when none). */
    unmatchedTools: string[];
    /** Process exit code when known. */
    exitCode: number | null | undefined;
    /** Durable run status when known. */
    status?: RunStatus | "exited";
}

export interface LifecycleValidation {
    classification: LifecycleClassification;
    /** True when exit-0 stream coherence failed (incomplete_* classes). */
    incomplete: boolean;
    diagnostics: LifecycleDiagnostics;
    /** Short human summary for callbacks / headers. */
    summary: string;
}

export interface ChildExitOutcome {
    status: "completed" | "failed";
    incomplete: boolean;
    classification: LifecycleClassification;
    diagnostics: LifecycleDiagnostics;
    verdict: string;
}

function unmatchedToolLabels(run: ParsedRun): string[] {
    return run.unmatchedToolCalls.map((call) =>
        call.id ? `${call.toolName} (${call.id})` : call.toolName,
    );
}

function buildDiagnostics(
    run: ParsedRun,
    exitCode: number | null | undefined,
    status?: RunStatus | "exited",
): LifecycleDiagnostics {
    return {
        sawTerminalEvent: run.sawEnd,
        unmatchedToolCount: run.unmatchedToolCalls.length,
        unmatchedTools: unmatchedToolLabels(run),
        exitCode,
        status,
    };
}

/** Classify a child process exit before persisting its run metadata. */
export function classifyChildExit(code: number | null, run: ParsedRun): ChildExitOutcome {
    const diagnostics = buildDiagnostics(run, code);
    const exitedSuccessfully = code === 0 || code === null;

    if (!exitedSuccessfully) {
        return {
            status: "failed",
            incomplete: false,
            classification: "failed_exit",
            diagnostics,
            verdict: `✗ failed (exit ${code})`,
        };
    }

    if (!run.sawEnd) {
        return {
            status: "failed",
            incomplete: true,
            classification: "incomplete_no_terminal_event",
            diagnostics,
            verdict: `! incomplete child exit (exit ${code})`,
        };
    }

    if (run.unmatchedToolCalls.length > 0) {
        return {
            status: "failed",
            incomplete: true,
            classification: "incomplete_open_tools",
            diagnostics,
            verdict: `! incomplete child exit (exit ${code})`,
        };
    }

    return {
        status: "completed",
        incomplete: false,
        classification: "complete",
        diagnostics,
        verdict: "✓ completed",
    };
}

/**
 * Resolve lifecycle validation for any terminal/persisted run.
 * Prefer a stored classification when present; otherwise derive from status + log.
 */
export function resolveLifecycle(
    meta: Pick<RunMeta, "status" | "exitCode" | "failureReason" | "lifecycleClassification">,
    run: ParsedRun,
): LifecycleValidation {
    const diagnostics = buildDiagnostics(run, meta.exitCode, meta.status);

    if (meta.status === "killed") {
        return {
            classification: "killed",
            incomplete: false,
            diagnostics,
            summary: "run was stopped (killed)",
        };
    }

    if (meta.lifecycleClassification) {
        // Never trust a stored "complete" without re-checking stream evidence.
        // Fresh finalization and result formatting both require current log authority.
        if (meta.lifecycleClassification === "complete") {
            const exitCode = meta.exitCode === undefined ? 0 : meta.exitCode;
            const outcome = classifyChildExit(exitCode, run);
            return {
                classification: outcome.classification,
                incomplete: outcome.incomplete,
                diagnostics,
                summary: summaryFor(outcome.classification),
            };
        }
        const classification = meta.lifecycleClassification;
        const incomplete = classification === "incomplete_no_terminal_event"
            || classification === "incomplete_open_tools";
        return {
            classification,
            incomplete,
            diagnostics,
            summary: summaryFor(classification),
        };
    }

    // Backward-compatible derivation for older meta without lifecycleClassification.
    // Never trust a bare "completed" status alone — re-validate against log evidence
    // so pre-#86 false-completed records cannot render as clean final answers.
    if (meta.failureReason === "incomplete-stream") {
        const classification = !run.sawEnd
            ? "incomplete_no_terminal_event"
            : "incomplete_open_tools";
        return {
            classification,
            incomplete: true,
            diagnostics,
            summary: summaryFor(classification),
        };
    }

    if (meta.status === "completed" || meta.status === "failed") {
        const exitCode = meta.exitCode === undefined ? 0 : meta.exitCode;
        const outcome = classifyChildExit(exitCode, run);
        // Preserve distinct killed path above; here only completed/failed remain.
        // Nonzero exits stay failed_exit even if status was mis-recorded completed.
        return {
            classification: outcome.classification,
            incomplete: outcome.incomplete,
            diagnostics,
            summary: summaryFor(outcome.classification),
        };
    }

    // running / exited fallbacks — not clean completion.
    return {
        classification: "lost",
        incomplete: false,
        diagnostics,
        summary: summaryFor("lost"),
    };
}

function summaryFor(classification: LifecycleClassification): string {
    switch (classification) {
        case "complete":
            return "lifecycle complete";
        case "incomplete_no_terminal_event":
            return "lifecycle incomplete_no_terminal_event — no agent_end/agent_settled";
        case "incomplete_open_tools":
            return "lifecycle incomplete_open_tools — unmatched tool executions remain";
        case "failed_exit":
            return "lifecycle failed_exit";
        case "killed":
            return "lifecycle killed";
        case "timed_out":
            return "lifecycle timed_out";
        case "orphaned":
            return "lifecycle orphaned";
        case "lost":
            return "lifecycle lost";
    }
}

/** Render diagnostics block shared by incomplete and general result formatting. */
export function formatLifecycleDiagnostics(lifecycle: LifecycleValidation): string {
    const d = lifecycle.diagnostics;
    const unmatched = d.unmatchedTools.length
        ? d.unmatchedTools.join(", ")
        : "none";
    return [
        `Lifecycle: ${lifecycle.classification}`,
        `Lifecycle diagnostics: terminal event: ${d.sawTerminalEvent ? "yes" : "no"}; unmatched tools: ${unmatched}; exit: ${d.exitCode === undefined ? "?" : String(d.exitCode)}`,
    ].join("\n");
}

/** Render the evidence for a child that exited before producing a final answer. */
export function formatIncompleteResult(
    run: ParsedRun,
    rawLogTail: string,
    lifecycle?: LifecycleValidation,
): string {
    const validation = lifecycle ?? {
        classification: !run.sawEnd ? "incomplete_no_terminal_event" as const : "incomplete_open_tools" as const,
        incomplete: true,
        diagnostics: buildDiagnostics(run, undefined),
        summary: !run.sawEnd
            ? summaryFor("incomplete_no_terminal_event")
            : summaryFor("incomplete_open_tools"),
    };
    const evidence = [
        !run.sawEnd ? "no agent_end or agent_settled event" : "terminal event observed",
        run.unmatchedToolCalls.length
            ? `unmatched tools: ${unmatchedToolLabels(run).join(", ")}`
            : "no unmatched tools",
    ].join("; ");
    const bestAvailable = run.finalText || run.lastActivity || "(no parsed assistant output)";
    return [
        "Run ended unexpectedly before producing a coherent final result.",
        formatLifecycleDiagnostics(validation),
        `Stream evidence: ${evidence}.`,
        "",
        "--- best available parsed output ---",
        bestAvailable,
        "",
        "--- raw log tail ---",
        rawLogTail,
    ].join("\n");
}

/** Best-effort parsed body shared by incomplete / orphaned / lost diagnostics. */
function bestParsedOutput(run: ParsedRun): string {
    return run.finalText || run.lastActivity || "(no parsed assistant output)";
}

/**
 * Non-final diagnostic for an orphaned run (#65).
 * Supervision is broken; related process-group work may still be alive.
 * Surfaces best-CURRENT artifacts without pretending the run finished.
 */
export function formatOrphanedResult(run: ParsedRun, rawLogTail: string): string {
    return [
        "Run is orphaned — non-final. Supervision was lost; related processes may still be alive.",
        "There is no final result yet. Best-current artifacts below (output may still change).",
        "",
        "--- best-current parsed output ---",
        bestParsedOutput(run),
        "",
        "--- raw log tail ---",
        rawLogTail,
    ].join("\n");
}

/**
 * Terminal-unknown diagnostic for a lost run (#65).
 * No related process remains and no coherent terminal completion was observed.
 * Surfaces best-AVAILABLE artifacts without claiming normal completion/failure.
 */
export function formatLostResult(run: ParsedRun, rawLogTail: string): string {
    return [
        "Run is lost: no related process remains and no coherent terminal completion was observed.",
        "This is a terminal unknown outcome, not a normal failure. Best-available artifacts below.",
        "",
        "--- best-available parsed output ---",
        bestParsedOutput(run),
        "",
        "--- raw log tail ---",
        rawLogTail,
    ].join("\n");
}

export interface FormatSubagentResultInput {
    id: string;
    status: string;
    exitCode: string | number;
    statSeg: string;
    toolsSeg: string;
    run: ParsedRun;
    rawLogTail: string;
    lifecycle: LifecycleValidation;
}

/**
 * Format `subagent_result` body. Incomplete classifications never present
 * progress text as a clean final answer; all paths include lifecycle diagnostics.
 * Lost runs use the dedicated #65 diagnostic so best-available artifacts stay
 * consistent with the registered tool path.
 */
export function formatSubagentResult(input: FormatSubagentResultInput): string {
    const { id, status, exitCode, statSeg, toolsSeg, run, rawLogTail, lifecycle } = input;
    const head = `[${id} · ${status} · exit ${exitCode}${statSeg}${toolsSeg} · lifecycle ${lifecycle.classification}]`;
    if (lifecycle.incomplete) {
        return `${head}\n${formatIncompleteResult(run, rawLogTail, lifecycle)}`;
    }
    // Terminal lost: dedicated diagnostic + best-available artifacts (#65).
    if (status === "lost" || lifecycle.classification === "lost") {
        return `${head}\n${formatLostResult(run, rawLogTail)}`;
    }
    const body = run.finalText
        || (run.lastActivity
            ? `(no final answer parsed; latest activity)\n${run.lastActivity}`
            : `(no final answer parsed)\n\n--- raw log tail ---\n${rawLogTail}`);
    return [
        head,
        formatLifecycleDiagnostics(lifecycle),
        body,
    ].join("\n");
}
