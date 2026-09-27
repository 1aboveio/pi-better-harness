/**
 * Model-facing subagent payloads (#312).
 *
 * One assembler path for list / output / result / raw evidence. Budgets,
 * cursors, and envelopes come from shared log-utils; incident rendering and
 * paging come from shared failure-observations; lifecycle stays with its owner
 * (ADR 0006). Ordinary tool-name sequences and usage/cost boilerplate are
 * omitted. Every cursor is bound to the selected session scope.
 */

import { statSync } from "node:fs";
import {
    assemblePriorityEnvelope,
    budgetFor,
    cursorKind,
    formatUnchangedEvidence,
    inspectStatusRevision,
    OUTPUT_PAGE_DEFAULTS,
    pageRetainedFile,
    pageRows,
    pageVerbatimText,
    revisionOf,
    type EnvelopeFailure,
    type EvidenceGap,
    type VerbatimPage,
} from "./shared-log-utils.ts";
import { collectRunFailures } from "./failures.ts";
import {
    formatLifecycleDiagnostics,
    formatLostResult,
    formatOrphanedResult,
    resolveLifecycle,
    type LifecycleValidation,
} from "./lifecycle.ts";
import { parseRun, parseRunForLifecycle, type ParsedRun } from "./parse.ts";
import {
    belongsToOrigin,
    effectiveStatus,
    inspectRunMeta,
    logPathFor,
    originKey,
    originOf,
    type RunCallbackOrigin,
    type RunMeta,
} from "./registry.ts";
import {
    activeFailures,
    failureRevision,
    formatIncidentSummary,
    formatTerminalIncidentSummary,
    isIncidentCursor,
    requiresAction,
    pageFailureIncidents,
    type FailureState,
} from "./shared-failure-observations.ts";
import { fmtElapsed } from "./widget.ts";

export interface PayloadRequest {
    cursor?: string;
    maxBytes?: unknown;
    mode?: unknown;
    all?: unknown;
    lines?: unknown;
    tail_lines?: unknown;
    limit?: unknown;
}

export type LoadedRun =
    | { kind: "ok"; meta: RunMeta }
    | { kind: "missing" }
    | { kind: "unreadable"; detail: string };

export type SubagentToolSession = {
    /** Current session origin; `ctx` is the tool call's host context when available. */
    getActiveOrigin?: (ctx?: unknown) => RunCallbackOrigin | undefined;
};

/** Bytes of a continuation answer page left for the incident count line. */
const CONTINUATION_FAILURE_BYTES = 320;

function positiveInt(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(1, Math.floor(n));
}

function isAll(value: unknown): boolean {
    return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

/**
 * Distinguish a missing run from unreadable, corrupt, or absent metadata
 * beside retained run evidence (AC5). Only a run with neither metadata nor a
 * run directory is missing.
 */
export function loadRunRecord(id: string): LoadedRun {
    return inspectRunMeta(id);
}

export function isRawMode(mode: unknown): boolean {
    return String(mode ?? "").trim().toLowerCase() === "raw";
}

export function listScopeKey(
    all: boolean,
    origin: RunCallbackOrigin | undefined,
    parentPid: number,
    sessionAvailable = true,
): string {
    if (all) return "all";
    if (origin) return `session:${originKey(origin)}`;
    if (!sessionAvailable) return "session:unavailable";
    return `parent:${parentPid}`;
}

export function resolveActiveOrigin(session: SubagentToolSession | undefined): {
    origin?: RunCallbackOrigin;
    wired: boolean;
    available: boolean;
} {
    const wired = typeof session?.getActiveOrigin === "function";
    if (!wired) return { wired: false, available: false };
    const origin = session.getActiveOrigin?.();
    if (!origin) return { wired: true, available: false };
    return { origin, wired: true, available: true };
}

/** Scope key for a tool call, shared by list and direct reads. */
export function requestScopeKey(request: { all?: unknown }, session: SubagentToolSession | undefined, parentPid = process.pid): string {
    const resolved = resolveActiveOrigin(session);
    return listScopeKey(isAll(request.all), resolved.origin, parentPid, !(resolved.wired && !resolved.available));
}

/**
 * Current-session list scope. When session identity is wired but unavailable,
 * no run's ownership can be verified, so none is in the default scope.
 */
export function runInListScope(
    meta: RunMeta,
    options: { all?: boolean },
    origin: RunCallbackOrigin | undefined,
    parentPid: number,
    sessionAvailable = true,
): boolean {
    if (options.all) return true;
    if (origin) return ownership(meta, origin, parentPid) === "own";
    if (!sessionAvailable) return false;
    return meta.spawnPid === parentPid;
}

/**
 * Current-session ownership. Without a current session id, ownership is only
 * verified for a run this process launched with the same sessionless origin;
 * a legacy run with no recorded origin is never assumed to be ours.
 */
export function ownership(meta: RunMeta, origin: RunCallbackOrigin, parentPid = process.pid): "own" | "foreign" | "unavailable" {
    const recorded = meta.callbackOrigin;
    if (!origin.sessionId) {
        if (!recorded) return "unavailable";
        if (recorded.cwd === origin.cwd && !recorded.sessionId && meta.spawnPid === parentPid) return "own";
        return recorded.sessionId ? "foreign" : "unavailable";
    }
    if (belongsToOrigin(meta, origin)) return "own";
    return recorded ? "foreign" : "unavailable";
}

function logFacts(id: string): unknown {
    try {
        const stats = statSync(logPathFor(id));
        return [stats.dev, stats.ino, stats.size, Math.trunc(stats.mtimeMs)];
    } catch (error) {
        return ["unreadable", (error as NodeJS.ErrnoException).code ?? String(error)];
    }
}

/** Lifecycle metadata and log identity. A metadata-only transition is a change. */
function contentRevisionFor(id: string, meta: RunMeta): string {
    return revisionOf([
        meta.status,
        String(effectiveStatus(meta)),
        meta.exitCode ?? null,
        meta.endedAt ?? null,
        meta.lifecycleClassification ?? null,
        meta.failureReason ?? null,
        logFacts(id),
    ]);
}

function elapsedFor(meta: RunMeta, now = Date.now()): string {
    return fmtElapsed((meta.endedAt ?? now) - meta.startedAt);
}

function joinSections(parts: Array<string | undefined>): string | undefined {
    const text = parts.filter((part): part is string => Boolean(part && part.length > 0)).join("\n");
    return text.length > 0 ? text : undefined;
}

function resultIdentity(id: string, status: string, exitCode: string, elapsed: string, classification: string): string {
    return `[${id} · ${status} · exit ${exitCode} · ${elapsed} · lifecycle ${classification}]`;
}

function outputIdentity(id: string, status: string, elapsed: string): string {
    return `[${id} · ${status} · ${elapsed}]`;
}

function logGaps(id: string): EvidenceGap[] {
    try {
        statSync(logPathFor(id));
        return [];
    } catch (error) {
        return [{ kind: "read", detail: error instanceof Error ? error.message : String(error) }];
    }
}

function parserDiagnostics(run: ParsedRun): string | undefined {
    if (!run.diagnostics.length) return undefined;
    return `[parser: ${run.diagnostics.join("; ")}]`;
}

function retrievalHint(id: string): string {
    return `Retrieve retained evidence with subagent_output id="${id}" mode="raw" (16 KiB default, up to 64 KiB, caller cursor).`;
}

function bestParsed(run: ParsedRun): string {
    return run.finalText || run.lastActivity || "";
}

function isRoutineComplete(lifecycle: LifecycleValidation): boolean {
    return lifecycle.classification === "complete" && !lifecycle.incomplete;
}

function streamEvidence(run: ParsedRun): string {
    const parts = [
        !run.sawEnd ? "no agent_end or agent_settled event" : "terminal event observed",
        run.unmatchedToolCalls.length
            ? `unmatched tools: ${run.unmatchedToolCalls.map((call) => call.id ? `${call.toolName} (${call.id})` : call.toolName).join(", ")}`
            : "no unmatched tools",
    ];
    return `Stream evidence: ${parts.join("; ")}.`;
}

/** Per-call context: one failure-state read, scope-bound resources. */
interface CallContext {
    id: string;
    meta: RunMeta;
    request: PayloadRequest;
    scopeKey: string;
    state: FailureState;
    statusResource: string;
    statusCursor: string;
    /** Terminal runs present lifecycle-independent facts; running runs show prioritized rows (#315). */
    terminal: boolean;
}

function callContext(id: string, meta: RunMeta, request: PayloadRequest, scopeKey: string, surface: string, terminal: boolean): CallContext {
    const state = collectRunFailures(id, meta.cwd, terminal);
    const statusResource = `${surface}:${scopeKey}:${id}`;
    const statusCursor = inspectStatusRevision({
        resource: statusResource,
        contentRevision: contentRevisionFor(id, meta),
        failureRevision: failureRevision(state),
    }).nextCursor;
    return { id, meta, request, scopeKey, state, statusResource, statusCursor, terminal };
}

function incidentResource(ctx: CallContext): string {
    return `incidents:${ctx.scopeKey}:${ctx.id}`;
}

/**
 * Shared failure section: whole rows when they fit, otherwise exact counts plus a resuming cursor.
 * Terminal runs list only actionable/incomplete rows and count unclassified history (#315).
 */
function failureSection(ctx: CallContext, cap?: number): EnvelopeFailure | undefined {
    if (activeFailures(ctx.state).length === 0 && !ctx.terminal) return undefined;
    const summarize = ctx.terminal ? formatTerminalIncidentSummary : formatIncidentSummary;
    if (ctx.terminal && !summarize(ctx.state, { maxBytes: Number.MAX_SAFE_INTEGER }).text) return undefined;
    return (budget) => summarize(ctx.state, {
        maxBytes: cap === undefined ? budget : Math.min(budget, cap),
        resource: incidentResource(ctx),
        retrieval: `pass as cursor to subagent_result/subagent_output id="${ctx.id}"`,
    }).text || undefined;
}

function envelopeText(input: {
    maxBytes: number;
    identity?: string;
    failure?: EnvelopeFailure;
    decision?: string;
    diagnostics?: string;
    progress?: string;
    gaps?: EvidenceGap[];
    verbatim?: (remaining: number) => VerbatimPage;
    verbatimReserve?: number;
    statusCursor?: string;
}): string {
    return assemblePriorityEnvelope({
        maxBytes: input.maxBytes,
        sections: {
            identity: input.identity,
            failure: input.failure,
            decision: input.decision,
            diagnostics: input.diagnostics,
            progress: input.progress,
        },
        gaps: input.gaps,
        verbatim: input.verbatim,
        verbatimReserve: input.verbatimReserve,
        statusCursor: input.statusCursor,
    }).text;
}

function assembleIncidentPage(ctx: CallContext, identity: string): string {
    const maxBytes = budgetFor("answer", ctx.request.maxBytes);
    const total = activeFailures(ctx.state).length;
    return envelopeText({
        maxBytes,
        identity: `${identity} incident page of ${total} active failure observation${total === 1 ? "" : "s"}`,
        verbatim: (budget) => {
            const page = pageFailureIncidents(ctx.state, { cursor: ctx.request.cursor, maxBytes: budget, resource: incidentResource(ctx) });
            return {
                text: page.text || (page.total === 0 ? "No active failure observations." : ""),
                hasMore: page.hasMore,
                cursor: page.cursor,
                nextCursor: page.nextCursor,
                omittedBytes: 0,
                omittedRows: page.omitted,
                reset: page.reset,
            };
        },
        statusCursor: ctx.statusCursor,
    });
}

/** Caller-owned status cursor: unchanged → a small no-change response. */
function maybeUnchanged(ctx: CallContext, identity: string): string | undefined {
    const cursor = ctx.request.cursor;
    if (!cursor || cursorKind(cursor) !== "s") return undefined;
    const inspected = inspectStatusRevision({
        cursor,
        resource: ctx.statusResource,
        contentRevision: contentRevisionFor(ctx.id, ctx.meta),
        failureRevision: failureRevision(ctx.state),
    });
    if (inspected.change !== "none") return undefined;
    const active = activeFailures(ctx.state).length;
    return envelopeText({
        maxBytes: budgetFor("status", ctx.request.maxBytes),
        identity: `${identity} · unchanged`,
        failure: active ? `${active} active failure observation(s), unchanged.` : undefined,
        decision: formatUnchangedEvidence(cursor),
        statusCursor: inspected.nextCursor,
    });
}

/** Status-change facts for a status cursor that did not match. */
function changeDiagnostics(ctx: CallContext): string | undefined {
    const cursor = ctx.request.cursor;
    if (!cursor || cursorKind(cursor) !== "s") return undefined;
    const inspected = inspectStatusRevision({
        cursor,
        resource: ctx.statusResource,
        contentRevision: contentRevisionFor(ctx.id, ctx.meta),
        failureRevision: failureRevision(ctx.state),
    });
    if (inspected.change === "failure") return "change=failure";
    if (inspected.change === "reset") return "reset=stale-cursor (status cursor from another run, surface, or scope)";
    return "change=content";
}

/** Page cursor for answer/raw pagers; status cursors start a fresh page. */
function pageCursorFor(cursor: string | undefined): string | undefined {
    if (!cursor) return undefined;
    return cursorKind(cursor) === "s" ? undefined : cursor;
}

function isContinuationPage(cursor: string | undefined): boolean {
    return cursorKind(cursor) === "t";
}

function rawPage(ctx: CallContext, cursor: string | undefined, remaining: number): VerbatimPage {
    return pageRetainedFile(logPathFor(ctx.id), {
        cursor,
        maxBytes: remaining,
        resource: `raw:${ctx.scopeKey}:${ctx.id}`,
    });
}

function answerPage(ctx: CallContext, text: string, cursor: string | undefined, remaining: number, maxLines?: number): VerbatimPage {
    return pageVerbatimText(text, {
        cursor,
        maxBytes: remaining,
        maxLines,
        resource: `answer:${ctx.scopeKey}:${ctx.id}`,
    });
}

/** Answer pages keep half the budget on first pages and nearly all on continuations. */
function answerReserve(maxBytes: number, cursor: string | undefined): number {
    return isContinuationPage(cursor) ? maxBytes - CONTINUATION_FAILURE_BYTES : Math.floor(maxBytes / 2);
}

function outputLineCap(request: PayloadRequest): number {
    return positiveInt(request.lines) ?? positiveInt(request.tail_lines) ?? OUTPUT_PAGE_DEFAULTS.logLines;
}

export function assembleUnreadableMetadata(id: string, detail: string, request: PayloadRequest = {}): string {
    return envelopeText({
        maxBytes: budgetFor("status", request.maxBytes),
        identity: `[${id} · metadata unreadable]`,
        diagnostics: joinSections([
            "Run metadata is missing, unreadable, or corrupt. This is not proof the run is absent or healthy.",
            `detail=${detail.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}`,
            `Retained log bytes may still be read with subagent_output id="${id}" mode="raw" all:true once ownership is confirmed.`,
        ]),
        gaps: [{ kind: "read", detail }],
    });
}

export function assembleOwnershipGap(
    id: string,
    kind: "foreign" | "unavailable",
    request: PayloadRequest = {},
): string {
    const identity = kind === "foreign"
        ? `[${id} · foreign session]`
        : `[${id} · ownership unavailable]`;
    const decision = kind === "foreign"
        ? "This run belongs to another session. Pass all:true to read it. Evidence is not included."
        : "Current session identity could not be read, so this run's ownership cannot be verified. This is not proof the run is absent, and evidence is not included. Pass all:true if you intend a cross-session read.";
    return envelopeText({
        maxBytes: budgetFor("status", request.maxBytes),
        identity,
        decision,
        gaps: [{ kind: "read", detail: kind === "foreign" ? "foreign-session" : "ownership-unavailable" }],
    });
}

export function resolveRunAccess(
    id: string,
    request: PayloadRequest,
    session: SubagentToolSession | undefined,
): { kind: "missing" } | { kind: "unreadable"; detail: string } | { kind: "denied"; payload: string } | { kind: "ok"; meta: RunMeta } {
    const loaded = loadRunRecord(id);
    if (loaded.kind === "missing") return loaded;
    if (loaded.kind === "unreadable") return loaded;
    if (isAll(request.all)) return { kind: "ok", meta: loaded.meta };
    const resolved = resolveActiveOrigin(session);
    // Unwired factories (no session provider) exist only for unit tests that
    // build a tool without the extension. index.ts always passes a provider,
    // so registered tools never take this branch; see the
    // "registered tools fail closed" test in subagent_output_budget.test.mjs.
    if (!resolved.wired) return { kind: "ok", meta: loaded.meta };
    if (!resolved.available || !resolved.origin) {
        return { kind: "denied", payload: assembleOwnershipGap(id, "unavailable", request) };
    }
    const owner = ownership(loaded.meta, resolved.origin);
    if (owner !== "own") {
        return { kind: "denied", payload: assembleOwnershipGap(id, owner, request) };
    }
    return { kind: "ok", meta: loaded.meta };
}

function defaultScope(): string {
    return listScopeKey(false, undefined, process.pid);
}

export function assembleRunningResult(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    scopeKey = defaultScope(),
): string {
    const st = String(effectiveStatus(meta));
    const terminal = st !== "running" && st !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", terminal);
    const identity = `[${id} · ${st} · ${elapsedFor(meta)}]`;
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged) return unchanged;
    return envelopeText({
        maxBytes: budgetFor("answer", request.maxBytes),
        identity,
        failure: failureSection(ctx),
        decision: `Run ${id} is still running — no result yet. You'll be notified when it finishes; don't poll.`,
        diagnostics: joinSections([changeDiagnostics(ctx), parserDiagnostics(parseRun(id))]),
        gaps: logGaps(id),
        statusCursor: ctx.statusCursor,
    });
}

function assembleRaw(
    id: string,
    meta: RunMeta,
    status: string,
    request: PayloadRequest,
    surface: "output" | "result",
    scopeKey: string,
): string {
    const terminal = status !== "running" && status !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, surface === "result" ? "subagent_result" : "subagent_output", terminal);
    const identity = outputIdentity(id, status, elapsedFor(meta));
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged) return unchanged;
    const run = parseRun(id);
    const maxBytes = budgetFor("rawPage", request.maxBytes);
    const continuing = cursorKind(request.cursor) === "f";
    return envelopeText({
        maxBytes,
        identity: `${identity} raw retained log`,
        failure: failureSection(ctx, continuing ? CONTINUATION_FAILURE_BYTES : 1024),
        diagnostics: joinSections([changeDiagnostics(ctx), parserDiagnostics(run)]),
        gaps: logGaps(id),
        verbatim: (remaining) => rawPage(ctx, pageCursorFor(request.cursor), remaining),
        verbatimReserve: Math.floor(maxBytes / 2),
        statusCursor: ctx.statusCursor,
    });
}

export function assembleSubagentOutput(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    healthLine = "",
    scopeKey = defaultScope(),
): string {
    const st = String(effectiveStatus(meta));
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f") return assembleRaw(id, meta, st, request, "output", scopeKey);
    const terminal = st !== "running" && st !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, "subagent_output", terminal);
    const identity = outputIdentity(id, st, elapsedFor(meta));
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const run = parseRun(id);
    const parsed = bestParsed(run);
    const gaps = logGaps(id);
    const emptyLog = gaps.length === 0 && !parsed && !run.diagnostics.length;
    const decision = gaps.length
        ? "Child log is missing or unreadable; this is not an empty healthy result."
        : undefined;
    const diagnostics = joinSections([
        changeDiagnostics(ctx),
        healthLine || undefined,
        parserDiagnostics(run),
        emptyLog && !decision ? "(no output yet)" : undefined,
        !parsed && !emptyLog && gaps.length === 0 ? "(no parsed output yet)" : undefined,
        gaps.length || run.diagnostics.some((line) => /unreadable|truncated/i.test(line))
            ? retrievalHint(id)
            : undefined,
    ]);
    const maxBytes = budgetFor("log", request.maxBytes);
    const maxLines = outputLineCap(request);
    return envelopeText({
        maxBytes,
        identity,
        failure: failureSection(ctx, isContinuationPage(pageCursor) ? CONTINUATION_FAILURE_BYTES : undefined),
        decision,
        diagnostics,
        gaps,
        verbatim: parsed
            ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining, maxLines)
            : gaps.length === 0
                ? (remaining) => rawPage(ctx, pageCursor, remaining)
                : undefined,
        verbatimReserve: answerReserve(maxBytes, pageCursor),
        statusCursor: ctx.statusCursor,
    });
}

export function assembleOrphanedResult(
    id: string,
    meta: RunMeta,
    healthLine: string,
    request: PayloadRequest = {},
    scopeKey = defaultScope(),
): string {
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f") return assembleRaw(id, meta, "orphaned", request, "result", scopeKey);
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", false);
    const identity = `[${id} · orphaned · ${elapsedFor(meta)}]`;
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const run = parseRun(id);
    const gaps = logGaps(id);
    const parsed = bestParsed(run);
    const maxBytes = budgetFor("answer", request.maxBytes);
    return envelopeText({
        maxBytes,
        identity,
        failure: failureSection(ctx, isContinuationPage(pageCursor) ? CONTINUATION_FAILURE_BYTES : undefined),
        decision: "Run is orphaned — non-final. Supervision was lost; related processes may still be alive. There is no final result yet.",
        diagnostics: joinSections([
            changeDiagnostics(ctx),
            healthLine || undefined,
            parserDiagnostics(run),
            gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            formatOrphanedResult(run, "").split("\n").slice(0, 2).join("\n"),
            "--- best-current parsed output ---",
            retrievalHint(id),
        ]),
        gaps,
        verbatim: parsed
            ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining)
            : gaps.length === 0
                ? (remaining) => rawPage(ctx, pageCursor, remaining)
                : undefined,
        verbatimReserve: answerReserve(maxBytes, pageCursor),
        statusCursor: ctx.statusCursor,
    });
}

export function assembleSubagentResult(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    healthLine = "",
    scopeKey = defaultScope(),
): string {
    const st = effectiveStatus(meta);
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f") return assembleRaw(id, meta, String(st), request, "result", scopeKey);
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", true);
    const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
    const run = parseRunForLifecycle(id);
    const lifecycle = resolveLifecycle(meta, run);
    const identity = resultIdentity(id, String(st), exit, elapsedFor(meta), lifecycle.classification);
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const gaps = logGaps(id);
    const maxBytes = budgetFor("answer", request.maxBytes);
    const failure = failureSection(ctx, isContinuationPage(pageCursor) ? CONTINUATION_FAILURE_BYTES : undefined);
    const reserve = answerReserve(maxBytes, pageCursor);

    if (lifecycle.incomplete) {
        const parsed = bestParsed(run);
        return envelopeText({
            maxBytes,
            identity,
            failure,
            decision: "Run ended unexpectedly before producing a coherent final result.",
            diagnostics: joinSections([
                changeDiagnostics(ctx),
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                streamEvidence(run),
                parserDiagnostics(run),
                gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
                "--- best available parsed output ---",
                retrievalHint(id),
            ]),
            gaps,
            verbatim: parsed ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining) : undefined,
            verbatimReserve: reserve,
            statusCursor: ctx.statusCursor,
        });
    }

    if (st === "lost" || lifecycle.classification === "lost") {
        const parsed = bestParsed(run);
        return envelopeText({
            maxBytes,
            identity,
            failure,
            decision: "Run is lost: no related process remains and no coherent terminal completion was observed. This is a terminal unknown outcome, not a normal failure.",
            diagnostics: joinSections([
                changeDiagnostics(ctx),
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                parserDiagnostics(run),
                formatLostResult(run, "").split("\n").slice(0, 2).join("\n"),
                "--- best-available parsed output ---",
                retrievalHint(id),
            ]),
            gaps,
            verbatim: parsed
                ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining)
                : gaps.length === 0
                    ? (remaining) => rawPage(ctx, pageCursor, remaining)
                    : undefined,
            verbatimReserve: reserve,
            statusCursor: ctx.statusCursor,
        });
    }

    const exceptional = isRoutineComplete(lifecycle) ? undefined : formatLifecycleDiagnostics(lifecycle);
    const answer = run.finalText || "";
    const fallback = !answer
        ? (run.lastActivity
            ? `(no final answer parsed; latest activity)\n${run.lastActivity}`
            : undefined)
        : undefined;
    return envelopeText({
        maxBytes,
        identity,
        failure,
        diagnostics: joinSections([
            changeDiagnostics(ctx),
            healthLine || undefined,
            exceptional,
            parserDiagnostics(run),
            !answer && gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            !answer ? retrievalHint(id) : undefined,
        ]),
        gaps,
        verbatim: (remaining) => answerPage(ctx, answer || fallback || "(no final answer parsed)", pageCursor, remaining),
        verbatimReserve: reserve,
        statusCursor: ctx.statusCursor,
    });
}

// ---- list ----------------------------------------------------------------

export interface SubagentListItem {
    meta: RunMeta;
    status: string;
}

export function listIncidentCount(id: string, cwd: string, terminal: boolean): { count: number; actionRequired: number; revision: string } {
    const state = collectRunFailures(id, cwd, terminal);
    const active = activeFailures(state);
    return { count: active.length, actionRequired: active.filter(requiresAction).length, revision: failureRevision(state) };
}

export function formatIncidentLabel(count: number, actionRequired = 0): string {
    if (count <= 0) return "";
    return `${count} incident${count === 1 ? "" : "s"}${actionRequired ? ` · ${actionRequired} action required` : ""}`;
}

export function listIncidentLabel(id: string, cwd: string, terminal: boolean): string {
    const { count, actionRequired } = listIncidentCount(id, cwd, terminal);
    return formatIncidentLabel(count, actionRequired);
}

/**
 * Status revisions for a list: every row's lifecycle facts (content) and
 * every row's full failure signature (failure-only changes).
 */
export function listRevisions(
    items: Array<{ id: string; status: string; meta?: RunMeta }>,
    failureSignatures: string[],
): { contentRevision: string; failureRevision: string } {
    return {
        contentRevision: revisionOf(items.map((item) => [
            item.id,
            item.status,
            item.meta?.status ?? null,
            item.meta?.exitCode ?? null,
            item.meta?.endedAt ?? null,
        ])),
        failureRevision: revisionOf(items.map((item, index) => [item.id, failureSignatures[index] ?? ""])),
    };
}

export function assembleSubagentListPayload(input: {
    warnings: string[];
    items: SubagentListItem[];
    render: (item: SubagentListItem) => string;
    limit: number;
    cursor?: string;
    maxBytes?: unknown;
    contentRevision: string;
    failureRevision: string;
    scopeKey: string;
    statusesKey?: string;
    sessionWarning?: string;
    unreadable?: Array<{ id: string; detail: string }>;
    indexError?: string;
    incidentRuns?: number;
}): string {
    const maxBytes = budgetFor("list", input.maxBytes);
    const resource = `subagent_list:${input.scopeKey}:${input.statusesKey ?? ""}`;
    const statusCursorInput = cursorKind(input.cursor) === "s" ? input.cursor : undefined;
    const status = inspectStatusRevision({
        cursor: statusCursorInput,
        resource,
        contentRevision: input.contentRevision,
        failureRevision: input.failureRevision,
    });
    const matching = input.items.length;
    const scopeLabel = input.scopeKey === "all" ? "all" : input.scopeKey;
    if (statusCursorInput && status.change === "none") {
        return envelopeText({
            maxBytes,
            identity: `subagent_list · ${matching} matching · scope ${scopeLabel} · unchanged`,
            decision: formatUnchangedEvidence(statusCursorInput),
            statusCursor: status.nextCursor,
        });
    }
    const unreadable = input.unreadable ?? [];
    const pageCursor = input.cursor && !statusCursorInput ? input.cursor : undefined;
    const identity = input.indexError
        ? "subagent_list · run index unreadable"
        : matching === 0
            ? "No subagent runs match filters."
            : `subagent_list · ${matching} matching · scope ${scopeLabel} · newest first`;
    const diagnostics = joinSections([
        input.sessionWarning,
        ...input.warnings,
        input.indexError ? `Run index could not be read: ${input.indexError}. Cannot treat the registry as empty.` : undefined,
        unreadable.length
            ? `${unreadable.length} run record(s) with missing or unreadable metadata (ownership unknown; not counted as absent or healthy): ${unreadable.slice(0, 3).map((item) => item.id).join(", ")}${unreadable.length > 3 ? ", …" : ""}`
            : undefined,
        statusCursorInput && status.change === "failure" ? "change=failure" : undefined,
        statusCursorInput && status.change === "reset" ? "reset=stale-cursor (status cursor from another scope or filter)" : undefined,
    ]);
    const gaps: EvidenceGap[] = [
        ...(input.indexError ? [{ kind: "read" as const, detail: input.indexError }] : []),
        ...(unreadable.length ? [{ kind: "read" as const, detail: `${unreadable.length} unreadable run metadata record(s)` }] : []),
    ];
    return envelopeText({
        maxBytes,
        identity,
        failure: input.incidentRuns
            ? `${input.incidentRuns} listed run${input.incidentRuns === 1 ? "" : "s"} with active failure observations; inspect with subagent_result`
            : undefined,
        diagnostics,
        gaps,
        verbatim: matching === 0 && !pageCursor
            ? undefined
            : (remaining) => pageRows(input.items, {
                cursor: pageCursor,
                resource,
                limit: input.limit,
                maxBytes: remaining,
                keyOf: (item) => ({ time: item.meta.startedAt, id: item.meta.id }),
                render: input.render,
            }),
        // List rows always get half the page; the lead-in is a pointer.
        verbatimReserve: Math.floor(maxBytes / 2),
        statusCursor: status.nextCursor,
    });
}

export function unknownRunError(id: string): Error {
    return new Error(`Unknown run id: ${id}`);
}

export { originOf };
