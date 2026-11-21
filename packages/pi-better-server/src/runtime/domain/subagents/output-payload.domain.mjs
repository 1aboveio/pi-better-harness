// Generated fixed launch domain from packages/pi-better-subagents/output-payload.ts. Do not edit directly.
import { existsSync } from "node:fs";
import { readRetainedResult } from "./retained-result.domain.mjs";
import { worktreeDenialText } from "./worktree-feedback.domain.mjs";
import { workspaceDelivery } from "./isolated-workspace.domain.mjs";
/**
 * Model-facing subagent payloads (#312).
 *
 * One assembler path for list / output / result / raw evidence. Budgets,
 * cursors, and envelopes come from shared log-utils; incident rendering and
 * paging come from shared failure-observations; lifecycle stays with its owner
 * (ADR 0006). Ordinary tool-name sequences and usage/cost boilerplate are
 * omitted. Every cursor is bound to the selected session scope.
 */
import { assignmentFor, assignmentDiagnostic } from "./assignment-projection.mjs";
import { statSync } from "node:fs";
import { assemblePriorityEnvelope, budgetFor, cursorKind, formatUnchangedEvidence, inspectStatusRevision, lifecycleContentRevision, OUTPUT_PAGE_DEFAULTS, pageRetainedFile, pageRows, pageVerbatimText, readOutputInclude, revisionOf, sessionScopeKey, } from "./shared-log-utils.domain.mjs";
import { collectRunFailures, failurePath } from "./failures.domain.mjs";
import { formatLifecycleDiagnostics, formatLostResult, formatOrphanedResult, resolveLifecycle, } from "./lifecycle.domain.mjs";
import { parseRun, parseRunForLifecycle } from "./parse.domain.mjs";
import { ABANDONED_LAUNCH_GRACE_MS, belongsToOrigin, effectiveStatus, inspectRunMeta, runDir, evidenceLogPath, originOf, } from "./registry.domain.mjs";
import { actionableFailures, failureJournalFingerprint, fileChangeIdentity, failureRevision, formatIncidentSummary, formatTerminalIncidentSummary, incidentCursorScope, incidentPageHeading, incidentResource as sharedIncidentResource, incidentVerbatimPage, isIncidentCursor, requiresAction, scopedFailures, } from "./shared-failure-observations.domain.mjs";
import { fmtElapsed, fmtSpend } from "./widget.domain.mjs";
/** Bytes of a continuation answer page left for the incident count line. */
const CONTINUATION_FAILURE_BYTES = 320;
function positiveInt(value) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0)
        return undefined;
    return Math.max(1, Math.floor(n));
}
function isAll(value) {
    return value === true || String(value ?? "").trim().toLowerCase() === "true";
}
/**
 * Distinguish a missing run from unreadable, corrupt, or absent metadata
 * beside retained run evidence (AC5). Only a run with neither metadata nor a
 * run directory is missing.
 */
export function loadRunRecord(id) {
    const live = inspectRunMeta(id);
    if (live.kind === "unreadable" || (live.kind === "ok" && existsSync(runDir(id))))
        return live;
    const retained = readRetainedResult(id);
    return retained ? { kind: "ok", meta: retained } : live;
}
export function isRawMode(mode) {
    return String(mode ?? "").trim().toLowerCase() === "raw";
}
export function listScopeKey(all, origin, parentPid, sessionAvailable = true) {
    // Shared with background tasks (log-utils): an origin exists only when the
    // session is available, so the shared precedence yields the same keys.
    return sessionScopeKey({ all, unavailable: !sessionAvailable && !origin, origin, fallback: `parent:${parentPid}` });
}
export function resolveActiveOrigin(session) {
    const wired = typeof session?.getActiveOrigin === "function";
    if (!wired)
        return { wired: false, available: false };
    const origin = session.getActiveOrigin?.();
    if (!origin)
        return { wired: true, available: false };
    return { origin, wired: true, available: true };
}
/** Scope key for a tool call, shared by list and direct reads. */
export function requestScopeKey(request, session, parentPid = process.pid) {
    const resolved = resolveActiveOrigin(session);
    return listScopeKey(isAll(request.all), resolved.origin, parentPid, !(resolved.wired && !resolved.available));
}
/**
 * Current-session list scope. When session identity is wired but unavailable,
 * no run's ownership can be verified, so none is in the default scope.
 */
export function runInListScope(meta, options, origin, parentPid, sessionAvailable = true) {
    if (options.all)
        return true;
    if (origin)
        return ownership(meta, origin, parentPid) === "own";
    if (!sessionAvailable)
        return false;
    return meta.spawnPid === parentPid;
}
/**
 * Current-session ownership. Without a current session id, ownership is only
 * verified for a run this process launched with the same sessionless origin;
 * a legacy run with no recorded origin is never assumed to be ours.
 */
export function ownership(meta, origin, parentPid = process.pid) {
    const recorded = meta.callbackOrigin;
    if (!origin.sessionId) {
        if (!recorded)
            return "unavailable";
        if (recorded.cwd === origin.cwd && !recorded.sessionId && meta.spawnPid === parentPid)
            return "own";
        return recorded.sessionId ? "foreign" : "unavailable";
    }
    if (belongsToOrigin(meta, origin))
        return "own";
    return recorded ? "foreign" : "unavailable";
}
/** Lifecycle metadata and log identity. A metadata-only transition is a change. */
function contentRevisionFor(id, meta) {
    return lifecycleContentRevision([
        assignmentFor(meta, effectiveStatus(meta)).revision,
        meta.status,
        String(effectiveStatus(meta)),
        meta.exitCode ?? null,
        meta.endedAt ?? null,
        meta.lifecycleClassification ?? null,
        meta.failureReason ?? null,
    ], evidenceLogPath(id));
}
function assignmentLabel(meta) {
    const a = assignmentFor(meta, effectiveStatus(meta));
    return a.state;
}
function projectionDiagnostic(meta) {
    const assignment = assignmentFor(meta, effectiveStatus(meta));
    return meta.operations || meta.park || assignment.state !== effectiveStatus(meta)
        ? assignmentDiagnostic(assignment) : "";
}
function elapsedFor(meta, now = Date.now()) {
    return fmtElapsed((meta.endedAt ?? now) - meta.startedAt);
}
function joinSections(parts) {
    const text = parts.filter((part) => Boolean(part && part.length > 0)).join("\n");
    return text.length > 0 ? text : undefined;
}
function resultIdentity(id, status, exitCode, elapsed, classification) {
    return `[${id} · ${status} · exit ${exitCode} · ${elapsed} · lifecycle ${classification}]`;
}
function outputIdentity(id, status, elapsed) {
    return `[${id} · ${status} · ${elapsed}]`;
}
function logGaps(id) {
    try {
        statSync(evidenceLogPath(id));
        return [];
    }
    catch (error) {
        return [{ kind: "read", detail: error instanceof Error ? error.message : String(error) }];
    }
}
function parserDiagnostics(run) {
    if (!run.diagnostics.length)
        return undefined;
    return `[parser: ${run.diagnostics.join("; ")}]`;
}
function retrievalHint(id) {
    return `Retrieve retained evidence with subagent_output id="${id}" mode="raw" (16 KiB default, up to 64 KiB, caller cursor; tail:true starts at the newest bytes).`;
}
function bestParsed(run) {
    return run.finalText || run.lastActivity || "";
}
function isRoutineComplete(lifecycle) {
    return lifecycle.classification === "complete" && !lifecycle.incomplete;
}
function streamEvidence(run) {
    const parts = [
        !run.sawEnd ? "no agent_end or agent_settled event" : "terminal event observed",
        run.unmatchedToolCalls.length
            ? `unmatched tools: ${run.unmatchedToolCalls.map((call) => call.id ? `${call.toolName} (${call.id})` : call.toolName).join(", ")}`
            : "no unmatched tools",
    ];
    return `Stream evidence: ${parts.join("; ")}.`;
}
function callContext(id, meta, request, scopeKey, surface, terminal) {
    const state = collectRunFailures(id, meta.cwd, terminal);
    const statusResource = `${surface}:${scopeKey}:${id}`;
    const statusCursor = inspectStatusRevision({
        resource: statusResource,
        contentRevision: contentRevisionFor(id, meta),
        failureRevision: failureRevision(state),
    }).nextCursor;
    return { id, meta, request, scopeKey, state, statusResource, statusCursor, terminal };
}
function incidentResource(ctx) {
    return sharedIncidentResource(ctx.scopeKey, ctx.id);
}
/**
 * Shared failure section: whole rows when they fit, otherwise exact counts plus a resuming cursor.
 * Terminal runs list only actionable/incomplete rows and count unclassified history (#315).
 */
function failureSection(ctx, cap, detail = "compact") {
    const summarize = ctx.terminal ? formatTerminalIncidentSummary : formatIncidentSummary;
    if (!summarize(ctx.state, { maxBytes: Number.MAX_SAFE_INTEGER }).text)
        return undefined;
    return (budget) => summarize(ctx.state, {
        maxBytes: cap === undefined ? budget : Math.min(budget, cap),
        resource: incidentResource(ctx),
        retrieval: `pass as cursor to subagent_result/subagent_output id="${ctx.id}"`,
        detail,
    }).text || undefined;
}
/** An explicit history request: `history: true`. */
function wantsHistory(request) {
    return isAll(request.history);
}
/** An incident page is served for an incident cursor or an explicit history request. */
function wantsIncidentPage(request) {
    return isIncidentCursor(request.cursor) || wantsHistory(request);
}
function envelopeText(input) {
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
function assembleIncidentPage(ctx, identity) {
    const cursor = isIncidentCursor(ctx.request.cursor) ? ctx.request.cursor : undefined;
    const scope = wantsHistory(ctx.request) ? "all" : incidentCursorScope(cursor) ?? "actionable";
    return envelopeText({
        maxBytes: budgetFor("answer", ctx.request.maxBytes),
        identity: `${identity} ${incidentPageHeading(scopedFailures(ctx.state, scope).length, scope)}`,
        verbatim: (budget) => incidentVerbatimPage(ctx.state, { cursor, scope, maxBytes: budget, resource: incidentResource(ctx) }),
        statusCursor: ctx.statusCursor,
    });
}
/** Caller-owned status cursor: unchanged → a small no-change response. */
function maybeUnchanged(ctx, identity) {
    const cursor = ctx.request.cursor;
    if (!cursor || cursorKind(cursor) !== "s")
        return undefined;
    const inspected = inspectStatusRevision({
        cursor,
        resource: ctx.statusResource,
        contentRevision: contentRevisionFor(ctx.id, ctx.meta),
        failureRevision: failureRevision(ctx.state),
    });
    if (inspected.change !== "none")
        return undefined;
    const active = actionableFailures(ctx.state).length;
    return envelopeText({
        maxBytes: budgetFor("status", ctx.request.maxBytes),
        identity: `${identity} · unchanged`,
        failure: active ? `${active} active failure observation(s), unchanged.` : undefined,
        decision: formatUnchangedEvidence(cursor),
        statusCursor: inspected.nextCursor,
    });
}
/** Status-change facts for a status cursor that did not match. */
function changeDiagnostics(ctx) {
    const cursor = ctx.request.cursor;
    if (!cursor || cursorKind(cursor) !== "s")
        return undefined;
    const inspected = inspectStatusRevision({
        cursor,
        resource: ctx.statusResource,
        contentRevision: contentRevisionFor(ctx.id, ctx.meta),
        failureRevision: failureRevision(ctx.state),
    });
    if (inspected.change === "failure")
        return "change=failure";
    if (inspected.change === "reset")
        return "reset=stale-cursor (status cursor from another run, surface, or scope)";
    return "change=content";
}
/** Page cursor for answer/raw pagers; status cursors start a fresh page. */
function pageCursorFor(cursor) {
    if (!cursor)
        return undefined;
    return cursorKind(cursor) === "s" ? undefined : cursor;
}
function isContinuationPage(cursor) {
    return cursorKind(cursor) === "t";
}
/** An explicit end-anchored raw read: `tail: true`. */
function wantsTail(request) {
    return isAll(request.tail);
}
function rawPage(ctx, cursor, remaining) {
    const page = pageRetainedFile(evidenceLogPath(ctx.id), {
        cursor,
        maxBytes: remaining,
        resource: `raw:${ctx.scopeKey}:${ctx.id}`,
        ...(wantsTail(ctx.request) ? { direction: "backward" } : {}),
    });
    // A forward raw page points at the end-anchored read: a multi-MB retained
    // log must not cost one round-trip per page to reach its newest bytes (#618).
    if (page.direction === "backward" || !page.hasMore)
        return page;
    return { ...page, via: "tail:true reads the newest bytes first" };
}
function answerPage(ctx, text, cursor, remaining, maxLines) {
    return pageVerbatimText(text, {
        cursor,
        maxBytes: remaining,
        maxLines,
        resource: `answer:${ctx.scopeKey}:${ctx.id}`,
    });
}
/** Answer pages keep half the budget on first pages and nearly all on continuations. */
function answerReserve(maxBytes, cursor) {
    return isContinuationPage(cursor) ? maxBytes - CONTINUATION_FAILURE_BYTES : Math.floor(maxBytes / 2);
}
function outputLineCap(request) {
    return positiveInt(request.lines) ?? OUTPUT_PAGE_DEFAULTS.logLines;
}
/** Answer-page line cap for subagent_result: only an explicit `lines` request caps it. */
function answerLineCap(request) {
    return positiveInt(request.lines);
}
/**
 * Explicit opt-in facts (#321). Ordinary payloads omit spend and tool
 * activity; `include: ["cost"]` adds one spend line and `include: ["tools"]`
 * one tool-call count line (with the distinct tool names), both computed from
 * the same parse as the rest of the payload.
 */
function optInFacts(run, request) {
    const { include, unknown } = readOutputInclude(request.include);
    const lines = [];
    if (include.has("cost")) {
        const spend = fmtSpend(run.usage);
        lines.push(`spend: ${spend || "none recorded"}`);
    }
    if (include.has("tools")) {
        const calls = run.toolCallCount ?? run.toolCalls.length;
        const distinct = [...new Set(run.toolCalls)];
        lines.push(`tools: ${calls} call${calls === 1 ? "" : "s"}${distinct.length ? ` · distinct: ${distinct.join(", ")}` : ""}`);
    }
    if (unknown.length)
        lines.push(`include: ignored unknown value(s) ${unknown.join(", ")}; supported: cost, tools`);
    return lines.length ? lines.join("\n") : undefined;
}
export function assembleUnreadableMetadata(id, detail, request = {}) {
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
export function assembleOwnershipGap(id, kind, request = {}) {
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
export function resolveRunAccess(id, request, session) {
    const loaded = loadRunRecord(id);
    if (loaded.kind === "missing")
        return loaded;
    if (loaded.kind === "unreadable")
        return loaded;
    if (isAll(request.all))
        return { kind: "ok", meta: loaded.meta };
    const resolved = resolveActiveOrigin(session);
    // Unwired factories (no session provider) exist only for unit tests that
    // build a tool without the extension. index.ts always passes a provider,
    // so registered tools never take this branch; see the
    // "registered tools fail closed" test in subagent_output_budget.test.mjs.
    if (!resolved.wired)
        return { kind: "ok", meta: loaded.meta };
    if (!resolved.available || !resolved.origin) {
        return { kind: "denied", payload: assembleOwnershipGap(id, "unavailable", request) };
    }
    const owner = ownership(loaded.meta, resolved.origin);
    if (owner !== "own") {
        return { kind: "denied", payload: assembleOwnershipGap(id, owner, request) };
    }
    return { kind: "ok", meta: loaded.meta };
}
function defaultScope() {
    return listScopeKey(false, undefined, process.pid);
}
export function assembleRunningResult(id, meta, request = {}, scopeKey = defaultScope(), timingLine) {
    timingLine = [timingLine, projectionDiagnostic(meta)].filter(Boolean).join("\n");
    const st = String(effectiveStatus(meta));
    const terminal = st !== "running" && st !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", terminal);
    const identity = `[${id} · ${assignmentLabel(meta)} · ${elapsedFor(meta)}]`;
    if (wantsIncidentPage(request))
        return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged)
        return unchanged;
    return envelopeText({
        maxBytes: budgetFor("answer", request.maxBytes),
        identity,
        failure: failureSection(ctx),
        decision: `Run ${id} is still running — no result yet. You'll be notified when it finishes; don't poll.`,
        diagnostics: (() => {
            const run = parseRun(id);
            return joinSections([changeDiagnostics(ctx), optInFacts(run, request), timingLine || undefined, parserDiagnostics(run)]);
        })(),
        gaps: logGaps(id),
        statusCursor: ctx.statusCursor,
    });
}
function assembleRaw(id, meta, status, request, surface, scopeKey) {
    const terminal = status !== "running" && status !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, surface === "result" ? "subagent_result" : "subagent_output", terminal);
    const identity = outputIdentity(id, assignmentLabel(meta), elapsedFor(meta));
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged)
        return unchanged;
    const run = parseRun(id);
    const maxBytes = budgetFor("rawPage", request.maxBytes);
    const continuing = cursorKind(request.cursor) === "f";
    return envelopeText({
        maxBytes,
        identity: `${identity} raw retained log${wantsTail(request) ? " · newest first" : ""}`,
        // Raw evidence keeps whole excerpts and evidence paths.
        failure: failureSection(ctx, continuing ? CONTINUATION_FAILURE_BYTES : 1024, "full"),
        diagnostics: joinSections([projectionDiagnostic(meta), changeDiagnostics(ctx), optInFacts(run, request), parserDiagnostics(run)]),
        gaps: logGaps(id),
        verbatim: (remaining) => rawPage(ctx, pageCursorFor(request.cursor), remaining),
        verbatimReserve: Math.floor(maxBytes / 2),
        statusCursor: ctx.statusCursor,
    });
}
export function assembleSubagentOutput(id, meta, request = {}, healthLine = "", scopeKey = defaultScope()) {
    healthLine = [healthLine, projectionDiagnostic(meta)].filter(Boolean).join("\n");
    const st = String(effectiveStatus(meta));
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f")
        return assembleRaw(id, meta, st, request, "output", scopeKey);
    const terminal = st !== "running" && st !== "orphaned";
    const ctx = callContext(id, meta, request, scopeKey, "subagent_output", terminal);
    const identity = outputIdentity(id, assignmentLabel(meta), elapsedFor(meta));
    if (wantsIncidentPage(request))
        return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged)
        return unchanged;
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
        optInFacts(run, request),
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
export function assembleOrphanedResult(id, meta, healthLine, request = {}, scopeKey = defaultScope()) {
    healthLine = [healthLine, projectionDiagnostic(meta)].filter(Boolean).join("\n");
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f")
        return assembleRaw(id, meta, "orphaned", request, "result", scopeKey);
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", false);
    const identity = `[${id} · ${assignmentLabel(meta)} · ${elapsedFor(meta)}]`;
    if (wantsIncidentPage(request))
        return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged)
        return unchanged;
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
            optInFacts(run, request),
            healthLine || undefined,
            parserDiagnostics(run),
            gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            formatOrphanedResult(run, "").split("\n").slice(0, 2).join("\n"),
            "--- best-current parsed output ---",
            retrievalHint(id),
        ]),
        gaps,
        verbatim: parsed
            ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining, answerLineCap(request))
            : gaps.length === 0
                ? (remaining) => rawPage(ctx, pageCursor, remaining)
                : undefined,
        verbatimReserve: answerReserve(maxBytes, pageCursor),
        statusCursor: ctx.statusCursor,
    });
}
export function assembleSubagentResult(id, meta, request = {}, healthLine = "", scopeKey = defaultScope()) {
    healthLine = [healthLine, projectionDiagnostic(meta)].filter(Boolean).join("\n");
    const st = effectiveStatus(meta);
    if (isRawMode(request.mode) || cursorKind(request.cursor) === "f")
        return assembleRaw(id, meta, String(st), request, "result", scopeKey);
    const ctx = callContext(id, meta, request, scopeKey, "subagent_result", true);
    const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
    const run = parseRunForLifecycle(id);
    const stop = meta.timing?.stopReason;
    const delivery = meta.recipe?.workspace ? workspaceDelivery(meta.recipe.workspace, meta.cwd, Boolean(meta.sandbox), id) : undefined;
    const partial = stop ? `Partial result · stopped: ${stop}. Unfinished checks remain unverified.${run.unmatchedToolCalls.length ? "\nOpen at stop: " + run.unmatchedToolCalls.map(call => call.toolName).join(", ") : ""}${delivery ? "" : "\nWorkspace: " + meta.cwd}` : undefined;
    const denial = meta.sandbox && meta.recipe?.workspace?.mode === "worktree" && run.deniedWorktreeGitOperation
        ? worktreeDenialText(run.deniedWorktreeGitOperation, meta.cwd) : undefined;
    const scratch = meta.taskScratch ? "Task scratch: " + meta.taskScratch : undefined;
    healthLine = joinSections([partial, delivery, denial, scratch, healthLine]) ?? "";
    const lifecycle = resolveLifecycle(meta, run);
    const identity = resultIdentity(id, assignmentLabel(meta), exit, elapsedFor(meta), lifecycle.classification);
    if (wantsIncidentPage(request))
        return assembleIncidentPage(ctx, identity);
    const unchanged = maybeUnchanged(ctx, identity);
    if (unchanged)
        return unchanged;
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
                optInFacts(run, request),
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                streamEvidence(run),
                parserDiagnostics(run),
                gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
                "--- best available parsed output ---",
                retrievalHint(id),
            ]),
            gaps,
            verbatim: parsed ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining, answerLineCap(request)) : undefined,
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
                optInFacts(run, request),
                healthLine || undefined,
                formatLifecycleDiagnostics(lifecycle),
                parserDiagnostics(run),
                formatLostResult(run, "").split("\n").slice(0, 2).join("\n"),
                "--- best-available parsed output ---",
                retrievalHint(id),
            ]),
            gaps,
            verbatim: parsed
                ? (remaining) => answerPage(ctx, parsed, pageCursor, remaining, answerLineCap(request))
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
            optInFacts(run, request),
            healthLine || undefined,
            exceptional,
            parserDiagnostics(run),
            !answer && gaps.length ? "Child log is missing or unreadable; this is not an empty healthy result." : undefined,
            !answer ? retrievalHint(id) : undefined,
        ]),
        gaps,
        verbatim: (remaining) => answerPage(ctx, answer || fallback || "(no final answer parsed)", pageCursor, remaining, answerLineCap(request)),
        verbatimReserve: reserve,
        statusCursor: ctx.statusCursor,
    });
}
/**
 * Per-run incident counts for list rows, cached by a fingerprint of everything
 * they derive from: the child log's identity (a scan source), the failure
 * journal's fingerprint (appends, truncation, deletion, pending in-process
 * records), and the terminal flag. A list call recomputes only runs whose log
 * or journal changed, so an idle registry is not rescanned on every call.
 */
const listIncidentCache = new Map();
const LIST_INCIDENT_CACHE_MAX = 4096;
let listIncidentComputations = 0;
function listIncidentKey(id, terminal) {
    return JSON.stringify([terminal, fileChangeIdentity(evidenceLogPath(id)), failureJournalFingerprint(failurePath(id))]);
}
export function listIncidentCount(id, cwd, terminal) {
    const cacheId = `${id}\0${cwd}`;
    const before = listIncidentKey(id, terminal);
    const hit = listIncidentCache.get(cacheId);
    if (hit && hit.key === before)
        return hit.value;
    const state = collectRunFailures(id, cwd, terminal);
    listIncidentComputations += 1;
    // List rows count what needs action; unclassified and expected failures are history.
    const active = actionableFailures(state);
    const value = { count: active.length, actionRequired: active.filter(requiresAction).length, revision: failureRevision(state) };
    // Cache only a stable read: when the scan (or a concurrent writer) changed
    // the log or journal meanwhile, the next call recomputes and caches then.
    listIncidentCache.delete(cacheId);
    if (listIncidentKey(id, terminal) !== before)
        return value;
    listIncidentCache.set(cacheId, { key: before, value });
    while (listIncidentCache.size > LIST_INCIDENT_CACHE_MAX)
        listIncidentCache.delete(listIncidentCache.keys().next().value);
    return value;
}
/** Test seam: how many list incident counts were computed rather than served from cache. */
export function listIncidentComputationCount() {
    return listIncidentComputations;
}
/** Drop cached list incident counts (all, or one run). */
export function resetListIncidentCache(id) {
    if (id === undefined)
        listIncidentCache.clear();
    else
        for (const key of [...listIncidentCache.keys()])
            if (key.startsWith(`${id}\0`))
                listIncidentCache.delete(key);
}
export function formatIncidentLabel(count, actionRequired = 0) {
    if (count <= 0)
        return "";
    return `${count} incident${count === 1 ? "" : "s"}${actionRequired ? ` · ${actionRequired} action required` : ""}`;
}
export function listIncidentLabel(id, cwd, terminal) {
    const { count, actionRequired } = listIncidentCount(id, cwd, terminal);
    return formatIncidentLabel(count, actionRequired);
}
/**
 * Status revisions for a list: every row's lifecycle facts (content) and
 * every row's full failure signature (failure-only changes).
 */
export function listRevisions(items, failureSignatures, assignmentOf = (meta) => assignmentFor(meta, effectiveStatus(meta))) {
    return {
        contentRevision: revisionOf(items.map((item) => [
            item.id,
            item.status,
            item.meta ? assignmentOf(item.meta).revision : null,
            item.meta?.status ?? null,
            item.meta?.exitCode ?? null,
            item.meta?.endedAt ?? null,
        ])),
        failureRevision: revisionOf(items.map((item, index) => [item.id, failureSignatures[index] ?? ""])),
    };
}
export function assembleSubagentListPayload(input) {
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
    const abandonedLaunches = input.abandonedLaunches ?? [];
    const abandonedGrace = describeAbandonedLaunchGrace();
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
        abandonedLaunches.length
            ? `${abandonedLaunches.length} abandoned launch record(s), not run evidence and not counted: the launch stopped before any child started (prompt written, no metadata, no log): ${abandonedLaunches.slice(0, 3).join(", ")}${abandonedLaunches.length > 3 ? ", …" : ""}. Cleanup reclaims them after ${abandonedGrace}; remove one now with subagent_stop <id>.`
            : undefined,
        statusCursorInput && status.change === "failure" ? "change=failure" : undefined,
        statusCursorInput && status.change === "reset" ? "reset=stale-cursor (status cursor from another scope or filter)" : undefined,
    ]);
    const gaps = [
        ...(input.indexError ? [{ kind: "read", detail: input.indexError }] : []),
        ...(unreadable.length ? [{ kind: "read", detail: `${unreadable.length} unreadable run metadata record(s)` }] : []),
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
export function unknownRunError(id) {
    return new Error(`Unknown run id: ${id}`);
}
/** Human-readable grace period for abandoned launch records. */
function describeAbandonedLaunchGrace() {
    const minutes = Math.round(ABANDONED_LAUNCH_GRACE_MS / 60_000);
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `${minutes} minutes`;
}
export { originOf };
