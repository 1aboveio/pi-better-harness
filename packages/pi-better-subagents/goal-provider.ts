import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { belongsToOrigin, effectiveStatus, listMetasForParent, onMetaChanged } from "./registry.ts";

const GOAL_READY_EVENT = "pi-better-goal:ready";
const GOAL_REGISTER_PROVIDER_EVENT = "pi-better-goal:register-provider";
const goalReadySubscriptions = new WeakSet<ExtensionAPI>();

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
                            return {
                                id: meta.id,
                                ...(meta.name ? { label: meta.name } : {}),
                                status,
                                active,
                                unhealthy: status === "orphaned",
                                terminal: !active,
                                attention: status === "orphaned" || status === "failed" || status === "killed" || status === "lost" || status === "exited",
                                startedAt: meta.startedAt,
                                ...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
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
