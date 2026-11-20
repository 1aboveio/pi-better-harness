import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activateWorkObservation, hasWorkObservationContext, workObservation, onWorkObservation } from "./work-observation.ts";
import {
    belongsToOrigin,
    effectiveStatus,
    isPendingPark,
    listMetasForParent,
    onMetaChanged,
    readParkRecord,
} from "./registry.ts";

const GOAL_READY_EVENT = "pi-better-goal:ready";
const GOAL_REGISTER_PROVIDER_EVENT = "pi-better-goal:register-provider";
const goalReadySubscriptions = new WeakSet<ExtensionAPI>();

/**
 * Project a worker's park disposition for the Goal/navigator surface.
 *
 * A parked attempt is a completed ATTEMPT with an outstanding wait, not a
 * completed assignment (ADR 0020). The row therefore stays non-terminal, keeps
 * `status` as the attempt status, and carries the wait identity in `details` so
 * `waiting for <wait>` and `ready, awaiting slot` can be shown without a second
 * registry. A held or unattributable wait is unhealthy: it needs its owner.
 */
function parkActivity(meta: Parameters<typeof effectiveStatus>[0]): Record<string, unknown> | undefined {
    const record = meta.park ?? readParkRecord(meta.id);
    if (!record) return undefined;
    if (!isPendingPark(record)) return undefined;
    return {
        waitId: record.waitId,
        generation: record.generation,
        phase: record.phase,
        waiting: record.phase === "parking" || record.phase === "waiting",
        ready: record.phase === "ready",
        held: record.phase === "held",
        ...(record.heldReason ? { heldReason: record.heldReason } : {}),
        ...(record.continuationNote ? { continuationNote: record.continuationNote } : {}),
        ...(record.resumedBy ? { resumedBy: record.resumedBy } : {}),
    };
}

function observedActivity(observed: any, ctx?: ExtensionContext) {
    if (observed?.status !== "ready") throw new Error(observed?.reason ?? "Subagent activity is unverified");
    return {
        providerId: "subagents", label: "Subagents", nextDeadline: observed.nextDeadline ?? null,
        items: observed.rows.filter((row: any) => !ctx || (
            belongsToOrigin(row.meta, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }) &&
            (!row.meta.callbackOrigin?.branchId || ctx.sessionManager.getBranch().some(entry => entry.id === row.meta.callbackOrigin.branchId))
        )).map((row: any) => {
            const status = row.assignment.state;
            const active = status === "running" || status === "waiting";
            return { id: row.meta.id, label: row.meta.name, status, active, terminal: !active,
                attention: !active && status !== "completed", unhealthy: row.meta.status === "orphaned",
                startedAt: row.meta.startedAt, endedAt: row.meta.endedAt,
                details: { assignment: row.assignment, sourceRevision: row.sourceRevision } };
        }),
    };
}

export function registerSubagentsGoalProvider(pi: ExtensionAPI): void {
    const emitProvider = (): void => {
        pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
            id: "subagents",
            label: "Subagents",
            scope: "session",
            activityVersion: 1,
            getActivity: (ctx?: ExtensionContext, options?: { cachedOnly?: boolean }) => {
                const observed = workObservation();
                if (!observed && options?.cachedOnly) {
                    return { providerId: "subagents", coverage: "unverified", items: [], nextDeadline: null };
                }
                if (!observed && hasWorkObservationContext()) {
                    return activateWorkObservation().then(() => observedActivity(workObservation(), ctx));
                }
                if (observed) {
                    return observedActivity(observed, ctx);
                }
                let sessionId: string | undefined;
                try {
                    sessionId = ctx?.sessionManager?.getSessionId();
                } catch {
                    sessionId = undefined;
                }
                const origin = ctx ? { cwd: ctx.cwd, sessionId } : undefined;
                return {
                    providerId: "subagents",
                    nextDeadline: null,
                    label: "Subagents",
                    items: listMetasForParent(process.pid)
                        .filter((meta) => !origin || belongsToOrigin(meta, origin))
                        .filter((meta) => !ctx || !meta.callbackOrigin?.branchId || ctx.sessionManager.getBranch().some(entry => entry.id === meta.callbackOrigin?.branchId))
                        .map((meta) => {
                            const status = effectiveStatus(meta);
                            const active = status === "running" || status === "orphaned";
                            const park = parkActivity(meta);
                            const held = park?.held === true;
                            return {
                                id: meta.id,
                                ...(meta.name ? { label: meta.name } : {}),
                                status,
                                active,
                                // A parked attempt keeps its assignment open: name and
                                // evidence stay reachable, and it is not a finished row.
                                terminal: !active && park === undefined,
                                unhealthy: status === "orphaned" || held,
                                attention: status === "orphaned" || status === "failed" || status === "killed" || status === "lost" || status === "exited" || held,
                                startedAt: meta.startedAt,
                                ...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
                                ...(park ? { details: { park } } : {}),
                            };
                        }),
                };
            },
            onActivityChanged: (notify: () => void, ctx?: ExtensionContext) => {
                const offObservation = onWorkObservation(notify);
                const offMeta = onMetaChanged((meta) => {
                if (ctx && meta) {
                    if (!belongsToOrigin(meta, { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() })) return;
                    if (meta.callbackOrigin?.branchId && !ctx.sessionManager.getBranch().some(entry => entry.id === meta.callbackOrigin?.branchId)) return;
                }
                notify();
                });
                return () => { offObservation(); offMeta(); };
            },
        });
    };
    if (!goalReadySubscriptions.has(pi)) {
        pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
        goalReadySubscriptions.add(pi);
    }
    emitProvider();
}
