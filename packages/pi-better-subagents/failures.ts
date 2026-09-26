import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { logPathFor, runDir } from "./registry.ts";
import { failureIdentity, formatFailureSummary, markFailureAttentionDelivered,
    observeFailures, pendingFailureAttention, readFailureState, type FailureState } from "./shared-failure-observations.ts";

export { formatFailureSummary, pendingFailureAttention, markFailureAttentionDelivered };
export const failurePath = (id: string) => join(runDir(id), "failures.jsonl");
export const readRunFailures = (id: string): FailureState => readFailureState(failurePath(id));
interface Attempt { operation: string; sequence: number }
interface Scan { offset: number; head: string; identity: string; attempts: Map<string, Attempt>; failed: Map<string, { id: string; sequence: number }>; sequence: number; retry?: number }
const scans = new Map<string, Scan>();
/** Drop an in-memory scan cursor (e.g. on reload); the journal remains authoritative. */
export function resetFailureScanCursor(id?: string): void {
    if (id === undefined) scans.clear();
    else scans.delete(id);
}
const CHUNK = 64 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
    return value;
}
export function toolOperation(name: string, args: unknown, cwd: string): string {
    return failureIdentity("tool", name, stable(args ?? {}), cwd);
}
function evidence(value: unknown): string | undefined {
    if (value == null) return undefined;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw?.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 300);
}
function resultError(result: any): string | undefined {
    if (result?.isError === true || (typeof result?.exitCode === "number" && result.exitCode !== 0)) {
        return evidence(result?.content?.find?.((x: any) => x?.type === "text")?.text ?? result?.stderr ?? result?.error ?? result);
    }
    return undefined;
}
function time(event: any): number | undefined {
    return typeof event.at === "number" && Number.isFinite(event.at) ? event.at :
        typeof event.message?.timestamp === "number" && Number.isFinite(event.message.timestamp) ? event.message.timestamp : undefined;
}
function fold(id: string, scan: Scan, row: any, offset: number, cwd: string): void {
    const eventId = typeof row.toolCallId === "string" ? row.toolCallId : `offset:${offset}`;
    const seq = ++scan.sequence;
    const path = failurePath(id);
    if (row.type === "tool_execution_start") {
        scan.attempts.set(eventId, { operation: toolOperation(String(row.toolName ?? "unknown"), row.args, cwd), sequence: seq });
    } else if (row.type === "tool_execution_end") {
        const attempt = scan.attempts.get(eventId);
        if (attempt) scan.attempts.delete(eventId);
        const operation = attempt?.operation ?? toolOperation(String(row.toolName ?? "unknown"), row.args, cwd);
        const error = row.isError === true ? evidence(row.result) ?? "Tool returned an error" : resultError(row.result);
        if (error) {
            const failureId = `tool:${eventId}`;
            const state = observeFailures(path, [{ id: failureId, operation, kind: "failure", at: time(row), category: "tool",
                summary: `${row.toolName ?? "Tool"} failed: ${error.slice(0, 180)}`, evidence: `${logPathFor(id)}#byte=${offset}`,
                expected: row.expected === true || row.result?.expected === true }]);
            scan.failed.set(operation, { id: state.observations[failureIdentity(operation)]?.id ?? failureId, sequence: seq });
        } else if (attempt) {
            const failed = scan.failed.get(operation);
            if (failed && attempt.sequence > failed.sequence) {
                observeFailures(path, [{ id: `recovered:${eventId}`, operation, kind: "recovered", at: time(row), incidents: [failed.id] }]);
                scan.failed.delete(operation);
            }
        }
    } else if (row.type === "message_end" && row.message?.role === "assistant" &&
        (row.message.stopReason === "error" || typeof row.message.errorMessage === "string")) {
        const message = evidence(row.message.errorMessage) ?? "Model response failed";
        const failureId = `model:${offset}`;
        const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model", summary: message }]);
        scan.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq });
    } else if (row.type === "auto_retry_start") {
        if (typeof row.errorMessage === "string") {
            const failureId = `model-retry:${offset}`;
            const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model", summary: row.errorMessage }]);
            scan.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq - 1 });
        }
        scan.retry = seq;
    } else if (row.type === "auto_retry_end" && row.success === false) {
        const failureId = `model-exhausted:${offset}`;
        const state = observeFailures(path, [{ id: failureId, operation: "model-call", kind: "failure", at: time(row), category: "model",
            summary: evidence(row.finalError) ?? "Model retry exhausted" }]);
        scan.failed.set("model-call", { id: state.observations[failureIdentity("model-call")]?.id ?? failureId, sequence: seq });
        scan.retry = undefined;
    } else if (row.type === "auto_retry_end" && row.success === true && scan.retry !== undefined) {
        const failed = scan.failed.get("model-call");
        if (failed && scan.retry > failed.sequence) {
            observeFailures(path, [{ id: `model-recovered:${offset}`, operation: "model-call", kind: "recovered", at: time(row), incidents: [failed.id] }]);
            scan.failed.delete("model-call");
        }
        scan.retry = undefined;
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
        if (!scan) scan = { offset: 0, head, identity, attempts: new Map(), failed: new Map(), sequence: 0 };
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
export function failureSummary(id: string, cwd: string, terminal = false): string {
    return formatFailureSummary(collectRunFailures(id, cwd, terminal));
}
export function prependFailureSummary(body: string, summary: string): string {
    if (!summary) return body;
    // Keep the established status header first; failure evidence still precedes assistant progress.
    const header = /^(\[[^\n]+\])\n/.exec(body);
    return header ? `${header[1]}\n${summary}\n${body.slice(header[0].length)}` : `${summary}\n${body}`;
}
