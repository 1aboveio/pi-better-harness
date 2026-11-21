// Generated fixed launch domain from packages/pi-better-sandbox/events.ts. Do not edit directly.
/**
 * Cross-extension publication of the effective foreground sandbox policy.
 *
 * The contract is deliberately narrow: a frozen status snapshot travels over
 * `pi.events`, and nothing else. No function, no controller, no way to run a
 * command — a consumer can read what the policy is and enforce it itself, and
 * that is all.
 *
 * Consumers snapshot at launch time. `pi.events` has no replay, so an extension
 * that loads late can ask for the current policy on the request channel and
 * receive it on the policy channel.
 */
/** Channel carrying every effective-policy change. Payload: ForegroundSandboxPolicyEvent. */
export const FOREGROUND_SANDBOX_POLICY_CHANNEL = "pi-better-sandbox:policy";
/** Channel a late-loading consumer emits on to ask for the current policy. */
export const FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL = "pi-better-sandbox:policy-request";
/** Deep-freeze launch-policy data so consumers cannot change each other's copy. */
export function freezePolicy(status, background = status) {
    return Object.freeze({
        ...status,
        state: status.state === "inactive" ? "disabled" : status.state,
        denyWrite: Object.freeze([...status.denyWrite]),
        ...(status.permissions ? { permissions: Object.freeze({ ...status.permissions }) } : {}),
        background: Object.freeze({
            state: background.state === "inactive" ? "disabled" : background.state,
            writableRoot: background.writableRoot,
            denyWrite: Object.freeze([...background.denyWrite]),
            reason: background.reason,
            ...(background.permissions ? { permissions: Object.freeze({ ...background.permissions }) } : {}),
        }),
    });
}
/** Publish the current effective policy to every subscribed extension. */
export function publishForegroundSandboxPolicy(events, status, background = status) {
    const payload = freezePolicy(status, background);
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, payload);
    return payload;
}
/** Subscribe to effective-policy changes. Returns an unsubscribe function. */
export function subscribeForegroundSandboxPolicy(events, handler) {
    return events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (data) => {
        handler(data);
    });
}
/** Ask the sandbox extension to re-publish the current effective policy. */
export function requestForegroundSandboxPolicy(events) {
    events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
}
