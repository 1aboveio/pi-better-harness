/**
 * Child-side structured failure intent (#315), installed by the trusted task runtime.
 *
 * - `bash` accepts optional `operationId`, `attemptId`, and `expectedExitCodes`. They are
 *   validated before the command runs. A declared exit code returns a non-error result
 *   whose details carry the structured exit code; every other non-zero exit, timeout, or
 *   abort stays an ordinary tool error.
 * - `failure_disposition` lets the agent that owns an incident classify it explicitly.
 *   It validates against the same incident model the parent scanner replays, so the
 *   parent journals exactly what the child accepted and nothing else.
 */
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emptyFailureState, reduceFailure, type FailureEvent, type FailureState } from "./shared-failure-observations.ts";
import { DISPOSITION_TOOL, INTENT_ID_PATTERN, MAX_EXPECTED_EXIT_CODES, describeOpenTargets, foldToolEnd, foldToolStart,
    newIncidentModel, readCommandIntent, readDispositionRequest, resolveDisposition, type IncidentModel, type IncidentSink } from "./incident-model.ts";

const { createBashToolDefinition } = PiCodingAgent;

// Each intent field also admits `null`, which means "not declared" (withoutAbsentIntent). Models send
// optional fields as explicit null; accepting it in the schema means Pi hands execute the same raw
// arguments the process log and session record keep, on every Pi version (0.82 rejected a null
// before execute, 0.87 silently drops it), so the child and the parent's replay read one input.
// `anyOf` rather than a `type` array: Pi 0.82's TypeBox compiler crashes on `["array", "null"]` + `items`.
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const intentProperties = {
    operationId: { ...nullable({ type: "string", pattern: INTENT_ID_PATTERN }),
        description: "Optional stable id for one logical operation. Reuse it on a modified retry (changed scope, timeout, or flags) so a later success recovers the earlier failure." },
    attemptId: { ...nullable({ type: "string", pattern: INTENT_ID_PATTERN }),
        description: "Optional unique id for this execution, for use as evidence in failure_disposition." },
    expectedExitCodes: { ...nullable({ type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 1, maxItems: MAX_EXPECTED_EXIT_CODES }),
        // Distinctness is enforced by readCommandIntent, not `uniqueItems`: OpenAI rejects that keyword
        // in function schemas, which failed every confined child's first request.
        description: "Optional distinct non-zero exit codes that are intentional for this command (for example [1] for an rg/grep no-match or git diff --exit-code probe). 0 is allowed and ignored: exit 0 is already success. Declared before the command runs; the final shell exit code is what is classified." },
};

/**
 * Every tool call the child session has recorded, in append order, across all branches (#325).
 * The parent scans the child's whole process log, not one session branch, so the child reads the
 * whole session too: after a branch switch or compaction the two views still agree. Session
 * entries are a superset of the log's tool starts (an assistant message is recorded before its
 * tools run), so a reuse the parent sees is always one the child also saw and refused.
 */
function sessionToolCalls(ctx: ExtensionContext | undefined): Array<{ type: string; [key: string]: unknown }> {
    const manager = ctx?.sessionManager;
    const branch = (manager?.getEntries?.() ?? manager?.getBranch?.() ?? []) as any[];
    const rows: Array<{ type: string; [key: string]: unknown }> = [];
    let pendingEnds: any[] = [];
    const flush = () => { rows.push(...pendingEnds); pendingEnds = []; };
    for (const entry of branch) {
        const message = entry?.type === "message" ? entry.message : undefined;
        if (!message) continue;
        if (message.role === "assistant") {
            flush();
            for (const part of Array.isArray(message.content) ? message.content : []) {
                if (part?.type === "toolCall" && typeof part.id === "string") {
                    rows.push({ type: "tool_execution_start", toolCallId: part.id, toolName: part.name, args: part.arguments });
                }
            }
        } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
            pendingEnds.push({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName,
                isError: message.isError === true, result: { content: message.content, details: message.details } });
        }
    }
    flush();
    return rows;
}

/** Rebuild the child's view of its own incidents from the durable session record (every branch). */
export function childIncidentView(ctx: ExtensionContext | undefined, cwd: string): { model: IncidentModel; state: FailureState } {
    let state = emptyFailureState();
    let at = 0;
    const sink: IncidentSink = {
        observe: (events: FailureEvent[]) => { for (const event of events) state = reduceFailure(state, event, ++at); return state; },
        dispose: (event: FailureEvent) => { state = reduceFailure(state, event, ++at); },
        state: () => state,
    };
    const model = newIncidentModel(true);
    for (const row of sessionToolCalls(ctx)) {
        if (row.type === "tool_execution_start") foldToolStart(model, row, cwd, sink);
        else foldToolEnd(model, row, cwd, "session", sink);
    }
    return { model, state };
}

/** Bash with structured intent, delegating execution to the given operations. */
export function intentBashDefinition(cwd: string, operations: BashOperations) {
    const base = createBashToolDefinition(cwd, { operations });
    const parameters = { ...base.parameters, properties: { ...(base.parameters as any).properties, ...intentProperties } };
    return {
        ...base,
        parameters,
        async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
            const { intent, error } = readCommandIntent(params);
            if (error) throw new Error(`Invalid command intent: ${error}. The command was not run.`);
            if (intent.attemptId) {
                const reused = sessionToolCalls(ctx).some((row) => row.type === "tool_execution_start" && row.toolName === "bash" &&
                    row.toolCallId !== toolCallId && (row.args as any)?.attemptId === intent.attemptId);
                if (reused) throw new Error(`Invalid command intent: attemptId ${intent.attemptId} was already used. The command was not run.`);
            }
            const { operationId: _o, attemptId: _a, expectedExitCodes: _e, ...command } = params ?? {};
            let exitCode: number | null | undefined;
            const observed: BashOperations = { ...operations, exec: async (...args: Parameters<BashOperations["exec"]>) => {
                const result = await operations.exec(...args);
                exitCode = result.exitCode;
                return result;
            } };
            const run = createBashToolDefinition(cwd, { operations: observed });
            try {
                return await run.execute(toolCallId, command, signal, onUpdate, ctx);
            } catch (failure) {
                if (typeof exitCode === "number" && intent.expectedExitCodes?.includes(exitCode) && !signal?.aborted) {
                    const message = failure instanceof Error ? failure.message : String(failure);
                    return { content: [{ type: "text" as const, text: `${message}\n(Exit code ${exitCode} was declared expected.)` }],
                        details: { exitCode, expectedExit: true, ...(intent.operationId ? { operationId: intent.operationId } : {}),
                            ...(intent.attemptId ? { attemptId: intent.attemptId } : {}) } as any };
                }
                throw failure;
            }
        },
    };
}

export function failureDispositionTool(cwd: () => string) {
    return {
        name: DISPOSITION_TOOL,
        label: "Failure disposition",
        description: [
            "Classify your own earlier tool failures so the parent is not told about problems you already handled.",
            "recovered: the same operation later passed (evidence = that attempt). superseded: a different verification or remediation established the outcome (evidence = the successful attempt).",
            "expected: the failure was intentional. open: it still needs the parent's action (this asks for attention).",
            "targets: incident ids, the attemptId/operationId you declared on bash, or tool call ids. Unknown or already-disposed incidents are rejected.",
            "Never claim recovery without a successful later attempt as evidence.",
        ].join(" "),
        promptSnippet: "Classify handled tool failures (recovered, superseded, expected) or flag one as open for the parent.",
        parameters: {
            type: "object",
            properties: {
                disposition: { type: "string", enum: ["recovered", "superseded", "expected", "open"] },
                targets: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 20 },
                reason: { type: "string", minLength: 1, maxLength: 400 },
                evidence: { type: "string", minLength: 1, maxLength: 200, description: "attemptId or tool call id of the successful later attempt; required for recovered and superseded." },
            },
            required: ["disposition", "targets", "reason"],
            additionalProperties: false,
        },
        async execute(toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
            const parsed = readDispositionRequest(params);
            if (!parsed.request) throw new Error(`Disposition rejected: ${parsed.error}.`);
            const { model, state } = childIncidentView(ctx, cwd());
            const outcome = resolveDisposition(model, state, parsed.request, toolCallId);
            if (!outcome.event) {
                const open = describeOpenTargets(model, state);
                throw new Error(`Disposition rejected: ${outcome.error}.` + (open.length ? `\nOpen incidents:\n${open.join("\n")}` : "\nNo open incidents."));
            }
            const incidents = outcome.event.incidents ?? [];
            return {
                content: [{ type: "text" as const, text: `Recorded ${parsed.request.disposition} for ${incidents.length} incident${incidents.length === 1 ? "" : "s"}: ${incidents.join(", ")}.` }],
                details: { disposition: parsed.request.disposition, incidents },
            };
        },
    };
}
