// Generated fixed launch domain from packages/pi-better-subagents/managed-background-capability.ts. Do not edit directly.
/** Native frontend advertises a server route, never a fake local mechanical service. */
export function nativeBackgroundCapability(pi) {
    let available = false;
    pi.events?.emit('pi-better-background-tasks:managed-capability', { accept(value) {
            const capability = value;
            available = capability?.version === 1 && capability.assignmentContinuation === 1;
        } });
    return available;
}
