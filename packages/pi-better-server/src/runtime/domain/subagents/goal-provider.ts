import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

export function registerSubagentsGoalProvider(pi: ExtensionAPI): void {
    const emitProvider = (): void => {
        pi.events?.emit(GOAL_REGISTER_PROVIDER_EVENT, {
            id: "subagents",
            label: "Subagents",
            scope: "session",
            getActivity: (ctx?: ExtensionContext) => {
                let sessionId: string | undefined;
                try {
                    sessionId = ctx?.sessionManager?.getSessionId();
                } catch {
                    sessionId = undefined;
                }
                const origin = ctx ? { cwd: ctx.cwd, sessionId } : undefined;
                return {
                    providerId: "subagents",
                    label: "Subagents",
                    items: listMetasForParent(process.pid)
                        .filter((meta) => !origin || belongsToOrigin(meta, origin))
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
            onActivityChanged: onMetaChanged,
        });
    };
    if (!goalReadySubscriptions.has(pi)) {
        pi.events?.on?.(GOAL_READY_EVENT, emitProvider);
        goalReadySubscriptions.add(pi);
    }
    emitProvider();
}
