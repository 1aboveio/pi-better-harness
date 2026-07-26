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
import { readMeta, listMetas, effectiveStatus, isFinalResultStatus, type RunMeta, type RunStatus } from "./registry.ts";
import { parseRun, tailLog, formatSubagentOutputBody } from "./parse.ts";
import { buildSubagentResultText } from "./finalization.ts";
import { formatOrphanedResult } from "./lifecycle.ts";
import { stopRun } from "./stop.ts";
import { fmtElapsed, fmtSpend } from "./widget.ts";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    SUBAGENT_LIST_STATUSES,
    buildSubagentList,
} from "./list.ts";
import {
    extractChildEventFactsFromLog,
    loadHealthThresholdsFromConfig,
    observeRunHealth,
    type HealthObservation,
} from "./health-observation.ts";
import {
    appendHealthDiagnostic,
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
export function subagentListTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_list",
        label: "List Subagents",
        description:
            `List background subagent runs with status and metadata. Non-blocking. ` +
            `Default: this parent process only, newest first, limit ${SUBAGENT_LIST_DEFAULT_LIMIT}. ` +
            `Pass all:true for machine-global; limit is clamped to max ${SUBAGENT_LIST_MAX_LIMIT}.`,
        promptSnippet: "List background subagent runs and their status",
        parameters: Type.Object({
            all: Type.Optional(Type.Boolean({ description: "If true, list every run on this machine. Default false = only runs spawned by this pi process." })),
            limit: Type.Optional(Type.Number({ description: `Maximum rows to display (default ${SUBAGENT_LIST_DEFAULT_LIMIT}, max ${SUBAGENT_LIST_MAX_LIMIT}; larger values are clamped).` })),
            status: Type.Optional(Type.Array(Type.String(), { description: `Effective statuses to include: ${SUBAGENT_LIST_STATUSES.join(", ")}.` })),
        }),
        async execute(_toolCallId: string, params: unknown) {
            const p = (params ?? {}) as { all?: boolean; limit?: number; status?: string[] | string };
            const now = Date.now();
            const metas = listMetas();
            // Cache observations per id so usage + health share one parse where needed.
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
            return text(buildSubagentList({
                metas,
                params: p,
                parentPid: process.pid,
                now,
                statusOf: effectiveStatus,
                usageById: (id: string) => parseRun(id).usage,
                healthById,
            }));
        },
    } as ToolDefinition;
}

// ---- subagent_output ------------------------------------------------------
export function subagentOutputTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_output",
        label: "Subagent Output",
        description:
            "Tail the live output of a subagent run. Non-blocking: returns whatever exists right now and " +
            "returns immediately whether or not the run has finished. Never waits.",
        promptSnippet: "Peek at a subagent's current output without waiting",
        promptGuidelines: [
            "Use subagent_output only when the user explicitly asks how a run is progressing. It never waits — do not call it in a loop.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
            tail_lines: Type.Optional(Type.Number({ description: "How many trailing lines to show (default 40)." })),
        }),
        async execute(_id: string, params: unknown) {
            const p = params as { id: string; tail_lines?: number };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            const st = effectiveStatus(meta);
            const r = parseRun(p.id);
            const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
            const spend = fmtSpend(r.usage);
            const head = `[${p.id} · ${st} · ${el}${spend ? ` · ${spend}` : ""}]`;
            const tools = r.toolCalls.length ? `\ntools used: ${r.toolCalls.join(", ")}` : "";
            const raw = tailLog(p.id, p.tail_lines ?? 40);
            const body = formatSubagentOutputBody(
                head,
                tools,
                r.finalText || r.lastActivity || undefined,
                raw,
                r.diagnostics,
            );
            // Health diagnostics for orphaned/lost/degraded only (#67). Healthy/quiet
            // stays on today's body. Independent of meta.callback.
            const healthLine = formatHealthDiagnosticLine(observeMetaHealth(meta));
            return text(appendHealthDiagnostic(body, healthLine));
        },
    } as ToolDefinition;
}

// ---- subagent_result ------------------------------------------------------
export function subagentResultTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_result",
        label: "Subagent Result",
        description:
            "Read a subagent's final output if it has finished. NEVER waits: if the run is still going it " +
            "says so and returns immediately.",
        promptSnippet: "Read a finished subagent's final result (never waits)",
        promptGuidelines: [
            "Use subagent_result to collect a finished run's output. If it reports the run is still going, stop — do not poll; you'll be notified when it finishes.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        renderResult(result: unknown, options: unknown, theme: unknown) {
            return renderSubagentResultDisplay(result, options, theme);
        },
        async execute(_id: string, params: unknown) {
            const p = params as { id: string };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            const st = effectiveStatus(meta);
            if (!isFinalResultStatus(st)) {
                if (st === "orphaned") {
                    // Non-terminal: supervision is broken but related process-
                    // group work may still be alive — never present this as a
                    // final result. Surface best-CURRENT artifacts (#65) plus
                    // health diagnostic (#67).
                    const r = parseRun(p.id);
                    const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
                    const spend = fmtSpend(r.usage);
                    const tools = r.toolCalls.length ? ` · tools: ${r.toolCalls.join(", ")}` : "";
                    const head = `[${p.id} · orphaned · ${el}${spend ? ` · ${spend}` : ""}${tools}]`;
                    const rawTail = tailLog(p.id, 40);
                    const body = `${head}\n${formatOrphanedResult(r, rawTail)}`;
                    const healthLine = formatHealthDiagnosticLine(observeMetaHealth(meta));
                    return subagentResultText(appendHealthDiagnostic(body, healthLine));
                }
                return subagentResultText(`Run ${p.id} is still running — no result yet. You'll be notified when it finishes; don't poll.`);
            }
            // Lifecycle-aware body (complete-stream authority + diagnostics).
            // Lost runs go through formatLostResult inside formatSubagentResult (#65).
            const body = buildSubagentResultText(p.id);
            if (body === null) {
                // Defensive: status race between effectiveStatus and body assembly.
                return subagentResultText(`Run ${p.id} is still running — no result yet. You'll be notified when it finishes; don't poll.`);
            }
            // Append degraded/lost health facts when present; completed/failed
            // happy paths stay quiet when observation is non-actionable.
            const healthLine = formatHealthDiagnosticLine(observeMetaHealth(meta));
            return subagentResultText(appendHealthDiagnostic(body, healthLine));
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
