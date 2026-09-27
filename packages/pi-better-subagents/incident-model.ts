/**
 * Pure incident model shared by the parent's log scanner (failures.ts) and the child's
 * `failure_disposition` tool (child-incidents.ts). Both fold the same structured tool
 * records in the same order, so a disposition the child accepts is re-validated
 * identically by the parent before it is journaled (#315).
 *
 * Nothing here reads prose. Operation identity is either an explicit caller-declared
 * `operationId` or the exact tool/arguments/cwd hash; expected exits require a code
 * declared on the attempt before it ran and a structured exit code from the tool.
 */
import { failureIdentity, findIncident, validateDisposition, INCIDENT_DISPOSITIONS, INTENT_ID_PATTERN, MAX_EXPECTED_EXIT_CODES,
    REJECTED_INTENT_CATEGORY, readCommandIntent, withoutAbsentIntent, type CommandIntent, type FailureEvent, type FailureState, type IncidentDisposition } from "./shared-failure-observations.ts";

export const DISPOSITION_TOOL = "failure_disposition";
// The intent validator is shared with background tasks through the vendored failure-observations module (#325).
export { INTENT_ID_PATTERN, MAX_EXPECTED_EXIT_CODES, readCommandIntent, withoutAbsentIntent, type CommandIntent };

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
    return value;
}
/** Exact identity: tool name, full arguments, and working directory. */
export function toolOperation(name: string, args: unknown, cwd: string): string {
    return failureIdentity("tool", name, stable(args ?? {}), cwd);
}
/** Declared identity when an operationId is present, otherwise the exact rule. attemptId never affects identity. */
export function attemptOperation(name: string, args: unknown, cwd: string, intent: CommandIntent): string {
    if (intent.operationId) return failureIdentity("operation", name, intent.operationId, cwd);
    // An explicit-null intent field is an undeclared one: `{expectedExitCodes: null}` and `{}` are the same command.
    args = withoutAbsentIntent(args);
    if (args && typeof args === "object" && !Array.isArray(args) && "attemptId" in args) {
        const { attemptId: _attemptId, ...rest } = args as Record<string, unknown>;
        return toolOperation(name, rest, cwd);
    }
    return toolOperation(name, args, cwd);
}

export function evidenceText(value: unknown): string | undefined {
    if (value == null) return undefined;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}
/** The text a tool result carries (its first text part, stderr, or error), not its JSON wrapper. */
function resultText(result: any): string | undefined {
    return evidenceText(result?.content?.find?.((x: any) => x?.type === "text")?.text ?? result?.stderr ?? result?.error ?? result);
}
function resultError(result: any): string | undefined {
    if (result?.isError === true || (typeof result?.exitCode === "number" && result.exitCode !== 0)) return resultText(result);
    return undefined;
}
function time(row: any): number | undefined {
    return typeof row.at === "number" && Number.isFinite(row.at) ? row.at :
        typeof row.message?.timestamp === "number" && Number.isFinite(row.message.timestamp) ? row.message.timestamp : undefined;
}

interface Attempt {
    toolCallId: string;
    toolName: string;
    operation: string;
    intent: CommandIntent;
    startSequence: number;
    /**
     * Why the confined intent bash is expected to refuse this attempt. A prediction only: the
     * attempt is filed as a rejected intent when its end row carries the child's own refusal.
     */
    predictedRejection?: string;
    /** Intent names this start registered, undone if the child refused it after all. */
    registered?: { attemptId?: string; operationId?: string };
}
interface Finished extends Attempt {
    ok: boolean;
    endSequence: number;
    evidence: string;
    incident?: string;
}
export interface IncidentModel {
    /** Honour operationId / attemptId / expectedExitCodes / dispositions (confined runtime only). */
    structuredIntent: boolean;
    sequence: number;
    open: Map<string, Attempt>;
    finished: Map<string, Finished>;
    /** attemptId → toolCallId of the accepted declaration. */
    attemptIds: Map<string, string>;
    /** Every attemptId any bash start has named, accepted or rejected. */
    namedAttempts: Set<string>;
    /** operationId → operation identity. */
    operationIds: Map<string, string>;
    /** Current unresolved incident per operation, for exact retry recovery. */
    failed: Map<string, { id: string; sequence: number }>;
    /** Incident → last failure sequence, for ordering evidence. */
    incidentSequence: Map<string, number>;
    /** Disposition requests resolved at their start position (parent) or execute time (child). */
    pendingDispositions: Map<string, { event?: FailureEvent; error?: string }>;
}
/**
 * `structuredIntent` is true only for runs whose tools are the trusted task runtime's
 * (intent bash + failure_disposition). Anywhere else the intent fields and disposition
 * requests are ignored and the exact-retry identity rule applies.
 */
export function newIncidentModel(structuredIntent = false): IncidentModel {
    return { structuredIntent, sequence: 0, open: new Map(), finished: new Map(), attemptIds: new Map(), namedAttempts: new Set(), operationIds: new Map(),
        failed: new Map(), incidentSequence: new Map(), pendingDispositions: new Map() };
}
export interface IncidentSink {
    /** Reduce/journal ordinary observations; returns the resulting state. */
    observe(events: FailureEvent[]): FailureState;
    /** Journal an already validated disposition. */
    dispose(event: FailureEvent): void;
    /** Current state for validation. */
    state(): FailureState;
}

export interface DispositionRequest {
    disposition: IncidentDisposition;
    targets: string[];
    reason: string;
    evidence?: string;
}
export function readDispositionRequest(args: unknown): { request?: DispositionRequest; error?: string } {
    const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const disposition = input.disposition;
    if (typeof disposition !== "string" || !INCIDENT_DISPOSITIONS.includes(disposition as IncidentDisposition)) {
        return { error: `disposition must be one of ${INCIDENT_DISPOSITIONS.join(", ")}` };
    }
    const targets = input.targets;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20 || !targets.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) {
        return { error: "targets must name 1-20 incidents, attempt ids, or operation ids" };
    }
    if (typeof input.reason !== "string" || !input.reason.trim()) return { error: "reason is required" };
    if (input.evidence !== undefined && (typeof input.evidence !== "string" || !input.evidence.trim())) return { error: "evidence must be an attempt id" };
    return { request: { disposition: disposition as IncidentDisposition, targets: [...targets] as string[], reason: input.reason.trim(),
        ...(typeof input.evidence === "string" ? { evidence: input.evidence.trim() } : {}) } };
}

function attemptRef(model: IncidentModel, ref: string): Finished | undefined {
    const toolCallId = model.attemptIds.get(ref) ?? ref;
    return model.finished.get(toolCallId);
}
function attemptLabel(attempt: Finished): string {
    return attempt.intent.attemptId ? `attempt ${attempt.intent.attemptId}` : `tool call ${attempt.toolCallId}`;
}

/**
 * Resolve a disposition request against the model and reduced state. Targets may be incident ids,
 * failed attempt ids / tool call ids, or declared operation ids with a current incident. Recovery
 * and supersession need evidence naming a successful attempt that started after the failures;
 * recovery additionally needs the same operation. Everything else fails closed.
 */
export function resolveDisposition(model: IncidentModel, state: FailureState, request: DispositionRequest, requestId: string): { event?: FailureEvent; error?: string } {
    const incidents: string[] = [];
    for (const target of request.targets) {
        let id: string | undefined;
        if (findIncident(state, target) || Object.hasOwn(state.history ?? {}, target)) id = target;
        else {
            const attempt = attemptRef(model, target);
            if (attempt) {
                if (!attempt.incident) return { error: `${attemptLabel(attempt)} did not fail; it has no incident` };
                id = attempt.incident;
            } else if (model.operationIds.has(target)) {
                const current = state.observations[failureIdentity(model.operationIds.get(target)!)];
                if (!current) return { error: `Operation ${target} has no incident` };
                id = current.id;
            }
        }
        if (!id) return { error: `Unknown incident, attempt, or operation "${target}"` };
        if (!incidents.includes(id)) incidents.push(id);
    }
    let evidence: string | undefined;
    if (request.disposition === "recovered" || request.disposition === "superseded") {
        if (!request.evidence) return { error: `A ${request.disposition} disposition requires evidence: the attempt id (or tool call id) of a successful later attempt` };
        const proof = attemptRef(model, request.evidence);
        if (!proof) return { error: `Unknown evidence attempt "${request.evidence}"` };
        if (!proof.ok) return { error: `Evidence ${attemptLabel(proof)} did not succeed` };
        for (const id of incidents) {
            const failedAt = model.incidentSequence.get(id);
            if (failedAt === undefined || proof.startSequence <= failedAt) {
                return { error: `Evidence ${attemptLabel(proof)} did not start after incident ${id} failed` };
            }
            if (request.disposition === "recovered") {
                const incident = findIncident(state, id);
                if (!incident || incident.operation !== proof.operation) {
                    return { error: `Evidence ${attemptLabel(proof)} is a different operation; use superseded for a different verification` };
                }
            }
        }
        evidence = `${attemptLabel(proof)} succeeded · ${proof.evidence}`;
    } else if (request.evidence) {
        const proof = attemptRef(model, request.evidence);
        evidence = proof ? `${attemptLabel(proof)} · ${proof.evidence}` : request.evidence.slice(0, 200);
    }
    const event: FailureEvent = { id: `disposition:${requestId}`, operation: "incident-disposition", kind: "disposition",
        disposition: request.disposition, incidents, reason: request.reason, ...(evidence ? { evidence } : {}) };
    const error = validateDisposition(state, event);
    return error ? { error } : { event };
}

/** Fold one tool execution start. Disposition requests are resolved here, at their start position. */
export function foldToolStart(model: IncidentModel, row: any, cwd: string, sink: IncidentSink): void {
    const toolCallId = String(row.toolCallId);
    const toolName = String(row.toolName ?? "unknown");
    const seq = ++model.sequence;
    if (!model.structuredIntent) {
        // Unconfined: intent-looking fields are ordinary arguments; exact identity only.
        // An explicit-null intent-named field is still normalized away, as on the confined path, so
        // `{command, expectedExitCodes: null}` and `{command}` are one command (#332).
        model.open.set(toolCallId, { toolCallId, toolName, operation: toolOperation(toolName, withoutAbsentIntent(row.args), cwd), intent: {}, startSequence: seq });
        return;
    }
    const parsed = toolName === "bash" ? readCommandIntent(row.args) : { intent: {} as CommandIntent };
    const intent = parsed.intent;
    // Mirrors the child's check: any earlier bash start that named this attemptId, valid or not.
    const rawAttemptId = toolName === "bash" && typeof row.args?.attemptId === "string" ? row.args.attemptId as string : undefined;
    const reused = rawAttemptId !== undefined && model.namedAttempts.has(rawAttemptId);
    if (rawAttemptId !== undefined) model.namedAttempts.add(rawAttemptId);
    const predictedRejection = parsed.error ?? (reused ? `attemptId ${intent.attemptId} was already used` : undefined);
    // A predicted refusal falls back to exact identity: if the child ran the command after all, it is
    // an ordinary failure of exactly that command, never a failure of the operation it named.
    const effective = predictedRejection ? {} : intent;
    const operation = attemptOperation(toolName, row.args, cwd, effective);
    const attempt: Attempt = { toolCallId, toolName, operation, intent: effective, startSequence: seq,
        ...(predictedRejection ? { predictedRejection } : {}) };
    model.open.set(toolCallId, attempt);
    if (predictedRejection) return;
    if (intent.attemptId) {
        model.attemptIds.set(intent.attemptId, toolCallId);
        attempt.registered = { attemptId: intent.attemptId };
    }
    if (intent.operationId && !model.operationIds.has(intent.operationId)) {
        model.operationIds.set(intent.operationId, operation);
        attempt.registered = { ...attempt.registered, operationId: intent.operationId };
    }
    if (toolName === DISPOSITION_TOOL) {
        const parsed = readDispositionRequest(row.args);
        model.pendingDispositions.set(toolCallId, parsed.request
            ? resolveDisposition(model, sink.state(), parsed.request, toolCallId)
            : { error: parsed.error });
    }
}

/** The confined intent bash's own pre-run refusal (child-incidents.ts), matched as the whole result text. */
const INTENT_REFUSAL = /^Invalid command intent: ([\s\S]+)\. The command was not run\.$/;
/**
 * Pi's pre-execution schema rejection of the bash call (pi-ai `validateToolArguments`), matched as its
 * whole shape: the header, one or more `  - path: message` lines, and the received arguments. Nothing ran.
 */
const SCHEMA_REFUSAL = /^Validation failed for tool "bash":\n(?:  - [^\n]*\n)+\nReceived arguments:\n[\s\S]*$/;

/**
 * Why the child refused this bash call before running it, read from the end row the child
 * produced, never re-derived from the arguments. A command that ran and failed returns undefined.
 */
function preRunRefusal(model: IncidentModel, attempt: Attempt | undefined, toolName: string, row: any): string | undefined {
    if (!model.structuredIntent || toolName !== "bash" || row.isError !== true) return undefined;
    const content = row.result?.content;
    const text = Array.isArray(content) && content.length === 1 && typeof content[0]?.text === "string" ? content[0].text.trim() : undefined;
    if (text === undefined) return undefined;
    const refused = INTENT_REFUSAL.exec(text);
    if (refused) return refused[1];
    // Pi validates arguments against the intent schema before execute; that refusal is ours only
    // when the intent fields themselves are what the shared validator rejects.
    if (attempt?.predictedRejection && !attempt.predictedRejection.includes("already used") && SCHEMA_REFUSAL.test(text)) return attempt.predictedRejection;
    return undefined;
}

/** Fold one tool execution end: failures, declared expected exits, exact retry recovery, dispositions. */
export function foldToolEnd(model: IncidentModel, row: any, cwd: string, evidence: string, sink: IncidentSink): void {
    const toolCallId = String(row.toolCallId);
    const toolName = String(row.toolName ?? "unknown");
    const seq = ++model.sequence;
    const attempt = model.open.get(toolCallId);
    if (attempt) model.open.delete(toolCallId);
    const intent = attempt?.intent ?? {};
    const operation = attempt?.operation ?? toolOperation(toolName, withoutAbsentIntent(row.args), cwd);
    const details = row.result?.details;
    const declaredExit = row.isError === false && details?.expectedExit === true && typeof details.exitCode === "number" &&
        (intent.expectedExitCodes ?? []).includes(details.exitCode) ? details.exitCode as number : undefined;
    const error = row.isError === true ? resultText(row.result) ?? "Tool returned an error" : resultError(row.result);
    const finished: Finished = { ...(attempt ?? { toolCallId, toolName, operation, intent, startSequence: seq }),
        ok: !error && declaredExit === undefined, endSequence: seq, evidence };
    model.finished.set(toolCallId, finished);
    const refusal = preRunRefusal(model, attempt, toolName, row);
    if (refusal !== undefined) {
        // Nothing ran: visible, but never grouped with (or escalating) the operation it named.
        if (attempt?.registered?.attemptId && model.attemptIds.get(attempt.registered.attemptId) === toolCallId) model.attemptIds.delete(attempt.registered.attemptId);
        if (attempt?.registered?.operationId) model.operationIds.delete(attempt.registered.operationId);
        finished.intent = {};
        const failureId = `tool:${toolCallId}`;
        sink.observe([{ id: failureId, operation: failureIdentity("rejected-intent", toolCallId), kind: "failure", at: time(row),
            category: REJECTED_INTENT_CATEGORY, evidence, summary: `${toolName} not run: invalid command intent (${refusal})` }]);
        finished.incident = failureId;
        return;
    }
    if (toolName === DISPOSITION_TOOL && model.structuredIntent) {
        const pending = model.pendingDispositions.get(toolCallId);
        model.pendingDispositions.delete(toolCallId);
        if (!error && pending?.event && !validateDisposition(sink.state(), pending.event)) sink.dispose(pending.event);
        return;
    }
    if (declaredExit !== undefined || error) {
        const failureId = `tool:${toolCallId}`;
        const event: FailureEvent = declaredExit !== undefined
            ? { id: failureId, operation, kind: "failure", at: time(row), category: "tool", expected: true, evidence,
                summary: `${toolName} exited with declared expected code ${declaredExit}` }
            : { id: failureId, operation, kind: "failure", at: time(row), category: "tool", evidence,
                summary: `${toolName} failed: ${error!.slice(0, 180)}`, expected: row.expected === true || row.result?.expected === true };
        const state = sink.observe([event]);
        const incident = state.observations[failureIdentity(operation)]?.id ?? failureId;
        finished.incident = incident;
        model.incidentSequence.set(incident, seq);
        model.failed.set(operation, { id: incident, sequence: seq });
        return;
    }
    if (attempt) {
        const failed = model.failed.get(operation);
        if (failed && attempt.startSequence > failed.sequence) {
            sink.observe([{ id: `recovered:${toolCallId}`, operation, kind: "recovered", at: time(row), incidents: [failed.id] }]);
            model.failed.delete(operation);
        }
    }
}

/** Open incidents a child can name, for actionable rejection messages. */
export function describeOpenTargets(model: IncidentModel, state: FailureState, limit = 10): string[] {
    const rows: string[] = [];
    for (const attempt of model.finished.values()) {
        if (!attempt.incident) continue;
        const incident = findIncident(state, attempt.incident);
        if (!incident || incident.status !== "unresolved" || incident.category === "observation-incomplete") continue;
        const names = [incident.id, attempt.intent.attemptId, attempt.intent.operationId].filter(Boolean).join(" / ");
        const row = `${names} · ${incident.summary.slice(0, 120)}`;
        if (!rows.some((x) => x.startsWith(incident.id))) rows.push(row);
        if (rows.length >= limit) break;
    }
    return rows;
}
