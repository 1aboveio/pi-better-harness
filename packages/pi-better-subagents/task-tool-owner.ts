/** Loaded before third-party extensions so guarded tools win SDK name resolution. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAIM_CHANNEL = "pi-better-subagents:claim-task-tool-owner";
type RegisterTool = ExtensionAPI["registerTool"];

export default function taskToolOwner(pi: ExtensionAPI): void {
    const unsubscribe = pi.events.on(CLAIM_CHANNEL, (claim) => {
        if (typeof claim !== "function") return;
        unsubscribe();
        claim(pi.registerTool.bind(pi));
    });
}

/** Hand registration to the final guard without changing the SDK's source attribution. */
export function claimTaskToolOwner(pi: ExtensionAPI): RegisterTool {
    let register: RegisterTool | undefined;
    pi.events.emit(CLAIM_CHANNEL, (owner: RegisterTool) => { register = owner; });
    if (!register) throw new Error("Task tool owner was not installed before extension loading.");
    return register;
}