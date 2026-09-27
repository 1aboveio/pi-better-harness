import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { logPathFor, runDir, taskRuntimeTrust } from "./registry.ts";
import { activeFailures, disposeIncidents, failureIdentity, formatFailureSummary, formatTerminalFailureFacts, markFailureAttentionDelivered,
    observeFailures, pendingFailureAttention, readFailureState, type FailureState } from "./shared-failure-observations.ts";
import { evidenceText, foldToolEnd, foldToolStart, newIncidentModel, toolOperation, type IncidentModel, type IncidentSink } from "./incident-model.ts";

export { formatFailureSummary, pendingFailureAttention, markFailureAttentionDelivered, toolOperation };
export const failurePath = (id: string) => join(runDir(id), "failures.jsonl");
export const readRunFailures = (id: string): FailureState => readFailureState(failurePath(id));
interface Scan { offset: number; head: string; identity: string; model: IncidentModel; retry?: number }
const scans = new Map<string, Scan>();
/** When each run's trust first could not be read, for the bounded wait (#325). */
const trustUnknownSince = new Map<string, number>();
/** How long a running scan waits for unreadable trust before scanning under the exact-retry rule. */
export const TRUST_WAIT_MS = 30_000;
/** Drop an in-memory scan cursor (e.g. on reload); the journal remains authoritative. */
export function resetFailureScanCursor(id?: string): void {
    if (id === undefined) { scans.clear(); trustUnknownSince.clear(); }
    else { scans.delete(id); trustUnknownSince.delete(id); }
}
const CHUNK = 64 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
function time(event: any): number | undefined {
    return typeof event.at === "number" && Number.isFinite(event.at) ? event.at :
        typeof event.message?.timestamp === "number" && Number.isFinite(event.message.timestamp) ? event.message.timestamp : undefined;
}
function sinkFor(id: string): IncidentSink {
    const path = failurePath(id);
    return {
        observe: (events) => observeFailures(path, events),
        dispose: (event) => { disposeIncidents(path, event); },
        state: () => readFailureState(path),
    };
}
function fold(id: string, scan: Scan, row: any, offset: number, cwd: string): void {
    const path = failurePath(id);
    const model = scan.model;
    if (row.type === "tool_execution_start") {
        foldToolStart(model, row, cwd, sinkFor(id));
    } else if (row.type === "tool_execution_end") {
        foldToolEnd(model, row, cwd, `${logPathFor(id)}#byte=${offset}`, sinkFor(id));
    } else if (row.type === "message_end" && row.message?.role === "assistant" &&
        (row.message.stopReason === "error" || typeof row.message.errorMessage === "string")) {
        const seq = ++model.sequence;
        const message = evidenceText(row.message.errorMessage) ?? "Model response failed";
        const failureId = `model:${offset}`;
        const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model", summary: message }]);
        model.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq });
    } else if (row.type === "auto_retry_start") {
        const seq = ++model.sequence;
        if (typeof row.errorMessage === "string") {
            const failureId = `model-retry:${offset}`;
            const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model", summary: row.errorMessage }]);
            model.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq - 1 });
        }
        scan.retry = seq;
    } else if (row.type === "auto_retry_end" && row.success === false) {
        const seq = ++model.sequence;
        const failureId = `model-exhausted:${offset}`;
        const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model",
            summary: evidenceText(row.finalError) ?? "Model retry exhausted" }]);
        model.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq });
        scan.retry = undefined;
    } else if (row.type === "auto_retry_end" && row.success === true && scan.retry !== undefined) {
        ++model.sequence;
        const failed = model.failed.get("model-call");
        if (failed && scan.retry > failed.sequence) {
            observeFailures(path, [{ id: `model-recovered:${offset}`, operation: "model-call", kind: "recovered", at: time(row), incidents: [failed.id] }]);
            model.failed.delete("model-call");
        }
        scan.retry = undefined;
    } else {
        ++model.sequence;
    }
}
/** Scan complete source records, independent of the finite progress/transcript tail. */
export function collectRunFailures(id: string, cwd: string, terminal = false): FailureState {
    const path = failurePath(id);
    let fd: number;
    try { fd = openSync(logPathFor(id), "r"); }
    catch (error) {
        const prior = readRunFailures(id);
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !terminal && !scans.has(id) && prior.seen.length === 0) return prior;
        const access = prior.observations[failureIdentity("child-log-access")];
        if (access && access.status !== "resolved") return prior;
        return observeFailures(path, [{ id: failureIdentity("source-unreadable", access?.id ?? "initial"), operation: "child-log-access", kind: "incomplete",
            summary: "Child log is unavailable; observations may be incomplete" }]);
    }
    try {
        const stat = fstatSync(fd);
        const size = stat.size;
        const identity = `${stat.dev}:${stat.ino}`;
        const prefix = Buffer.alloc(Math.min(256, size));
        readSync(fd, prefix, 0, prefix.length, 0);
        const head = prefix.toString("latin1");
        let scan = scans.get(id);
        const shared = scan ? Math.min(head.length, scan.head.length) : 0;
        if (scan && (identity !== scan.identity || size < scan.offset || head.slice(0, shared) !== scan.head.slice(0, shared))) {
            observeFailures(path, [{ id: failureIdentity("log-rewritten", scan.head, scan.offset), operation: "child-log", kind: "incomplete", summary: "Child log was truncated or rewritten; observations may be incomplete" }]);
            scan = undefined;
        }
        // Structured intent and dispositions are honoured only for runs launched on the trusted task
        // runtime, whose bash and failure_disposition tools are the guarded ones. Trust needs the
        // parent-authored provenance record as well as `meta.taskRuntime` (#325). It is decided once
        // per scan model, and only from a definite answer: while metadata or provenance cannot be read
        // the scan waits (nothing is folded, so a brief read failure pins nothing to the exact rule).
        // The wait is bounded: at a terminal read, or once trust has been unreadable for
        // TRUST_WAIT_MS, the log is scanned under the exact-retry rule (untrusted) so real failures
        // stay visible, and an observation gap says the metadata could not be read.
        if (!scan) {
            const trust = taskRuntimeTrust(id);
            if (trust === "unknown") {
                const now = Date.now();
                const since = trustUnknownSince.get(id) ?? now;
                trustUnknownSince.set(id, since);
                while (trustUnknownSince.size > 256) trustUnknownSince.delete(trustUnknownSince.keys().next().value!);
                const prior = readRunFailures(id);
                const gap = prior.observations[failureIdentity("run-metadata")];
                const waited = terminal || now - since >= TRUST_WAIT_MS;
                if (waited && !(gap && gap.status === "unresolved")) {
                    observeFailures(path, [{ id: failureIdentity("run-metadata-unreadable", gap?.id ?? "initial"), operation: "run-metadata", kind: "incomplete",
                        summary: "Run metadata could not be read; tool failures are scanned under the exact-retry rule" }]);
                }
                if (!waited) return prior;
                scan = { offset: 0, head, identity, model: newIncidentModel(false) };
            } else {
                trustUnknownSince.delete(id);
                scan = { offset: 0, head, identity, model: newIncidentModel(trust === "trusted") };
                const deferred = readRunFailures(id).observations[failureIdentity("run-metadata")];
                if (deferred && deferred.status === "unresolved") observeFailures(path, [{ id: `run-metadata-readable:${deferred.id}`,
                    operation: "run-metadata", kind: "recovered", incidents: [deferred.id] }]);
            }
        }
        scan.head = head;
        let position = scan.offset;
        let start = position;
        let fragments: Buffer[] = [];
        let length = 0;
        let oversized = false;
        const buffer = Buffer.alloc(CHUNK);
        while (position < size) {
            const count = readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position);
            if (!count) break;
            let from = 0;
            for (let i = 0; i < count; i++) {
                if (buffer[i] !== 10) continue;
                const part = buffer.subarray(from, i);
                length += part.length;
                if (!oversized && length <= MAX_LINE) {
                    const line = Buffer.concat([...fragments, part]).toString("utf8").trim();
                    if (line.startsWith("{")) {
                        try {
                            const row = JSON.parse(line);
                            if (["tool_execution_start", "tool_execution_end", "message_end", "auto_retry_start", "auto_retry_end"].includes(row?.type)) {
                                if ((row.type.startsWith("tool_execution_") &&
                                    (typeof row.toolCallId !== "string" || !row.toolCallId || typeof row.toolName !== "string")) ||
                                    (row.type === "tool_execution_end" && typeof row.isError !== "boolean" && typeof row.result?.isError !== "boolean" && typeof row.result?.exitCode !== "number") ||
                                    (row.type === "message_end" && (!row.message || typeof row.message.role !== "string")) ||
                                    (row.type === "auto_retry_end" && typeof row.success !== "boolean")) throw new Error("invalid structured event");
                                fold(id, scan, row, start, cwd);
                            }
                        } catch {
                            observeFailures(path, [{ id: `malformed:${start}`, operation: "child-log", kind: "incomplete", summary: "Child log contains malformed structured events; observations may be incomplete" }]);
                        }
                    }
                } else {
                    observeFailures(path, [{ id: `oversized:${start}`, operation: "child-log", kind: "incomplete", summary: "Child log contains an oversized event; observations may be incomplete" }]);
                }
                start = position + i + 1;
                from = i + 1;
                fragments = []; length = 0; oversized = false;
            }
            const rest = buffer.subarray(from, count);
            length += rest.length;
            if (length > MAX_LINE) oversized = true;
            if (!oversized && rest.length) fragments.push(Buffer.from(rest));
            position += count;
        }
        scan.offset = start;
        scans.delete(id);
        scans.set(id, scan);
        while (scans.size > 64) scans.delete(scans.keys().next().value!);
        const access = readRunFailures(id).observations[failureIdentity("child-log-access")];
        if (access && access.status !== "resolved") observeFailures(path, [{ id: `source-readable:${access.id}:${identity}:${size}`,
            operation: "child-log-access", kind: "recovered", incidents: [access.id] }]);
        if (terminal && position > start) observeFailures(path, [{ id: `partial:${start}`, operation: "child-log", kind: "incomplete", summary: "Child log ends with a partial event; observations may be incomplete" }]);
    } catch {
        observeFailures(path, [{ id: "log-read-error", operation: "child-log", kind: "incomplete", summary: "Child log could not be fully scanned; observations may be incomplete" }]);
    } finally { closeSync(fd); }
    return readRunFailures(id);
}
/**
 * The one presentation of a run's reduced incident state for the navigator. Running: prioritized
 * active rows. Terminal: actionable and incomplete rows, with unclassified agent tool failures
 * counted rather than presented as the run's outcome (#315).
 */
export function runFailureFacts(state: FailureState, terminal: boolean): string {
    if (!terminal) return formatFailureSummary(state);
    return formatTerminalFailureFacts(state, activeFailures(state).map((x) => x.id));
}
export function failureSummary(id: string, cwd: string, terminal = false): string {
    return runFailureFacts(collectRunFailures(id, cwd, terminal), terminal);
}
export function prependFailureSummary(body: string, summary: string): string {
    if (!summary) return body;
    // Keep the established status header first; failure evidence still precedes assistant progress.
    const header = /^(\[[^\n]+\])\n/.exec(body);
    return header ? `${header[1]}\n${summary}\n${body.slice(header[0].length)}` : `${summary}\n${body}`;
}
