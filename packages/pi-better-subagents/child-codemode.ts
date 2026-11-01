/** Native Pi codemode, explicitly loaded because children disable extension discovery. */
import * as SDK from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Older supported SDKs have no native codemode; keep their existing tool set. */
export function installChildCodemode(pi: ExtensionAPI, confined = false): boolean {
    const factory = (SDK as any).createCodemodeExtension;
    if (typeof factory !== "function") return false;
    // Model globals make direct provider calls outside nested tool hooks.
    // Confined children get only tool dispatch, which passes through the guard.
    factory(confined ? { models: false } : {})(pi);
    return true;
}

export default function childCodemode(pi: ExtensionAPI): void {
    installChildCodemode(pi);
}
