// Generated fixed launch domain from packages/pi-better-subagents/task-tool-owner.ts. Do not edit directly.
const CLAIM_CHANNEL = "pi-better-subagents:claim-task-tool-owner";
export default function taskToolOwner(pi) {
    const unsubscribe = pi.events.on(CLAIM_CHANNEL, (claim) => {
        if (typeof claim !== "function")
            return;
        unsubscribe();
        claim(pi.registerTool.bind(pi));
    });
}
/** Hand registration to the final guard without changing the SDK's source attribution. */
export function claimTaskToolOwner(pi) {
    let register;
    pi.events.emit(CLAIM_CHANNEL, (owner) => { register = owner; });
    if (!register)
        throw new Error("Task tool owner was not installed before extension loading.");
    return register;
}
