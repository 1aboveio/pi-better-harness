/**
 * Model-facing subagent payloads (#312).
 *
 * One assembler path for list / output / result / raw evidence. Budgets,
 * cursors, and envelopes come from shared log-utils; lifecycle and failure
 * reduction stay with their owners (ADR 0006). Ordinary tool-name sequences
 * and usage/cost boilerplate are omitted.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
    assemblePriorityEnvelope,
    budgetFor,
    cursorKind,
    formatUnchangedEvidence,
    inspectStatusRevision,
    OUTPUT_PAGE_DEFAULTS,
    pageRetainedFile,
    pageVerbatimText,
    sliceUtf8Bytes,
    utf8ByteLength,
    type EvidenceGap,
    type PageReset,
    type PageResult,
    type VerbatimPage,
} from "./shared-log-utils.ts";
import { collectRunFailures, formatFailureSummary, readRunFailures } from "./failures.ts";
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
    logPathFor,
    originKey,
    originOf,
    readMeta,
    runDir,
    type RunCallbackOrigin,
    type RunMeta,
} from "./registry.ts";
import { activeFailures, incidentCursorAt, isIncidentCursor, pageFailureIncidents } from "./shared-failure-observations.ts";
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
    getActiveOrigin?: () => RunCallbackOrigin | undefined;
};

const LIST_CURSOR_PREFIX = "l1.";

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function metaPathFor(id: string): string {
    return join(runDir(id), "meta.json");
}

function positiveInt(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.max(1, Math.floor(n));
}

function isAll(value: unknown): boolean {
    return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

/** Distinguish a missing run from unreadable/corrupt metadata (AC5). */
export function loadRunRecord(id: string): LoadedRun {
    const meta = readMeta(id);
    if (meta) return { kind: "ok", meta };
    const path = metaPathFor(id);
    try {
        statSync(path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { kind: "missing" };
        return { kind: "unreadable", detail: errorText(error) };
    }
    if (!existsSync(path)) return { kind: "missing" };
    return { kind: "unreadable", detail: "Run metadata is unreadable or corrupt" };
}

export function isRawMode(mode: unknown): boolean {
    return String(mode ?? "").trim().toLowerCase() === "raw";
}

export function listScopeKey(
    all: boolean,
    origin: RunCallbackOrigin | undefined,
    parentPid: number,
): string {
    if (all) return "all";
    if (origin) return `session:${originKey(origin)}`;
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

export function runInListScope(
    meta: RunMeta,
    options: { all?: boolean },
    origin: RunCallbackOrigin | undefined,
    parentPid: number,
    sessionAvailable = true,
): boolean {
    if (options.all) return true;
    if (origin) return belongsToOrigin(meta, origin);
    if (!sessionAvailable) {
        return meta.spawnPid === parentPid && !originOf(meta).sessionId;
    }
    return meta.spawnPid === parentPid;
}

function shortRevision(value: string): string {
    return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

function contentRevisionFor(id: string): string {
    try {
        const stats = statSync(logPathFor(id));
        return shortRevision(`${stats.dev}:${stats.ino}:${stats.size}:${Math.trunc(stats.mtimeMs)}`);
    } catch (error) {
        return shortRevision(`missing:${errorText(error)}`);
    }
}

function failureRevisionFor(id: string): string {
    const state = readRunFailures(id);
    const active = activeFailures(state)
        .map((item) => `${item.id}:${item.status}:${item.count}:${item.lastObservedAt}`)
        .join(",");
    return shortRevision(`${state.seen.length}:${active}`);
}

function inspectStatus(resource: string, id: string, cursor?: string) {
    return inspectStatusRevision({
        cursor,
        resource,
        contentRevision: contentRevisionFor(id),
        failureRevision: failureRevisionFor(id),
    });
}

function currentStatusCursor(resource: string, id: string): string {
    return inspectStatusRevision({
        resource,
        contentRevision: contentRevisionFor(id),
        failureRevision: failureRevisionFor(id),
    }).nextCursor;
}

function asVerbatim(page: PageResult): VerbatimPage {
    return page;
}

function joinSections(parts: Array<string | undefined>): string | undefined {
    const text = parts.filter((part): part is string => Boolean(part && part.length > 0)).join("\n");
    return text.length > 0 ? text : undefined;
}

function elapsedFor(meta: RunMeta, now = Date.now()): string {
    return fmtElapsed((meta.endedAt ?? now) - meta.startedAt);
}

function resultIdentity(
    id: string,
    status: string,
    exitCode: string,
    elapsed: string,
    classification: string,
): string {
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
        return [{ kind: "read", detail: errorText(error) }];
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

function failureText(id: string, meta: RunMeta, terminal: boolean): string | undefined {
    const state = collectRunFailures(id, meta.cwd, terminal);
    const summary = formatFailureSummary(state);
    if (!summary) return undefined;
    const active = activeFailures(state);
    if (active.length <= 5) return summary;
    const omitted = active.length - 5;
    const cursor = incidentCursorAt(state, 5);
    return `omittedIncidents=${omitted} incidentCursor=${cursor}\n${summary}`;
}

function failureState(id: string, meta: RunMeta, terminal: boolean) {
    return collectRunFailures(id, meta.cwd, terminal);
}

function incidentDiagnostics(id: string, meta: RunMeta, terminal: boolean): string | undefined {
    const state = failureState(id, meta, terminal);
    const active = activeFailures(state);
    if (active.length <= 5) return undefined;
    const omitted = active.length - 5;
    const cursor = incidentCursorAt(state, 5);
    return `${omitted} omitted incidents retrievable with cursor=${cursor} (subagent_result/subagent_output id="${id}"). Failure journal remains retained evidence.`;
}

function assembleIncidentPage(
    id: string,
    meta: RunMeta,
    request: PayloadRequest,
    terminal: boolean,
): string {
    const state = failureState(id, meta, terminal);
    const maxBytes = budgetFor("answer", request.maxBytes);
    const page = pageFailureIncidents(state, { cursor: request.cursor, maxBytes: Math.max(256, maxBytes - 400) });
    return envelopeText({
        maxBytes,
        identity: `[${id} · incidents ${page.represented}/${page.total}]`,
        failure: page.text || "No unresolved incidents.",
        diagnostics: [
            page.reset ? `reset=${page.reset}` : undefined,
            page.omitted > 0
                ? `${page.omitted} omitted incidents remain; pass nextCursor to continue.`
                : "All retained incidents are included on this page.",
        ].filter((line): line is string => Boolean(line)).join("\n"),
        verbatim: () => ({
            text: "",
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            omittedBytes: page.omitted,
            reset: page.reset,
        }),
    });
}

function pageCursorFor(cursor: string | undefined): string | undefined {
    if (!cursor) return undefined;
    // Status cursors are handled separately. Page/file/garbage cursors go to the
    // shared pager so stale tokens produce reset=stale-cursor instead of a silent first page.
    return cursorKind(cursor) === "s" ? undefined : cursor;
}

function maybeUnchanged(resource: string, id: string, cursor?: string): string | undefined {
    if (!cursor || cursorKind(cursor) !== "s") return undefined;
    const inspected = inspectStatus(resource, id, cursor);
    if (inspected.change === "none") return formatUnchangedEvidence(cursor);
    return undefined;
}

function envelopeText(input: {
    maxBytes: number;
    identity?: string;
    failure?: string;
    decision?: string;
    diagnostics?: string;
    progress?: string;
    gaps?: EvidenceGap[];
    verbatim?: (remaining: number) => VerbatimPage;
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
    }).text;
}

function rawPage(id: string, cursor: string | undefined, remaining: number): PageResult {
    return pageRetainedFile(logPathFor(id), {
        cursor,
        maxBytes: remaining,
        resource: id,
    });
}

function outputLineCap(request: PayloadRequest): number {
    return positiveInt(request.lines) ?? positiveInt(request.tail_lines) ?? OUTPUT_PAGE_DEFAULTS.logLines;
}

function scopedResource(surface: string, scopeKey: string, id?: string): string {
    return id ? `${surface}:${scopeKey}:${id}` : `${surface}:${scopeKey}`;
}

export function assembleUnreadableMetadata(id: string, detail: string, request: PayloadRequest = {}): string {
    return envelopeText({
        maxBytes: budgetFor("status", request.maxBytes),
        identity: `[${id} · metadata unreadable]`,
        diagnostics: joinSections([
            "Run metadata exists but could not be read. This is not proof the run is absent.",
            `detail=${detail.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}`,
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
        : "Current session identity could not be read. This is not proof the run is absent, and evidence is not included. Pass all:true if you intend a cross-session read.";
    return envelopeText({
        maxBytes: budgetFor("status", request.maxBytes),
        identity,
        decision,
        diagnostics: "Ownership could not be confirmed for this id; refusing to expose foreign or unverified evidence.",
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
    if (!resolved.wired) return { kind: "ok", meta: loaded.meta };
    if (!resolved.available || !resolved.origin) {
        if (loaded.meta.spawnPid === process.pid && !originOf(loaded.meta).sessionId) {
            return { kind: "ok", meta: loaded.meta };
        }
        return { kind: "denied", payload: assembleOwnershipGap(id, "unavailable", request) };
    }
    if (!belongsToOrigin(loaded.meta, resolved.origin)) {
        return { kind: "denied", payload: assembleOwnershipGap(id, "foreign", request) };
    }
    return { kind: "ok", meta: loaded.meta };
}

export function assembleRunningResult(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    scopeKey = listScopeKey(false, undefined, process.pid),
): string {
    const st = effectiveStatus(meta);
    const terminal = st !== "running" && st !== "orphaned";
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(id, meta, request, terminal);
    const resource = scopedResource("subagent_result", scopeKey, id);
    const unchanged = maybeUnchanged(resource, id, request.cursor);
    if (unchanged) return unchanged;
    return envelopeText({
        maxBytes: budgetFor("answer", request.maxBytes),
        identity: `[${id} · ${st} · ${elapsedFor(meta)}]`,
        failure: failureText(id, meta, terminal),
        decision: `Run ${id} is still running — no result yet. You'll be notified when it finishes; don't poll.`,
        diagnostics: joinSections([parserDiagnostics(parseRun(id)), incidentDiagnostics(id, meta, terminal)]),
        progress: `statusCursor=${currentStatusCursor(resource, id)}`,
        gaps: logGaps(id),
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
    const resource = scopedResource(surface === "result" ? "subagent_result" : "subagent_output", scopeKey, id);
    const unchanged = maybeUnchanged(resource, id, request.cursor);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const terminal = status !== "running" && status !== "orphaned";
    const run = parseRun(id);
    return envelopeText({
        maxBytes: budgetFor("rawPage", request.maxBytes),
        identity: outputIdentity(id, status, elapsedFor(meta)),
        failure: failureText(id, meta, terminal),
        diagnostics: parserDiagnostics(run),
        progress: `statusCursor=${currentStatusCursor(resource, id)}`,
        gaps: logGaps(id),
        verbatim: (remaining) => asVerbatim(rawPage(id, pageCursor, remaining)),
    });
}

export function assembleSubagentOutput(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    healthLine = "",
    scopeKey = listScopeKey(false, undefined, process.pid),
): string {
    const st = String(effectiveStatus(meta));
    if (isRawMode(request.mode)) return assembleRaw(id, meta, st, request, "output", scopeKey);

    const resource = scopedResource("subagent_output", scopeKey, id);
    const terminalEarly = st !== "running" && st !== "orphaned";
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(id, meta, request, terminalEarly);
    const unchanged = maybeUnchanged(resource, id, request.cursor);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const terminal = terminalEarly;
    const run = parseRun(id);
    const parsed = bestParsed(run);
    const gaps = logGaps(id);
    const emptyLog = gaps.length === 0 && !parsed && !run.diagnostics.length;
    const decision = gaps.length
        ? "Child log is missing or unreadable; this is not an empty healthy result."
        : undefined;
    const diagnostics = joinSections([
        healthLine || undefined,
        parserDiagnostics(run),
        incidentDiagnostics(id, meta, terminal),
        emptyLog && !decision ? "(no output yet)" : undefined,
        !parsed && !emptyLog && gaps.length === 0 ? "(no parsed output yet)" : undefined,
        gaps.length || run.diagnostics.some((line) => /unreadable|truncated/i.test(line))
            ? retrievalHint(id)
            : undefined,
    ]);
    const maxLines = outputLineCap(request);
    return envelopeText({
        maxBytes: budgetFor("log", request.maxBytes),
        identity: outputIdentity(id, st, elapsedFor(meta)),
        failure: failureText(id, meta, terminal),
        decision,
        diagnostics,
        progress: `statusCursor=${currentStatusCursor(resource, id)}`,
        gaps,
        verbatim: parsed
            ? (remaining) => asVerbatim(pageVerbatimText(parsed, {
                cursor: pageCursor,
                maxBytes: remaining,
                maxLines,
            }))
            : gaps.length === 0
                ? (remaining) => asVerbatim(rawPage(id, pageCursor, remaining))
                : undefined,
    });
}

export function assembleOrphanedResult(
    id: string,
    meta: RunMeta,
    healthLine: string,
    request: PayloadRequest = {},
    scopeKey = listScopeKey(false, undefined, process.pid),
): string {
    if (isRawMode(request.mode)) return assembleRaw(id, meta, "orphaned", request, "result", scopeKey);
    const resource = scopedResource("subagent_result", scopeKey, id);
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(id, meta, request, false);
    const unchanged = maybeUnchanged(resource, id, request.cursor);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);
    const run = parseRun(id);
    const gaps = logGaps(id);
    const parsed = bestParsed(run);
    return envelopeText({
        maxBytes: budgetFor("answer", request.maxBytes),
        identity: `[${id} · orphaned · ${elapsedFor(meta)}]`,
        failure: failureText(id, meta, false),
        decision: "Run is orphaned — non-final. Supervision was lost; related processes may still be alive. There is no final result yet.",
        diagnostics: joinSections([
            healthLine || undefined,
            parserDiagnostics(run),
            incidentDiagnostics(id, meta, false),
            gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            formatOrphanedResult(run, "").split("\n").slice(0, 2).join("\n"),
            "--- best-current parsed output ---",
            retrievalHint(id),
        ]),
        progress: `statusCursor=${currentStatusCursor(resource, id)}`,
        gaps,
        verbatim: parsed
            ? (remaining) => asVerbatim(pageVerbatimText(parsed, { cursor: pageCursor, maxBytes: remaining }))
            : gaps.length === 0
                ? (remaining) => asVerbatim(rawPage(id, pageCursor, remaining))
                : undefined,
    });
}

export function assembleSubagentResult(
    id: string,
    meta: RunMeta,
    request: PayloadRequest = {},
    healthLine = "",
    scopeKey = listScopeKey(false, undefined, process.pid),
): string {
    const st = effectiveStatus(meta);
    if (isRawMode(request.mode)) return assembleRaw(id, meta, String(st), request, "result", scopeKey);

    const resource = scopedResource("subagent_result", scopeKey, id);
    const terminalEarly = true;
    if (isIncidentCursor(request.cursor)) return assembleIncidentPage(id, meta, request, terminalEarly);
    const unchanged = maybeUnchanged(resource, id, request.cursor);
    if (unchanged) return unchanged;
    const pageCursor = pageCursorFor(request.cursor);

    const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
    const run = parseRunForLifecycle(id);
    const lifecycle = resolveLifecycle(meta, run);
    const elapsed = elapsedFor(meta);
    const identity = resultIdentity(id, st, exit, elapsed, lifecycle.classification);
    const terminal = true;
    const gaps = logGaps(id);
    const statusCursorLine = `statusCursor=${currentStatusCursor(resource, id)}`;

    if (lifecycle.incomplete) {
        const parsed = bestParsed(run);
        return envelopeText({
            maxBytes: budgetFor("answer", request.maxBytes),
            identity,
            failure: failureText(id, meta, terminal),
            decision: "Run ended unexpectedly before producing a coherent final result.",
            diagnostics: joinSections([
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                streamEvidence(run),
                parserDiagnostics(run),
                incidentDiagnostics(id, meta, terminal),
                gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
                "--- best available parsed output ---",
                retrievalHint(id),
            ]),
            progress: statusCursorLine,
            gaps,
            verbatim: parsed
                ? (remaining) => asVerbatim(pageVerbatimText(parsed, { cursor: pageCursor, maxBytes: remaining }))
                : undefined,
        });
    }

    if (st === "lost" || lifecycle.classification === "lost") {
        const parsed = bestParsed(run);
        return envelopeText({
            maxBytes: budgetFor("answer", request.maxBytes),
            identity,
            failure: failureText(id, meta, terminal),
            decision: "Run is lost: no related process remains and no coherent terminal completion was observed. This is a terminal unknown outcome, not a normal failure.",
            diagnostics: joinSections([
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                parserDiagnostics(run),
                incidentDiagnostics(id, meta, terminal),
                formatLostResult(run, "").split("\n").slice(0, 2).join("\n"),
                "--- best-available parsed output ---",
                retrievalHint(id),
            ]),
            progress: statusCursorLine,
            gaps,
            verbatim: parsed
                ? (remaining) => asVerbatim(pageVerbatimText(parsed, { cursor: pageCursor, maxBytes: remaining }))
                : gaps.length === 0
                    ? (remaining) => asVerbatim(rawPage(id, pageCursor, remaining))
                    : undefined,
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
        maxBytes: budgetFor("answer", request.maxBytes),
        identity,
        failure: failureText(id, meta, terminal),
        diagnostics: joinSections([
            healthLine || undefined,
            exceptional,
            parserDiagnostics(run),
            incidentDiagnostics(id, meta, terminal),
            !answer && gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            !answer ? retrievalHint(id) : undefined,
        ]),
        progress: statusCursorLine,
        gaps,
        verbatim: (remaining) => asVerbatim(pageVerbatimText(
            answer || fallback || "(no final answer parsed)",
            { cursor: pageCursor, maxBytes: remaining },
        )),
    });
}

type ListCursorPayload = {
    k: "l";
    r: string;
    o: number;
    v: string;
    n: number;
};

function encodeListCursor(payload: ListCursorPayload): string {
    return LIST_CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string | undefined): ListCursorPayload | undefined {
    if (!cursor || !cursor.startsWith(LIST_CURSOR_PREFIX)) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(cursor.slice(LIST_CURSOR_PREFIX.length), "base64url").toString("utf8")) as ListCursorPayload;
        if (parsed?.k === "l" && typeof parsed.r === "string") return parsed;
    } catch {
        return undefined;
    }
    return undefined;
}

function fitListRows(rows: string[], maxBytes: number): { text: string; count: number; clipped: boolean } {
    if (rows.length === 0 || maxBytes <= 0) return { text: "", count: 0, clipped: false };
    const included: string[] = [];
    for (const row of rows) {
        const candidate = included.length ? `${included.join("\n")}\n${row}` : row;
        if (utf8ByteLength(candidate) <= maxBytes) {
            included.push(row);
            continue;
        }
        if (included.length === 0) {
            const clipped = sliceUtf8Bytes(row, 0, maxBytes, true);
            return { text: clipped.text, count: 1, clipped: clipped.endByte < utf8ByteLength(row) || rows.length > 1 };
        }
        break;
    }
    return { text: included.join("\n"), count: included.length, clipped: included.length < rows.length };
}

export function assembleSubagentListPayload(input: {
    warnings: string[];
    rows: string[];
    matching: number;
    displayed: number;
    limit: number;
    empty: boolean;
    offset?: number;
    cursor?: string;
    maxBytes?: unknown;
    contentRevision: string;
    failureRevision: string;
    scopeKey: string;
    sessionWarning?: string;
}): string {
    const maxBytes = budgetFor("list", input.maxBytes);
    const resource = scopedResource("subagent_list", input.scopeKey);
    const listCursor = decodeListCursor(input.cursor);
    const statusInspect = inspectStatusRevision({
        cursor: input.cursor,
        resource,
        contentRevision: input.contentRevision,
        failureRevision: input.failureRevision,
    });
    if (input.cursor && cursorKind(input.cursor) === "s" && statusInspect.change === "none") {
        return formatUnchangedEvidence(input.cursor);
    }

    let offset = input.offset ?? 0;
    let reset: PageReset | undefined;
    if (input.cursor) {
        if (listCursor) {
            if (listCursor.r !== resource) {
                reset = "stale-cursor";
                offset = 0;
            } else if (listCursor.v !== input.contentRevision) {
                reset = "source-replaced";
                offset = 0;
            } else {
                offset = Math.max(0, Math.floor(listCursor.o));
            }
        } else if (cursorKind(input.cursor) === "s") {
            offset = 0;
            if (statusInspect.change === "reset") reset = "stale-cursor";
        } else {
            reset = "stale-cursor";
            offset = 0;
        }
    }

    const window = input.rows;
    const statusCursor = inspectStatusRevision({
        resource,
        contentRevision: input.contentRevision,
        failureRevision: input.failureRevision,
    }).nextCursor;
    const identity = input.empty
        ? "No subagent runs match filters."
        : `subagent_list · ${input.matching} matching · scope ${input.scopeKey}`;
    const diagnostics = joinSections([
        input.sessionWarning,
        ...input.warnings,
        reset ? `reset=${reset}` : undefined,
        !input.empty && input.matching > 0
            ? `Showing up to ${input.limit} compact rows per page (${OUTPUT_PAGE_DEFAULTS.listEntries} default).`
            : undefined,
    ]);

    return envelopeText({
        maxBytes,
        identity,
        diagnostics,
        progress: `statusCursor=${statusCursor}`,
        verbatim: (remaining) => {
            const fitted = fitListRows(window, remaining);
            const nextOffset = offset + fitted.count;
            const hasMore = nextOffset < input.matching || fitted.clipped;
            const omittedBytes = Math.max(0, utf8ByteLength(window.join("\n")) - utf8ByteLength(fitted.text));
            return {
                text: fitted.text,
                hasMore,
                nextCursor: encodeListCursor({
                    k: "l",
                    r: resource,
                    o: nextOffset,
                    v: input.contentRevision,
                    n: input.matching,
                }),
                omittedBytes,
                revision: input.contentRevision,
                reset,
                gaps: [],
            };
        },
    });
}

export function listIncidentLabel(id: string, cwd: string, terminal: boolean): string {
    const count = activeFailures(collectRunFailures(id, cwd, terminal)).length;
    if (count <= 0) return "";
    return `${count} incident${count === 1 ? "" : "s"}`;
}

export function listRevisions(ids: string[], incidentLabels: string[]): { contentRevision: string; failureRevision: string } {
    return {
        contentRevision: shortRevision(ids.join("\n")),
        failureRevision: shortRevision(incidentLabels.join("|")),
    };
}

export function unknownRunError(id: string): Error {
    return new Error(`Unknown run id: ${id}`);
}

export function decodeListOffset(cursor: string | undefined, scopeKey: string, contentRevision: string): number {
    const parsed = decodeListCursor(cursor);
    const resource = scopedResource("subagent_list", scopeKey);
    if (!parsed || parsed.r !== resource || parsed.v !== contentRevision) return 0;
    return Math.max(0, Math.floor(parsed.o));
}

export { originOf };
