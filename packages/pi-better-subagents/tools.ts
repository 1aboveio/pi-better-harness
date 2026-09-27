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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMeta, listRunRecords, effectiveStatus, isFinalResultStatus, type RunMeta, type RunStatus } from "./registry.ts";
import { buildSubagentResultPayload } from "./finalization.ts";
import { stopRun } from "./stop.ts";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    SUBAGENT_LIST_STATUSES,
    collectSubagentList,
    formatSubagentListRow,
} from "./list.ts";
import {
    assembleOrphanedResult,
    assembleRunningResult,
    assembleSubagentListPayload,
    assembleSubagentOutput,
    assembleUnreadableMetadata,
    listIncidentCount,
    formatIncidentLabel,
    listRevisions,
    listScopeKey,
    requestScopeKey,
    resolveActiveOrigin,
    resolveRunAccess,
    runInListScope,
    unknownRunError,
    type SubagentToolSession,
} from "./output-payload.ts";
import {
    extractChildEventFactsFromLog,
    loadHealthThresholdsFromConfig,
    observeRunHealth,
    type HealthObservation,
} from "./health-observation.ts";
import {
    formatHealthDiagnosticLine,
    statusThemeColor,
    truncateToVisibleWidth,
} from "./health-surface.mjs";

/** Observe one run for list/output/result diagnostics (#66/#67). Best-effort. */
function observeMetaHealth(meta: RunMeta, now: number = Date.now()): HealthObservation {
    // Observation uses durable RunStatus (orphaned/lost/running/…); transient
    // effective "exited" falls back to meta.status so process liveness stays truthful.
    const eff = effectiveStatus(meta);
    const status: RunStatus = eff === "exited" ? meta.status : eff;
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

/** The slice of `@earendil-works/pi-ai`'s Type the tool schemas use. */
type TypeModule = {
    Object: (v: unknown) => unknown;
    String: (v?: unknown) => unknown;
    Number: (v?: unknown) => unknown;
    Boolean: (v?: unknown) => unknown;
    Array: (v: unknown, o?: unknown) => unknown;
    Optional: (v: unknown) => unknown;
};

/** pi's tool-result text shape. */
export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const SUBAGENT_RESULT_PREVIEW_LINES = 8;

function resultTextContent(result: unknown): string {
    const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((c) => c && (c.type === undefined || c.type === "text"))
        .map((c) => c.text ?? "")
        .join("\n");
}

function parseSubagentResultHead(head: string): { id?: string; status?: string } {
    const raw = String(head ?? "");
    const match = raw.match(/^\[([^\s\]]+)\s+·\s+([^·\]]+)/);
    if (!match) return {};
    return { id: match[1], status: match[2]?.trim() };
}

function nonEmptyPreviewLines(lines: string[]): string[] {
    const preview: string[] = [];
    for (const line of lines) {
        if (/^---\s+raw log tail\s+---$/i.test(line.trim())) break;
        if (line.trim() === "") continue;
        preview.push(line);
        if (preview.length >= SUBAGENT_RESULT_PREVIEW_LINES) break;
    }
    return preview;
}

export function buildSubagentResultDisplayDetails(body: string) {
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

function subagentResultText(body: string) {
    return {
        content: [{ type: "text" as const, text: body }],
        details: buildSubagentResultDisplayDetails(body),
    };
}

function themed(theme: unknown, color: string, value: string): string {
    const fg = (theme as { fg?: (color: string, text: string) => string })?.fg;
    return typeof fg === "function" ? fg(color, value) : value;
}

function wrapLineToVisibleWidth(line: string, width: number): string[] {
    const str = String(line ?? "");
    const max = Math.max(1, Number(width) || 80);
    if (truncateToVisibleWidth(str, max) === str) return [str];

    const out: string[] = [];
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

function renderLines(lines: string[], mode: "truncate" | "wrap" = "truncate") {
    return {
        render(width: number = 80) {
            return mode === "wrap"
                ? lines.flatMap((line) => wrapLineToVisibleWidth(line, width))
                : lines.map((line) => truncateToVisibleWidth(line, width));
        },
        invalidate() { /* stateless */ },
    };
}

export function renderSubagentResultDisplay(result: unknown, options: unknown = {}, theme: unknown = {}) {
    const fullText = resultTextContent(result);
    const details = ((result as { details?: unknown })?.details as ReturnType<typeof buildSubagentResultDisplayDetails> | undefined)
        ?? buildSubagentResultDisplayDetails(fullText);
    const expanded = (options as { expanded?: boolean })?.expanded === true;
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

function displayThemeColor(status: string): string {
    const color = statusThemeColor(status);
    return color === "danger" ? "error" : color;
}

/** A registered-tool definition as `pi.registerTool` accepts it. */
type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

// ---- subagent_list --------------------------------------------------------
export type { SubagentToolSession };

/** The session provider bound to this tool call's host context. */
function forCall(session: SubagentToolSession, ctx: unknown): SubagentToolSession {
    const provider = session.getActiveOrigin;
    if (typeof provider !== "function") return session;
    return { getActiveOrigin: () => provider(ctx) };
}

export function subagentListTool(Type: TypeModule, baseSession: SubagentToolSession = {}): ToolDefinition {
    return {
        name: "subagent_list",
        label: "List Subagents",
        description:
            `List background subagent runs with compact status rows. Non-blocking. ` +
            `Default: current session, newest first, limit ${SUBAGENT_LIST_DEFAULT_LIMIT} (1 KiB page). ` +
            `Pass all:true for machine-global; limit is clamped to max ${SUBAGENT_LIST_MAX_LIMIT}. ` +
            `Pass cursor to continue. Incident counts are compact; full failure text lives on subagent_result/output.`,
        promptSnippet: "List background subagent runs and their status",
        parameters: Type.Object({
            all: Type.Optional(Type.Boolean({ description: "If true, list every run on this machine. Default false = current session only." })),
            limit: Type.Optional(Type.Number({ description: `Maximum rows to display (default ${SUBAGENT_LIST_DEFAULT_LIMIT}, max ${SUBAGENT_LIST_MAX_LIMIT}; larger values are clamped).` })),
            status: Type.Optional(Type.Array(Type.String(), { description: `Effective statuses to include: ${SUBAGENT_LIST_STATUSES.join(", ")}.` })),
            cursor: Type.Optional(Type.String({ description: "Caller-owned page or status cursor from a previous list response." })),
            maxBytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 1 KiB, max 4 KiB)." })),
        }),
        async execute(_toolCallId: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, ctx?: unknown) {
            const session = forCall(baseSession, ctx);
            const p = (params ?? {}) as {
                all?: boolean; limit?: number; status?: string[] | string; cursor?: string; maxBytes?: number;
            };
            const now = Date.now();
            const index = listRunRecords();
            const metas = index.metas;
            const parentPid = process.pid;
            const resolved = resolveActiveOrigin(session);
            const origin = resolved.origin;
            const sessionAvailable = !(resolved.wired && !resolved.available);
            const scopeKey = listScopeKey(p.all === true, origin, parentPid, sessionAvailable);
            let sessionWarning: string | undefined;
            if (p.all !== true && !sessionAvailable) {
                sessionWarning = `Session identity unavailable; ownership of ${metas.length} run(s) cannot be verified, so none are listed. Pass all:true for machine-global.`;
            }
            const healthCache = new Map<string, HealthObservation>();
            const healthById = (id: string) => {
                const hit = healthCache.get(id);
                if (hit) return hit;
                const meta = metas.find((m) => m.id === id) ?? readMeta(id);
                if (!meta) return undefined;
                const obs = observeMetaHealth(meta, now);
                healthCache.set(id, obs);
                return obs;
            };
            const inScope = (meta: RunMeta) => runInListScope(
                meta,
                { all: p.all === true },
                origin,
                parentPid,
                sessionAvailable,
            );
            const collected = collectSubagentList({
                metas,
                params: p,
                parentPid,
                now,
                statusOf: effectiveStatus,
                healthById,
                inScope,
            });
            const items = collected.items as Array<{ meta: RunMeta; status: string }>;
            const incidents = new Map(items.map((row) => [row.meta.id, listIncidentCount(
                row.meta.id,
                row.meta.cwd,
                row.meta.status !== "running" && row.meta.status !== "orphaned",
            )] as const));
            const revisions = listRevisions(
                items.map((row) => ({ id: row.meta.id, status: String(row.status), meta: row.meta })),
                items.map((row) => incidents.get(row.meta.id)?.revision ?? ""),
            );
            const statusesKey = Array.isArray(p.status) ? [...p.status].map(String).sort().join(",") : String(p.status ?? "");
            const incidentRuns = items.filter((row) => (incidents.get(row.meta.id)?.count ?? 0) > 0).length;
            return text(assembleSubagentListPayload({
                warnings: collected.warnings,
                items,
                render: (row) => {
                    const incident = incidents.get(row.meta.id);
                    return formatSubagentListRow(row.meta, {
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
                sessionWarning,
                unreadable: index.unreadable,
                indexError: index.indexError,
                incidentRuns,
            }));
        },
    } as ToolDefinition;
}

// ---- subagent_output ------------------------------------------------------
export function subagentOutputTool(Type: TypeModule, baseSession: SubagentToolSession = {}): ToolDefinition {
    return {
        name: "subagent_output",
        label: "Subagent Output",
        description:
            "Read a subagent run's current output without waiting. Default is a 1 KiB / 10-line excerpt of the current session. " +
            "Pass all:true to read a foreign-session id. Pass mode=raw for retained-log pages (16 KiB default, 64 KiB cap). " +
            "Pass cursor to continue or to poll for failure-only changes. Missing or unreadable logs are reported as gaps, not as empty healthy output.",
        promptSnippet: "Peek at a subagent's current output without waiting",
        promptGuidelines: [
            "Use subagent_output only when the user explicitly asks how a run is progressing. It never waits — do not call it in a loop.",
            "Do not poll unchanged output. If the response says no new evidence since a cursor, stop.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
            tail_lines: Type.Optional(Type.Number({ description: "Deprecated alias for lines." })),
            lines: Type.Optional(Type.Number({ description: "Max lines in the default excerpt (default 10)." })),
            cursor: Type.Optional(Type.String({ description: "Caller-owned page or status cursor from a previous response." })),
            maxBytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 1 KiB, max 4 KiB; raw default 16 KiB, max 64 KiB)." })),
            mode: Type.Optional(Type.String({ description: "raw = page retained log bytes. Default is the bounded assembled excerpt." })),
            all: Type.Optional(Type.Boolean({ description: "If true, allow a foreign-session id. Default is current session only." })),
        }),
        async execute(_id: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, ctx?: unknown) {
            const session = forCall(baseSession, ctx);
            const p = params as { id: string; cursor?: string; maxBytes?: number; mode?: string; all?: boolean; lines?: number; tail_lines?: number };
            const access = resolveRunAccess(p.id, p, session);
            if (access.kind === "missing") throw unknownRunError(p.id);
            if (access.kind === "unreadable") return text(assembleUnreadableMetadata(p.id, access.detail, p));
            if (access.kind === "denied") return text(access.payload);
            const scopeKey = requestScopeKey(p, session);
            const healthLine = formatHealthDiagnosticLine(observeMetaHealth(access.meta));
            return text(assembleSubagentOutput(p.id, access.meta, p, healthLine, scopeKey));
        },
    } as ToolDefinition;
}

// ---- subagent_result ------------------------------------------------------
export function subagentResultTool(Type: TypeModule, baseSession: SubagentToolSession = {}): ToolDefinition {
    return {
        name: "subagent_result",
        label: "Subagent Result",
        description:
            "Read a subagent's final output if it has finished. NEVER waits. Default current session. Ordinary answers are preserved verbatim in a 2 KiB UTF-8 page (max 8 KiB); pass cursor to reconstruct the rest. Pass all:true for a foreign-session id. mode=raw pages retained log bytes (16 KiB default, 64 KiB cap). Failures and exceptional lifecycle facts come before progress. No tool-name histories or default cost lines.",
        promptSnippet: "Read a finished subagent's final result (never waits)",
        promptGuidelines: [
            "Use subagent_result to collect a finished run's output. If it reports the run is still going, stop — do not poll; you'll be notified when it finishes.",
            "If the response includes nextCursor, call again with that cursor to read the rest of the answer. Do not summarize away unread pages.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
            cursor: Type.Optional(Type.String({ description: "Caller-owned answer page or status cursor from a previous response." })),
            maxBytes: Type.Optional(Type.Number({ description: "UTF-8 byte budget for this page (default 2 KiB, max 8 KiB)." })),
            mode: Type.Optional(Type.String({ description: "raw = page retained log bytes (16 KiB default, 64 KiB cap). Default is the bounded assembled result." })),
            all: Type.Optional(Type.Boolean({ description: "If true, allow a foreign-session id. Default is current session only." })),
        }),
        renderResult(result: unknown, options: unknown, theme: unknown) {
            return renderSubagentResultDisplay(result, options, theme);
        },
        async execute(_id: string, params: unknown, _signal?: unknown, _onUpdate?: unknown, ctx?: unknown) {
            const session = forCall(baseSession, ctx);
            const p = params as { id: string; cursor?: string; maxBytes?: number; mode?: string; all?: boolean };
            const access = resolveRunAccess(p.id, p, session);
            if (access.kind === "missing") throw unknownRunError(p.id);
            if (access.kind === "unreadable") {
                return subagentResultText(assembleUnreadableMetadata(p.id, access.detail, p));
            }
            if (access.kind === "denied") return subagentResultText(access.payload);
            const meta = access.meta;
            const scopeKey = requestScopeKey(p, session);
            const st = effectiveStatus(meta);
            const healthLine = formatHealthDiagnosticLine(observeMetaHealth(meta));
            if (!isFinalResultStatus(st)) {
                if (st === "orphaned") {
                    return subagentResultText(assembleOrphanedResult(p.id, meta, healthLine, p, scopeKey));
                }
                return subagentResultText(assembleRunningResult(p.id, meta, p, scopeKey));
            }
            const body = buildSubagentResultPayload(p.id, p, healthLine, scopeKey);
            if (body === null) {
                return subagentResultText(assembleRunningResult(p.id, meta, p, scopeKey));
            }
            return subagentResultText(body);
        },
    } as ToolDefinition;
}

// ---- subagent_stop --------------------------------------------------------
/**
 * Stop is the one tool with a UI side effect (widget redraw after a kill);
 * the caller injects it so the factory stays loadable without a TUI context.
 */
export function subagentStopTool(
    Type: TypeModule,
    deps: { onStopped?: () => void } = {},
): ToolDefinition {
    return {
        name: "subagent_stop",
        label: "Stop Subagent",
        description:
            "Stop a running or orphaned subagent. Terminates identifiable related " +
            "process-group members when present; otherwise finalizes from log " +
            "evidence (completed/failed) or records lost.",
        promptSnippet: "Stop a running or orphaned background subagent",
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        async execute(_id: string, params: unknown) {
            const p = params as { id: string };
            // Shared stop semantics with the TUI navigator close action (#44/#68):
            // stopRun rereads meta + effective status from disk before acting.
            const outcome = stopRun(p.id);
            if (outcome.action === "not-running") {
                return text(`Run ${p.id} is not running (${outcome.status}).`);
            }
            deps.onStopped?.();
            if (outcome.action === "finalized") {
                return text(`Resolved orphaned subagent ${p.id} → ${outcome.status}.`);
            }
            return text(`Stopped subagent ${p.id}.`);
        },
    } as ToolDefinition;
}
