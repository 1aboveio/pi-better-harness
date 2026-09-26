import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  failureAttentionHandled, failureIdentity, formatFailureSummary, markFailureAttentionDelivered,
  observeFailures, pendingFailureAttention, readFailureState,
} from "./shared-failure-observations.js";
import { getCallbackBatcher } from "./shared-callback-batcher.js";
import { readMeta, taskDir } from "./registry.js";
import type { ActiveSessionProvider } from "./runtime.js";
import type { BackgroundTaskMeta } from "./types.js";

export const failurePath = (id: string): string => join(taskDir(id), "failures.jsonl");
export const failureSummary = (id: string): string => formatFailureSummary(readFailureState(failurePath(id)));

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

const attentionTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function stopFailureAttention(id: string): void {
  const timer = attentionTimers.get(id);
  if (timer) clearTimeout(timer);
  attentionTimers.delete(id);
}

/** Running incidents get one grace wake. Terminal incidents ride the completion callback. */
export function scheduleFailureAttention(pi: ExtensionAPI, id: string, getActiveSession?: ActiveSessionProvider): void {
  stopFailureAttention(id);
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
      source: "background-task", id: `failure:${id}:${pending.key}`, label: meta.name ?? id,
      status: "failure", customType: "background-task-failure",
      content: `Background task ${id}: ${pending.summary}\nInspect: bg_task_status id=${id}`,
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
