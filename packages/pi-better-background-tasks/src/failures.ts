import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  actionableFailures, activeFailures, failureAttentionHandled, failureIdentity, formatFailureSummary, markFailureAttentionDelivered,
  observeFailures, pendingAttentionNote, pendingAttentionRows, pendingFailureAttention, readCommandIntent, readFailureState,
  type FailureEvent, type FailureState,
} from "./shared-failure-observations.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { listMetasForOrigin, originOf, readMeta, taskDir } from "./registry.js";
import type { ActiveSessionProvider } from "./runtime.js";
import type { BackgroundTaskMeta } from "./types.js";

export const failurePath = (id: string): string => join(taskDir(id), "failures.jsonl");
export const failureSummary = (id: string): string => formatFailureSummary(readFailureState(failurePath(id)));
/**
 * The failure summary plus whether anything needs action. A navigator row leads with failure text
 * only when something does; the quiet history line never displaces the command (#332).
 */
export function failureView(id: string): { text: string; actionable: boolean } {
  const state = readFailureState(failurePath(id));
  return { text: formatFailureSummary(state), actionable: actionableFailures(state).length > 0 };
}

export function recordFailure(meta: BackgroundTaskMeta, operation: string, summary: string, eventKey: unknown,
  options: { category?: string; expected?: boolean; incomplete?: boolean; evidence?: string; at?: number } = {}): void {
  observeFailures(failurePath(meta.id), [{
    id: failureIdentity(meta.id, operation, eventKey), operation,
    kind: options.incomplete ? "incomplete" : "failure", summary,
    category: options.category, expected: options.expected, evidence: options.evidence,
    at: options.at,
  }]);
}

export function recoverFailure(meta: BackgroundTaskMeta, operation: string, eventKey: unknown, at = Date.now()): void {
  const path = failurePath(meta.id);
  const active = readFailureState(path).observations[failureIdentity(operation)];
  if (!active || active.status === "resolved") return;
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
export function readTaskIntent(params: { operation_id?: unknown; expected_exit_codes?: unknown }): Pick<BackgroundTaskMeta, "operationId" | "expectedExitCodes"> {
  const { intent, error } = readCommandIntent({ operationId: params.operation_id, expectedExitCodes: params.expected_exit_codes },
    { operationId: "operation_id", expectedExitCodes: "expected_exit_codes" });
  if (error) throw new Error(`Invalid command intent: ${error}. The task was not started.`);
  return { ...(intent.operationId ? { operationId: intent.operationId } : {}), ...(intent.expectedExitCodes ? { expectedExitCodes: intent.expectedExitCodes } : {}) };
}

/** A structured exit code the caller declared intentional before launch. Signals and timeouts never are. */
export function isDeclaredExpectedExit(meta: BackgroundTaskMeta, exitCode: number | null | undefined): exitCode is number {
  return typeof exitCode === "number" && exitCode !== 0 && (meta.expectedExitCodes ?? []).includes(exitCode);
}

/** Record a non-zero command exit, classified as expected only when its code was declared before launch. */
export function recordExitFailure(meta: BackgroundTaskMeta, operation: string, summary: string, exitCode: number | null | undefined, eventKey: unknown,
  options: { at?: number; expected?: boolean } = {}): void {
  const declared = isDeclaredExpectedExit(meta, exitCode);
  recordFailure(meta, operation, declared ? `${summary} (declared expected)` : summary, eventKey,
    { category: "exit", expected: declared || options.expected === true, at: options.at });
}

function declaredOperation(meta: BackgroundTaskMeta): string | undefined {
  return meta.operationId ? failureIdentity("bg-operation", meta.kind, meta.operationId, meta.cwd, meta.ssh?.target ?? null) : undefined;
}

/**
 * Recovery crosses tasks only within one owner (#325): the same non-empty session id, or, for
 * sessionless tasks, the same spawning process (#312's sessionless ownership rule). The origin
 * index alone treats two sessionless sessions in one cwd as one origin.
 */
function sameRecoveryOwner(a: BackgroundTaskMeta, b: BackgroundTaskMeta): boolean {
  const sa = a.callbackOrigin?.sessionId, sb = b.callbackOrigin?.sessionId;
  if (sa || sb) return Boolean(sa) && sa === sb;
  return a.spawnPid === b.spawnPid && a.spawnPidStartTime === b.spawnPidStartTime;
}

/**
 * A task that succeeded with a declared `operationId` recovers the unresolved failures of earlier
 * tasks of the same owner (session, or spawning process when sessionless) that declared the same operation (same kind, cwd, and SSH target) and
 * failed before this task started: a modified retry as a new task. Observation gaps and expected
 * failures are left alone; nothing is matched on command text.
 */
export function recoverDeclaredOperation(meta: BackgroundTaskMeta, at = Date.now()): void {
  const operation = declaredOperation(meta);
  if (!operation) return;
  let earlier: BackgroundTaskMeta[];
  try { earlier = listMetasForOrigin(originOf(meta)); } catch { return; }
  for (const task of earlier) {
    if (task.id === meta.id || task.startedAt >= meta.startedAt || declaredOperation(task) !== operation || !sameRecoveryOwner(task, meta)) continue;
    const path = failurePath(task.id);
    const events: FailureEvent[] = activeFailures(readFailureState(path))
      .filter((x) => x.status === "unresolved" && x.category !== "observation-incomplete" && x.lastObservedAt <= meta.startedAt)
      .map((x) => ({ id: failureIdentity(task.id, x.id, "recovered-by", meta.id), operation: x.operation, kind: "recovered", incidents: [x.id], at,
        evidence: `task ${meta.id} (operation ${meta.operationId}) succeeded` }));
    if (events.length) observeFailures(path, events);
  }
}

const attentionTimers = new Map<string, ReturnType<typeof setTimeout>>();
let attentionSuspended = false;
/** Session shutdown: stop this instance's attention timers; the next session_start reschedules (#324). */
export function suspendFailureAttention(): void {
  attentionSuspended = true;
  for (const timer of attentionTimers.values()) clearTimeout(timer);
  attentionTimers.clear();
}
export function resumeFailureAttention(): void {
  attentionSuspended = false;
}
export function stopFailureAttention(id: string): void {
  const timer = attentionTimers.get(id);
  if (timer) clearTimeout(timer);
  attentionTimers.delete(id);
}

/**
 * Model-facing fields of a running task's failure attention. The notification
 * identity is per incident set; the inspect target is the real task id.
 * Only the pending incidents are rows; earlier deliveries are counted, never repeated (#315).
 */
export function failureAttentionFields(meta: BackgroundTaskMeta, state: FailureState, pending: { key: string; incidents: string[] }) {
  const rows = pendingAttentionRows(state, pending.incidents);
  const note = pendingAttentionNote(state, pending.incidents);
  const due = pending.incidents.length;
  return {
    source: "background-task" as const,
    id: `failure:${meta.id}:${pending.key}`,
    inspectId: meta.id,
    label: meta.name ?? meta.id,
    status: "failure",
    customType: "background-task-failure",
    content: `Background task ${meta.id} is still running with ${due} failure observation${due === 1 ? "" : "s"} that need attention.${note ? ` ${note}` : ""}`,
    detailTool: "bg_task_status" as const,
    failureRows: rows,
    incidentCount: rows.length || undefined,
  };
}

/** Running incidents get one grace wake. Terminal incidents ride the completion callback. */
export function scheduleFailureAttention(pi: ExtensionAPI, id: string, getActiveSession?: ActiveSessionProvider): void {
  stopFailureAttention(id);
  if (attentionSuspended) return;
  const meta = readMeta(id);
  if (!meta) {
    const timer = setTimeout(() => scheduleFailureAttention(pi, id, getActiveSession), 1_000);
    timer.unref();
    attentionTimers.set(id, timer);
    return;
  }
  if (meta.status !== "running" || meta.callback === false || meta.stopRequestedAt) return;
  const state = readFailureState(failurePath(id));
  const pending = pendingFailureAttention(state, Date.now());
  if (pending) {
    const delivery = getCallbackBatcher(pi).deliverUrgent({
      ...failureAttentionFields(meta, state, pending),
      isDelivered: () => {
        const current = readMeta(id);
        if (!current) throw new Error("Task metadata is unavailable; defer failure notification");
        const now = readFailureState(failurePath(id));
        return current.status !== "running" || failureAttentionHandled(now, pending.incidents);
      },
      getSuppressionReason: () => {
        const current = readMeta(id);
        if (!current) throw new Error("Task metadata is unavailable; defer failure notification");
        if (current.status !== "running" || current.callback === false || current.stopRequestedAt) return "task is no longer running";
        const origin = current.callbackOrigin;
        const active = getActiveSession?.();
        if (origin && (!active || origin.cwd !== active.cwd || (origin.sessionId && origin.sessionId !== active.sessionId))) return "callback origin is not active";
        if (!origin && active && active.cwd !== current.cwd) return "callback cwd is not active";
        return undefined;
      },
      onDelivered: (at) => { markFailureAttentionDelivered(failurePath(id), pending, at); },
    });
    void Promise.resolve(delivery).then((sent) => {
      if (!sent && (!readMeta(id) || readMeta(id)?.status === "running")) {
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

export function terminalFailureAttention(id: string) {
  return pendingFailureAttention(readFailureState(failurePath(id)), Date.now(), { terminal: true });
}
