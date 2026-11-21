// Generated fixed launch domain from packages/pi-better-subagents/tools.ts. Do not edit directly.
/**
 * Model-facing tool definitions — the seam between pi registration and tests.
 *
 * index.ts registers EXACTLY the objects these factories return
 * (`pi.registerTool(subagentListTool(Type))`), so a test that invokes a
 * factory-built tool's `execute` exercises the same handler logic the model
 * reaches — there is no second, drift-prone copy of the list/output/result/
 * stop behavior.
 *
 * The factories take the `Type` schema builder as a parameter instead of
 * importing `@earendil-works/pi-ai` directly: that package only exists inside
 * the pi runtime, and keeping this module free of it lets `node --test` load
 * the handlers with a trivial stub (the parameters schema is inert data as
 * far as `execute` is concerned).
 */
import { createHash } from "node:crypto";
import { assignmentFor, projectAssignment, createAssignmentProjector, withAssignmentObservations } from "./assignment-projection.mjs";
import { readMeta, listRunRecords, effectiveStatus, isFinalResultStatus } from "./registry.domain.mjs";
import { stopRun } from "./stop.domain.mjs";
import { SUBAGENT_LIST_DEFAULT_LIMIT, SUBAGENT_LIST_MAX_LIMIT, SUBAGENT_LIST_STATUSES, collectSubagentList, formatSubagentListRow, listFolderScopeKey, normalizeSubagentListOptions, } from "./list.domain.mjs";
import { assembleOrphanedResult, assembleRunningResult, assembleSubagentListPayload, assembleSubagentOutput, assembleUnreadableMetadata, listIncidentCount, formatIncidentLabel, listRevisions, requestScopeKey, resolveActiveOrigin, resolveRunAccess, assembleSubagentResult, unknownRunError, } from "./output-payload.domain.mjs";
import { budgetFor, readOutputControls } from "./shared-log-utils.domain.mjs";
import { readRunFailures } from "./failures.domain.mjs";
import { actionablePermissionBlockers } from "./shared-failure-observations.domain.mjs";
import { describeTiming } from "./timing.domain.mjs";
import { extractChildEventFactsFromLog, loadHealthThresholdsFromConfig, observeRunHealth, } from "./health-observation.domain.mjs";
import { formatHealthDiagnosticLine, statusThemeColor, truncateToVisibleWidth, } from "./health-surface.mjs";
/** Observe one run for list/output/result diagnostics (#66/#67). Best-effort. */
function observeMetaHealth(meta, now = Date.now()) {
    // Observation uses durable RunStatus (orphaned/lost/running/…); transient
    // effective "exited" falls back to meta.status so process liveness stays truthful.
    const eff = effectiveStatus(meta);
    const status = eff === "exited" ? meta.status : eff;
    const { facts, rawLog } = extractChildEventFactsFromLog(meta.id, { now });
    return observeRunHealth({
        status,
        now,
        facts,
        rawLog,
        thresholds: loadHealthThresholdsFromConfig(),
        startedAt: meta.startedAt,
    });
}
/** Health diagnostics plus the harness timing reason (deadline / ceiling / stuck), one line each. */
function diagnosticLines(meta) {
    const status = String(effectiveStatus(meta));
    return [formatHealthDiagnosticLine(observeMetaHealth(meta)), describeTiming({ ...meta, status: status === "exited" ? meta.status : status })?.line]
        .filter(Boolean).join("\n");
}
/**
 * Resolve public output-control names (#321): canonical `max_bytes` / `lines`,
 * deprecated `maxBytes` / `tail_lines`; the canonical name wins when both are
 * given. The payload assemblers only see the normalized `maxBytes` / `lines`.
 */
function normalizeOutputRequest(params) {
    const controls = readOutputControls(params);
    const { max_bytes: _canonicalBytes, tail_lines: _aliasLines, ...rest } = params;
    return {
        ...rest,
        maxBytes: controls.maxBytes,
        lines: controls.lines,
    };
}
const MAX_BYTES_ALIAS_DESCRIPTION = "Deprecated alias for max_bytes. max_bytes wins when both are given.";
const HISTORY_DESCRIPTION = "If true, return an incident page that also lists failure history: unclassified child tool errors, expected failures, and recovered or superseded incidents. Default output lists only failures that need action and counts the rest.";
const TAIL_DESCRIPTION = "With mode=raw: read from the newest retained byte first instead of byte 0. The page is end-anchored and nextCursor then pages toward the oldest bytes; once the start is reached the cursor reads only bytes appended later. Use this to reach the end of a multi-MB log without paging from byte zero.";
const INCLUDE_DESCRIPTION = "Explicit opt-in facts omitted by default: \"cost\" adds one token/cost spend line, \"tools\" adds one tool-call count line with the distinct tool names.";
/** pi's tool-result text shape. */
export const text = (t) => ({ content: [{ type: "text", text: t }] });
/** Metadata has its own bounded allowance; it never embeds raw evidence or unbounded history. */
function permissionDetails(id, maxBytes) {
    const all = actionablePermissionBlockers(readRunFailures(id));
    if (!all.length)
        return {};
    const permissionBlockers = [];
    const allowance = Math.min(4096, maxBytes);
    if (Buffer.byteLength(JSON.stringify({ permissionBlockers, permissionBlockersOmitted: all.length })) > allowance) {
        throw new Error("Permission blocker metadata cannot fit this budget; retry with a larger max_bytes.");
    }
    for (const blocker of all) {
        if (permissionBlockers.length === 32 || Buffer.byteLength(JSON.stringify({ permissionBlockers: [...permissionBlockers, blocker],
            permissionBlockersOmitted: all.length - permissionBlockers.length - 1 })) > allowance)
            break;
        permissionBlockers.push(blocker);
    }
    return { permissionBlockers, ...(all.length > permissionBlockers.length ? { permissionBlockersOmitted: all.length - permissionBlockers.length } : {}) };
}
const SUBAGENT_RESULT_PREVIEW_LINES = 8;
function resultTextContent(result) {
    const content = result?.content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((c) => c && (c.type === undefined || c.type === "text"))
        .map((c) => c.text ?? "")
        .join("\n");
}
function parseSubagentResultHead(head) {
    const raw = String(head ?? "");
    const match = raw.match(/^\[([^\s\]]+)\s+·\s+([^·\]]+)/);
    if (!match)
        return {};
    return { id: match[1], status: match[2]?.trim() };
}
function nonEmptyPreviewLines(lines) {
    const preview = [];
    for (const line of lines) {
        if (/^---\s+raw log tail\s+---$/i.test(line.trim()))
            break;
        if (line.trim() === "")
            continue;
        preview.push(line);
        if (preview.length >= SUBAGENT_RESULT_PREVIEW_LINES)
            break;
    }
    return preview;
}
export function buildSubagentResultDisplayDetails(body) {
    const fullLines = String(body ?? "").split(/\r?\n/);
    const head = fullLines[0] || "subagent_result";
    const { id, status } = parseSubagentResultHead(head);
    const rest = fullLines.slice(1);
    const compactLines = nonEmptyPreviewLines(rest);
    return {
        kind: "subagent-result-display",
        id,
        status,
        head,
        fullLineCount: fullLines.length,
        compactLines,
        foldedLineCount: Math.max(0, rest.length - compactLines.length),
    };
}
function subagentResultText(body) {
    return {
        content: [{ type: "text", text: body }],
        details: buildSubagentResultDisplayDetails(body),
    };
}
function themed(theme, color, value) {
    const fg = theme?.fg;
    return typeof fg === "function" ? fg(color, value) : value;
}
function wrapLineToVisibleWidth(line, width) {
    const str = String(line ?? "");
    const max = Math.max(1, Number(width) || 80);
    if (truncateToVisibleWidth(str, max) === str)
        return [str];
    const out = [];
    let current = "";
    let visible = 0;
    let i = 0;
    while (i < str.length) {
        if (str[i] === "\u001b" || str[i] === "\u009b") {
            const match = str.slice(i).match(/^[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/);
            if (match) {
                current += match[0];
                i += match[0].length;
                continue;
            }
        }
        if (str[i] === "<") {
            const close = str.indexOf(">", i);
            if (close !== -1) {
                const tag = str.slice(i, close + 1);
                if (/^<\/?[a-zA-Z][\w-]*>$/.test(tag) || tag === "</>") {
                    current += tag;
                    i = close + 1;
                    continue;
                }
            }
        }
        if (visible >= max) {
            out.push(current);
            current = "";
            visible = 0;
        }
        current += str[i];
        visible += 1;
        i += 1;
    }
    out.push(current);
    return out;
}
function renderLines(lines, mode = "truncate") {
    return {
        render(width = 80) {
            return mode === "wrap"
                ? lines.flatMap((line) => wrapLineToVisibleWidth(line, width))
                : lines.map((line) => truncateToVisibleWidth(line, width));
        },
        invalidate() { },
    };
}
export function renderSubagentResultDisplay(result, options = {}, theme = {}) {
    const fullText = resultTextContent(result);
    const details = result?.details
        ?? buildSubagentResultDisplayDetails(fullText);
    const expanded = options?.expanded === true;
    const status = details.status ?? "result";
    const statusText = themed(theme, displayThemeColor(status), status);
    const meta = [details.id, `${details.fullLineCount} lines`].filter(Boolean).join(" · ");
    if (expanded) {
        return renderLines([
            `${themed(theme, "accent", "subagent_result")} ${statusText}${meta ? themed(theme, "dim", ` · ${meta}`) : ""}`,
            themed(theme, "dim", "Full displayed result. Click or collapse to fold."),
            "",
            ...fullText.split(/\r?\n/),
        ], "wrap");
    }
    const folded = details.foldedLineCount > 0
        ? themed(theme, "dim", `Folded ${details.foldedLineCount} display lines. Click or expand for full result. Model payload unchanged.`)
        : themed(theme, "dim", "Compact result. Expand for full display if needed.");
    return renderLines([
        `${themed(theme, "accent", "subagent_result")} ${statusText}${meta ? themed(theme, "dim", ` · ${meta}`) : ""}`,
        details.head,
        "",
        themed(theme, "dim", "preview"),
        ...details.compactLines,
        folded,
    ]);
}
function displayThemeColor(status) {
    const color = statusThemeColor(status);
    return color === "danger" ? "error" : color;
}
/** The session provider bound to this tool call's host context. */
function forCall(session, ctx) {
    const provider = session.getActiveOrigin;
    if (typeof provider !== "function")
        return session;
    return { ...session, getActiveOrigin: () => provider(ctx) };
}
/**
 * Folder this list call runs in. `ctx.cwd` is the foreground's live workspace
 * and wins; a readable origin is the fallback for hosts that omit it. Listing
 * by folder never needs a foreground session id, so an unavailable origin does
 * not narrow the default scope.
 */
function listCwd(ctx, origin) {
    const ctxCwd = ctx?.cwd;
    if (typeof ctxCwd === "string" && ctxCwd !== "")
        return ctxCwd;
    return origin?.cwd ?? process.cwd();
}
export function subagentListTool(Type, baseSession = {}) {
    return {
        name: "subagent_list",
        label: "List Subagents",
        description: `List background subagent runs with compact status rows. Non-blocking. ` +
            `Default: current folder and its descendants across foreground sessions, newest first, ` +
            `limit ${SUBAGENT_LIST_DEFAULT_LIMIT} (1 KiB page). ` +
            `Pass all:true for machine-global; limit is clamped to max ${SUBAGENT_LIST_MAX_LIMIT}. ` +
            `Pass cursor to continue. Incident counts are compact; full failure text lives on subagent_result/output.`,
        promptSnippet: "List background subagent runs and their status",
        parameters: Type.Object({
            all: Type.Optional(Type.Boolean({ description: "If true, list every run on this machine. Default false = current folder and its descendants, regardless of foreground session." })),
            limit: Type.Optional(Type.Number({ description: `Maximum rows to display (default ${SUBAGENT_LIST_DEFAULT_LIMIT}, max ${SUBAGENT_LIST_MAX_LIMIT}; larger values are clamped).` })),
            status: Type.Optional(Type.Array(Type.String(), { description: `Effective statuses to include: ${SUBAGENT_LIST_STATUSES.join(", ")}.` })),
            cursor: Type.Optional(Type.String({ description: "Caller-owned page or status cursor from a previous list response." })),
            max_bytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 1 KiB, max 4 KiB)." })),
            maxBytes: Type.Optional(Type.Number({ description: MAX_BYTES_ALIAS_DESCRIPTION })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const session = forCall(baseSession, ctx);
            const p = normalizeOutputRequest((params ?? {}));
            const now = Date.now();
            if (session.observeList) {
                const options = normalizeSubagentListOptions(p);
                const cwd = listCwd(ctx, resolveActiveOrigin(session).origin);
                const statusCursor = p.cursor?.startsWith("work-status:") ? p.cursor.slice("work-status:".length) : undefined;
                const snapshot = await session.observeList({ ...(options.all ? {} : { cwd }),
                    ...(options.statuses ? { statuses: [...options.statuses] } : {}), limit: Math.max(1, options.limit),
                    ...(p.cursor && !statusCursor ? { cursor: p.cursor } : {}) });
                const incidents = new Map(snapshot.rows.map((row) => [row.meta.id, listIncidentCount(row.meta.id, row.meta.cwd, !["running", "orphaned"].includes(row.meta.status))]));
                const revision = createHash("sha256").update(JSON.stringify([snapshot.scopeRevision,
                    [...incidents].map(([id, incident]) => [id, incident.revision])])).digest("hex");
                const status = `work-status:${revision}`;
                if (statusCursor === revision && snapshot.status === "ready")
                    return text(`Subagents unchanged. statusCursor=${status}`);
                const budget = budgetFor("list", p.maxBytes);
                const header = [...options.warnings, `Subagents: ${snapshot.totalMatching} matching${snapshot.status === "ready" ? "" : `; ${snapshot.status}: ${snapshot.reason ?? "source verification pending"}`}.`].join("\n");
                const lines = [header];
                let last;
                for (const row of options.limit === 0 ? [] : snapshot.rows) {
                    const incident = incidents.get(row.meta.id);
                    const line = formatSubagentListRow(row.meta, { assignment: row.assignment, status: row.assignment.state,
                        processStatus: row.assignment.processStatus, now, compact: true,
                        health: row.health ? observeRunHealth({ ...row.health, status: row.assignment.processStatus === "exited" ? row.meta.status : row.assignment.processStatus, now, startedAt: row.meta.startedAt }) : undefined,
                        failure: formatIncidentLabel(incident.count, incident.actionRequired) });
                    const footer = `\nnextCursor=${row.cursor}\nstatusCursor=${status}`;
                    if (Buffer.byteLength([...lines, line].join("\n") + footer) > budget)
                        break;
                    lines.push(line);
                    last = row;
                }
                if (!last && snapshot.rows.length && options.limit > 0)
                    throw new Error("The list row and cursor cannot fit max_bytes; retry with a larger budget.");
                if (last && (snapshot.nextCursor || last !== snapshot.rows.at(-1)))
                    lines.push(`nextCursor=${last.cursor}`);
                lines.push(`statusCursor=${status}`);
                return { ...text(lines.join("\n")), details: { snapshot: { ...snapshot, rows: snapshot.rows.slice(0, last ? snapshot.rows.indexOf(last) + 1 : 0) } } };
            }
            const index = listRunRecords();
            const metas = index.metas;
            const resolved = resolveActiveOrigin(session);
            // List scope is a folder, not a session: peers in the same folder
            // are listed even when they were spawned by another foreground.
            const cwd = listCwd(ctx, resolved.origin);
            const scopeKey = listFolderScopeKey(p.all === true, cwd);
            const project = createAssignmentProjector();
            const assignments = new Map();
            const assignmentOf = (meta) => {
                let assignment = assignments.get(meta.id);
                if (!assignment) {
                    assignment = project(meta, effectiveStatus(meta));
                    assignments.set(meta.id, assignment);
                }
                return assignment;
            };
            const healthCache = new Map();
            const healthById = (id) => {
                const hit = healthCache.get(id);
                if (hit)
                    return hit;
                const meta = metas.find((m) => m.id === id) ?? readMeta(id);
                if (!meta)
                    return undefined;
                const obs = observeMetaHealth(meta, now);
                healthCache.set(id, obs);
                return obs;
            };
            const collected = collectSubagentList({
                metas,
                params: p,
                cwd,
                now,
                statusOf: (meta) => assignmentOf(meta).state,
                assignmentOf,
                healthById,
            });
            const items = collected.items;
            const incidents = new Map(items.map((row) => [row.meta.id, listIncidentCount(row.meta.id, row.meta.cwd, row.meta.status !== "running" && row.meta.status !== "orphaned")]));
            const revisions = listRevisions(items.map((row) => ({ id: row.meta.id, status: String(row.status), meta: row.meta })), items.map((row) => incidents.get(row.meta.id)?.revision ?? ""), assignmentOf);
            const statusesKey = Array.isArray(p.status) ? [...p.status].map(String).sort().join(",") : String(p.status ?? "");
            const incidentRuns = items.filter((row) => (incidents.get(row.meta.id)?.count ?? 0) > 0).length;
            return text(assembleSubagentListPayload({
                warnings: collected.warnings,
                items,
                render: (row) => {
                    const incident = incidents.get(row.meta.id);
                    return formatSubagentListRow(row.meta, {
                        assignment: assignmentOf(row.meta),
                        processStatus: effectiveStatus(row.meta),
                        status: row.status,
                        now,
                        health: healthById(row.meta.id),
                        failure: formatIncidentLabel(incident?.count ?? 0, incident?.actionRequired ?? 0),
                    });
                },
                limit: Math.max(1, collected.limit),
                cursor: p.cursor,
                maxBytes: p.maxBytes,
                contentRevision: revisions.contentRevision,
                failureRevision: revisions.failureRevision,
                scopeKey,
                statusesKey,
                unreadable: index.unreadable,
                abandonedLaunches: index.abandoned,
                indexError: index.indexError,
                incidentRuns,
            }));
        },
    };
}
// ---- subagent_output ------------------------------------------------------
export function subagentOutputTool(Type, baseSession = {}) {
    return {
        name: "subagent_output",
        label: "Subagent Output",
        description: "Read a subagent run's current output without waiting. Default is a 1 KiB / 10-line excerpt of the current session. " +
            "Pass all:true to read a foreign-session id. Pass mode=raw for retained-log pages (16 KiB default, 64 KiB cap). " +
            "Pass tail:true with mode=raw to start from the newest retained bytes and page toward the oldest. " +
            "Pass cursor to continue or to poll for failure-only changes. Missing or unreadable logs are reported as gaps, not as empty healthy output. " +
            "Spend and tool counts are omitted unless include:[\"cost\",\"tools\"] asks for them.",
        promptSnippet: "Peek at a subagent's current output without waiting",
        promptGuidelines: [
            "Use subagent_output only when the user explicitly asks how a run is progressing. It never waits — do not call it in a loop.",
            "Do not poll unchanged output. If the response says no new evidence since a cursor, stop.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
            lines: Type.Optional(Type.Number({ description: "Max lines in the default excerpt (default 10)." })),
            tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines. lines wins when both are given." })),
            cursor: Type.Optional(Type.String({ description: "Caller-owned page or status cursor from a previous response." })),
            max_bytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 1 KiB, max 4 KiB; raw default 16 KiB, max 64 KiB)." })),
            maxBytes: Type.Optional(Type.Number({ description: MAX_BYTES_ALIAS_DESCRIPTION })),
            mode: Type.Optional(Type.String({ description: "raw = page retained log bytes. Default is the bounded assembled excerpt." })),
            tail: Type.Optional(Type.Boolean({ description: TAIL_DESCRIPTION })),
            include: Type.Optional(Type.Array(Type.String(), { description: INCLUDE_DESCRIPTION })),
            history: Type.Optional(Type.Boolean({ description: HISTORY_DESCRIPTION })),
            all: Type.Optional(Type.Boolean({ description: "If true, allow a foreign-session id. Default is current session only." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const session = forCall(baseSession, ctx);
            const p = normalizeOutputRequest(params);
            const access = resolveRunAccess(p.id, p, session);
            if (access.kind === "missing")
                throw unknownRunError(p.id);
            if (access.kind === "unreadable")
                return text(assembleUnreadableMetadata(p.id, access.detail, p));
            if (access.kind === "denied")
                return text(access.payload);
            const scopeKey = requestScopeKey(p, session);
            const healthLine = diagnosticLines(access.meta);
            const result = text(assembleSubagentOutput(p.id, access.meta, p, healthLine, scopeKey));
            const details = permissionDetails(p.id, budgetFor("log", p.maxBytes));
            return { ...result, details: { ...details, assignment: assignmentFor(access.meta, effectiveStatus(access.meta)) } };
        },
    };
}
// ---- subagent_result ------------------------------------------------------
export function subagentResultTool(Type, baseSession = {}) {
    return {
        name: "subagent_result",
        label: "Subagent Result",
        description: "Read a subagent's final output if it has finished. NEVER waits. Default current session. Ordinary answers are preserved verbatim in a 2048-byte UTF-8 page (max_bytes up to 8192 bytes, optional lines cap); pass cursor to reconstruct the rest. Pass all:true for a foreign-session id. mode=raw pages retained log bytes (16 KiB default, 64 KiB cap) and tail:true with mode=raw starts from the newest bytes. Failures and exceptional lifecycle facts come before progress. No tool-name histories or default cost lines; pass include:[\"cost\",\"tools\"] to opt in.",
        promptSnippet: "Read a finished subagent's final result (never waits)",
        promptGuidelines: [
            "Use subagent_result to collect a finished run's output. If it reports the run is still going, stop — do not poll; you'll be notified when it finishes.",
            "If the response includes nextCursor, call again with that cursor to read the rest of the answer. Do not summarize away unread pages.",
            "For a durable assignment outcome, inspect its evidence, then call subagent_result with the exact outcome_revision, disposition consumed or dismissed, and an interpretation note. Delivery and reading never acknowledge the worker's dependency wait.",
        ],
        parameters: Type.Object({
            operation_id: Type.Optional(Type.String({ description: "Assignment dependency whose bounded retained log to inspect." })),
            outcome_revision: Type.Optional(Type.Number({ description: "Exact assignment outcome revision being disposed." })),
            disposition: Type.Optional(Type.String({ description: "consumed or dismissed; records parent outcome disposition, never worker acknowledgement." })),
            note: Type.Optional(Type.String({ description: "Parent interpretation of the inspected outcome." })),
            id: Type.String({ description: "Run id from subagent_spawn." }),
            cursor: Type.Optional(Type.String({ description: "Caller-owned answer page or status cursor from a previous response." })),
            max_bytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 2048 bytes, max 8192 bytes)." })),
            maxBytes: Type.Optional(Type.Number({ description: MAX_BYTES_ALIAS_DESCRIPTION })),
            lines: Type.Optional(Type.Number({ description: "Optional line cap for each answer page (default: bytes only). nextCursor continues after the last line shown." })),
            tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines. lines wins when both are given." })),
            mode: Type.Optional(Type.String({ description: "raw = page retained log bytes (16 KiB default, 64 KiB cap). Default is the bounded assembled result." })),
            tail: Type.Optional(Type.Boolean({ description: TAIL_DESCRIPTION })),
            include: Type.Optional(Type.Array(Type.String(), { description: INCLUDE_DESCRIPTION })),
            history: Type.Optional(Type.Boolean({ description: HISTORY_DESCRIPTION })),
            all: Type.Optional(Type.Boolean({ description: "If true, allow a foreign-session id. Default is current session only." })),
        }),
        renderResult(result, options, theme) {
            return renderSubagentResultDisplay(result, options, theme);
        },
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const session = forCall(baseSession, ctx);
            const p = normalizeOutputRequest(params);
            const access = resolveRunAccess(p.id, p, session);
            if (access.kind === "missing")
                throw unknownRunError(p.id);
            if (access.kind === "unreadable") {
                return subagentResultText(assembleUnreadableMetadata(p.id, access.detail, p));
            }
            if (access.kind === "denied")
                return subagentResultText(access.payload);
            const meta = access.meta;
            // A saved result remains readable after its row leaves the live observation.
            const observed = access.retained ? undefined : await session.observeAssignment?.(meta.id);
            const outcome = meta.assignment ? baseSession.inspectOutcome?.(meta, params, ctx) : undefined;
            // Exact inspection has already checked recipient and read authority.
            // Its immutable terminal record supersedes an older shared projection
            // without adding another read or changing the snapshot provenance.
            const inspected = outcome;
            const assignment = inspected?.outcome ? projectAssignment(meta, effectiveStatus(meta), {
                verified: true, waits: inspected.dependencies ?? [], ...{ outcome: inspected.outcome },
            }) : observed?.assignment;
            return withAssignmentObservations(assignment ? [{ meta, assignment }] : [], () => {
                const resultText = (body) => {
                    const evidence = outcome;
                    const operations = evidence?.dependencies?.flatMap((wait) => wait.dependencies.map((dependency) => dependency.operationId)).slice(0, 5) ?? [];
                    const header = evidence?.outcome ? `Outcome r${evidence.outcome.revision}: ${evidence.outcome.outcome}. ${evidence.outcome.reason.slice(0, 256)}${operations.length ? `\nEvidence operations: ${operations.join(", ")}` : ""}\n` : "";
                    const result = subagentResultText(header + body);
                    return { ...result, details: { ...result.details, outcome, outcomeSupport: meta.outcomeSupport, assignment: assignment ?? assignmentFor(meta, effectiveStatus(meta)), snapshot: observed?.snapshot, ...permissionDetails(p.id, budgetFor("answer", p.maxBytes)) } };
                };
                if (params.operation_id && outcome) {
                    const evidence = outcome;
                    const text = `Assignment outcome r${evidence.outcome.revision}: ${evidence.outcome.outcome}\n${evidence.outcome.reason}\n${evidence.logs.map((log) => log.text).join("\n")}`;
                    const bytes = Buffer.from(text);
                    return resultText(bytes.subarray(0, budgetFor("answer", p.maxBytes)).toString("utf8"));
                }
                const scopeKey = requestScopeKey(p, session);
                const st = effectiveStatus(meta);
                const healthLine = diagnosticLines(meta);
                if (!isFinalResultStatus(st)) {
                    if (st === "orphaned") {
                        return resultText(assembleOrphanedResult(p.id, meta, healthLine, p, scopeKey));
                    }
                    return resultText(assembleRunningResult(p.id, meta, p, scopeKey, healthLine));
                }
                return resultText(assembleSubagentResult(p.id, meta, p, healthLine, scopeKey));
            });
        },
    };
}
// ---- subagent_stop --------------------------------------------------------
/**
 * Stop is the one tool with a UI side effect (widget redraw after a kill);
 * the caller injects it so the factory stays loadable without a TUI context.
 * The hook receives the run id so the host can also queue the run's one
 * terminal completion callback (#624).
 */
export function subagentStopTool(Type, deps = {}) {
    return {
        name: "subagent_stop",
        label: "Stop Subagent",
        description: "Stop a running or orphaned subagent. Terminates identifiable related " +
            "process-group members when present; otherwise finalizes from log " +
            "evidence (completed/failed) or records lost. " +
            "An abandoned launch record (a launch that never wrote metadata and never " +
            "started a child) is removed instead; a launch that is still preparing or " +
            "published concurrently is preserved.",
        promptSnippet: "Stop a running or orphaned background subagent",
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        async execute(_id, params) {
            const p = params;
            // Shared stop semantics with the TUI navigator close action (#44/#68):
            // stopRun rereads meta + effective status from disk before acting.
            const outcome = stopRun(p.id);
            if (outcome.action === "purged") {
                // No run record exists, so the stop hook's completion half is a
                // no-op (#624); the widget/ticker refresh still applies.
                deps.onStopped?.(p.id);
                return text(`Removed abandoned launch record ${p.id} (no run metadata was written, so no child ever ran).`);
            }
            if (outcome.action === "preserved") {
                // Nothing stopped: a live run owes no terminal completion, so the
                // stop hook is deliberately not fired here (#624).
                return text(outcome.status === "launching"
                    ? `Preserved ${p.id}: a launch is still preparing it (no metadata yet), so nothing was removed. Retry after it publishes, or after it fails.`
                    : `Preserved ${p.id}: a concurrent launch published this run (${outcome.status}), so nothing was removed. Call subagent_stop again to stop the run.`);
            }
            if (outcome.action === "not-running") {
                return text(`Run ${p.id} is not running (${outcome.status}).`);
            }
            deps.onStopped?.(p.id);
            if (outcome.action === "finalized") {
                return text(`Resolved orphaned subagent ${p.id} → ${outcome.status}.`);
            }
            return text(`Stopped subagent ${p.id}.`);
        },
    };
}
