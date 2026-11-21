import { createHash } from "node:crypto";
import type { AgentSessionOverrides } from "./agent-session-settings.ts";

/** Canonical host/server credential binding for branch-local Catalog preferences. */
export function overlayDigest(value: AgentSessionOverrides = {}): string {
    const canonical = Object.fromEntries(Object.keys(value).sort().map(id => [id,
        Object.fromEntries(Object.entries(value[id]!).sort(([a], [b]) => a.localeCompare(b))),
    ]));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
