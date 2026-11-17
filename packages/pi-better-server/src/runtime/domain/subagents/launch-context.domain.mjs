// Generated fixed launch domain from packages/pi-better-subagents/launch-context.ts. Do not edit directly.
/** Capture the invoking foreground before launch preparation can yield. */
export function captureLaunchContext(ctx) {
    const manager = ctx?.sessionManager;
    if (!manager)
        return ctx;
    const sessionId = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
    const branch = typeof manager.getBranch === "function" ? structuredClone(manager.getBranch()) : undefined;
    const leafId = typeof manager.getLeafId === "function" ? manager.getLeafId() : undefined;
    const sessionFile = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
    const reads = {
        ...(typeof manager.getSessionId === "function" ? { getSessionId: () => sessionId } : {}),
        ...(typeof manager.getBranch === "function" ? { getBranch: () => branch } : {}),
        ...(typeof manager.getLeafId === "function" ? { getLeafId: () => leafId } : {}),
        ...(typeof manager.getSessionFile === "function" ? { getSessionFile: () => sessionFile } : {}),
    };
    const captured = new Proxy(manager, { get(target, key) {
            if (Object.hasOwn(reads, key))
                return reads[key];
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        } });
    return { ...ctx, sessionManager: captured };
}
