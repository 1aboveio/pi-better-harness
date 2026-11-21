// Generated fixed launch domain from packages/pi-better-background-tasks/src/observed-wait-client.ts. Do not edit directly.
const hosts = new WeakMap();
export function registerObservedWaitClient(pi, host) { hosts.set(pi, host); }
export function getObservedWaitHost(pi) {
    return pi && typeof pi === "object" ? hosts.get(pi) : undefined;
}
