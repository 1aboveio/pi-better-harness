// Generated fixed launch domain from packages/pi-better-subagents/child-codemode.ts. Do not edit directly.
/** Native Pi codemode, explicitly loaded because children disable extension discovery. */
import * as SDK from "@earendil-works/pi-coding-agent";
/** Older supported SDKs have no native codemode; keep their existing tool set. */
export function installChildCodemode(pi, confined = false) {
    const factory = SDK.createCodemodeExtension;
    if (typeof factory !== "function")
        return false;
    // Model globals make direct provider calls outside nested tool hooks.
    // Confined children get only tool dispatch, which passes through the guard.
    factory(confined ? { models: false } : {})(pi);
    return true;
}
export default function childCodemode(pi) {
    installChildCodemode(pi);
}
