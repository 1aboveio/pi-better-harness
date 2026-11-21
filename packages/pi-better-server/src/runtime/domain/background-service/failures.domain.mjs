// Generated fixed launch domain from packages/pi-better-background-tasks/src/failures.ts. Do not edit directly.
import { join } from "node:path";
import { actionableFailures, activeFailures, failureAttentionHandled, failureIdentity, formatFailureSummary, markFailureAttentionDelivered, observeFailures, pendingAttentionNote, pendingAttentionRows, pendingFailureAttention, readCommandIntent, readFailureState, } from "./shared-failure-observations.domain.mjs";
import { getCallbackBatcher } from "./shared-callback-batcher.domain.mjs";
import { listMetasForOrigin, originOf, readMeta, taskDir } from "./registry.domain.mjs";
export const failurePath = (id) => join(taskDir(id), "failures.jsonl");
export const failureSummary = (id) => formatFailureSummary(readFailureState(failurePath(id)));
/**
 * The failure summary plus whether anything needs action. A navigator row leads with failure text
 * only when something does; the quiet history line never displaces the command (#332).
 */
export function failureView(id) {
    const state = readFailureState(failurePath(id));
    return { text: formatFailureSummary(state), actionable: actionableFailures(state).length > 0 };
}
export function recordFailure(meta, operation, summary, eventKey, options = {}) {
    observeFailures(failurePath(meta.id), [{
            id: failureIdentity(meta.id, operation, eventKey), operation,
            kind: options.incomplete ? "incomplete" : "failure", summary,
            category: options.category, expected: options.expected, evidence: options.evidence,
            at: options.at,
        }]);
}
export function recoverFailure(meta, operation, eventKey, at = Date.now()) {
    const path = failurePath(meta.id);
    const active = readFailureState(path).observations[failureIdentity(operation)];
    if (!active || active.status === "resolved")
        return;
    observeFailures(path, [{
            id: failureIdentity(meta.id, operation, "recovered", eventKey), operation,
            kind: "recovered", incidents: [active.id], at,
        }]);
}
/**
 * Validate `operation_id` / `expected_exit_codes` before anything is launched (#325), with the same
 * validator the subagent task runtime's bash uses. Background commands are launched by the parent
 * agent itself, so the declaration is trusted; a malformed one refuses the launch.
 */
export function readTaskIntent(params) {
    const { intent, error } = readCommandIntent({ operationId: params.operation_id, expectedExitCodes: params.expected_exit_codes }, { operationId: "operation_id", expectedExitCodes: "expected_exit_codes" });
    if (error)
        throw new Error(`Invalid command intent: ${error}. The task was not started.`);
    return { ...(intent.operationId ? { operationId: intent.operationId } : {}), ...(intent.expectedExitCodes ? { expectedExitCodes: intent.expectedExitCodes } : {}) };
}
/** A structured exit code the caller declared intentional before launch. Signals and timeouts never are. */
export function isDeclaredExpectedExit(meta, exitCode) {
    return typeof exitCode === "number" && exitCode !== 0 && (meta.expectedExitCodes ?? []).includes(exitCode);
}
/** Record a non-zero command exit, classified as expected only when its code was declared before launch. */
export function recordExitFailure(meta, operation, summary, exitCode, eventKey, options = {}) {
    const declared = isDeclaredExpectedExit(meta, exitCode);
    recordFailure(meta, operation, declared ? `${summary} (declared expected)` : summary, eventKey, { category: "exit", expected: declared || options.expected === true, at: options.at });
}
function declaredOperation(meta) {
    return meta.operationId ? failureIdentity("bg-operation", meta.kind, meta.operationId, meta.cwd, meta.ssh?.target ?? null) : undefined;
}
/**
 * Recovery crosses tasks only within one owner (#325): the same non-empty session id, or, for
 * sessionless tasks, the same spawning process (#312's sessionless ownership rule). The origin
 * index alone treats two sessionless sessions in one cwd as one origin.
 */
function sameRecoveryOwner(a, b) {
    const sa = a.callbackOrigin?.sessionId, sb = b.callbackOrigin?.sessionId;
    if (sa || sb)
        return Boolean(sa) && sa === sb;
    return a.spawnPid === b.spawnPid && a.spawnPidStartTime === b.spawnPidStartTime;
}
/**
 * A task that succeeded with a declared `operationId` recovers the unresolved failures of earlier
 * tasks of the same owner (session, or spawning process when sessionless) that declared the same operation (same kind, cwd, and SSH target) and
 * failed before this task started: a modified retry as a new task. Observation gaps and expected
 * failures are left alone; nothing is matched on command text.
 */
export function recoverDeclaredOperation(meta, at = Date.now()) {
    const operation = declaredOperation(meta);
    if (!operation)
        return;
    let earlier;
    try {
        earlier = listMetasForOrigin(originOf(meta));
    }
    catch {
        return;
    }
    for (const task of earlier) {
        if (task.id === meta.id || task.startedAt >= meta.startedAt || declaredOperation(task) !== operation || !sameRecoveryOwner(task, meta))
            continue;
        const path = failurePath(task.id);
        const events = activeFailures(readFailureState(path))
            .filter((x) => x.status === "unresolved" && x.category !== "observation-incomplete" && x.lastObservedAt <= meta.startedAt)
            .map((x) => ({ id: failureIdentity(task.id, x.id, "recovered-by", meta.id), operation: x.operation, kind: "recovered", incidents: [x.id], at,
            evidence: `task ${meta.id} (operation ${meta.operationId}) succeeded` }));
        if (events.length)
            observeFailures(path, events);
    }
}
export function createFailureAttention(deliverUrgent) {
    const attentionTimers = new Map();
    let attentionSuspended = false;
    /** Session shutdown: stop this instance's attention timers; the next session_start reschedules (#324). */
    function suspendFailureAttention() {
        attentionSuspended = true;
        for (const timer of attentionTimers.values())
            clearTimeout(timer);
        attentionTimers.clear();
    }
    function resumeFailureAttention() {
        attentionSuspended = false;
    }
    function stopFailureAttention(id) {
        const timer = attentionTimers.get(id);
        if (timer)
            clearTimeout(timer);
        attentionTimers.delete(id);
    }
    /**
     * Model-facing fields of a running task's failure attention. The notification
     * identity is per incident set; the inspect target is the real task id.
     * Only the pending incidents are rows; earlier deliveries are counted, never repeated (#315).
     */
    function failureAttentionFields(meta, state, pending) {
        const rows = pendingAttentionRows(state, pending.incidents);
        const note = pendingAttentionNote(state, pending.incidents);
        const due = pending.incidents.length;
        return {
            source: "background-task",
            id: `failure:${meta.id}:${pending.key}`,
            inspectId: meta.id,
            label: meta.name ?? meta.id,
            status: "failure",
            customType: "background-task-failure",
            content: `Background task ${meta.id} is still running with ${due} failure observation${due === 1 ? "" : "s"} that need attention.${note ? ` ${note}` : ""}`,
            detailTool: "bg_task_status",
            failureRows: rows,
            incidentCount: rows.length || undefined,
        };
    }
    /** Running incidents get one grace wake. Terminal incidents ride the completion callback. */
    function scheduleFailureAttention(pi, id, getActiveSession) {
        stopFailureAttention(id);
        if (attentionSuspended)
            return;
        const meta = readMeta(id);
        if (!meta) {
            const timer = setTimeout(() => scheduleFailureAttention(pi, id, getActiveSession), 1_000);
            timer.unref();
            attentionTimers.set(id, timer);
            return;
        }
        if (meta.status !== "running" || meta.callback === false || meta.stopRequestedAt)
            return;
        const state = readFailureState(failurePath(id));
        const pending = pendingFailureAttention(state, Date.now());
        if (pending) {
            const deliver = (event) => deliverUrgent ? deliverUrgent(meta.callbackOrigin, event) : getCallbackBatcher(pi).deliverUrgent(event);
            const delivery = deliver({
                receiptId: `background-failure:${meta.id}:${pending.key}`,
                ...failureAttentionFields(meta, state, pending),
                isDelivered: () => {
                    const current = readMeta(id);
                    if (!current)
                        throw new Error("Task metadata is unavailable; defer failure notification");
                    const now = readFailureState(failurePath(id));
                    return current.status !== "running" || failureAttentionHandled(now, pending.incidents);
                },
                getSuppressionReason: () => {
                    if (attentionSuspended)
                        throw new Error("Failure attention instance is suspended; defer notification");
                    const current = readMeta(id);
                    if (!current)
                        throw new Error("Task metadata is unavailable; defer failure notification");
                    if (current.status !== "running" || current.callback === false || current.stopRequestedAt)
                        return "task is no longer running";
                    const origin = current.callbackOrigin;
                    const active = getActiveSession?.();
                    if (origin && (!active || origin.cwd !== active.cwd || (origin.sessionId && origin.sessionId !== active.sessionId)))
                        return "callback origin is not active";
                    if (!origin && active && active.cwd !== current.cwd)
                        return "callback cwd is not active";
                    return undefined;
                },
                onDelivered: (at) => { markFailureAttentionDelivered(failurePath(id), pending, at); },
            });
            void Promise.resolve(delivery).then((sent) => {
                if (!sent && !attentionSuspended && (!readMeta(id) || readMeta(id)?.status === "running")) {
                    const timer = setTimeout(() => scheduleFailureAttention(pi, id, getActiveSession), 1_000);
                    timer.unref();
                    attentionTimers.set(id, timer);
                }
            });
            return;
        }
        const due = Object.values(state.observations)
            .filter((x) => x.status === "unresolved" && state.delivered[x.id] === undefined)
            .map((x) => x.firstObservedAt + 60_000 - Date.now());
        if (due.length) {
            const timer = setTimeout(() => scheduleFailureAttention(pi, id, getActiveSession), Math.max(1, Math.min(...due)));
            timer.unref();
            attentionTimers.set(id, timer);
        }
    }
    return { suspendFailureAttention, resumeFailureAttention, stopFailureAttention, scheduleFailureAttention, failureAttentionFields };
}
/** Shared by the compatibility exports here and the legacy background runtime. */
export const defaultAttention = createFailureAttention();
export const { suspendFailureAttention, resumeFailureAttention, stopFailureAttention, scheduleFailureAttention, failureAttentionFields } = defaultAttention;
export function terminalFailureAttention(id) {
    return pendingFailureAttention(readFailureState(failurePath(id)), Date.now(), { terminal: true });
}
