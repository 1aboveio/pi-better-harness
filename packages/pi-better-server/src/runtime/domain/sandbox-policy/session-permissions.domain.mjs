// Generated fixed launch domain from packages/pi-better-sandbox/session-permissions.ts. Do not edit directly.
import { parseSandboxPermissions } from "./permissions.domain.mjs";
export const SESSION_PERMISSION_ENTRY = "pi-better-sandbox-permissions";
/** Only the active branch contributes policy; the newest entry must validate. */
export function readSessionPermissions(ctx) {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === SESSION_PERMISSION_ENTRY);
    if (!entry || entry.type !== "custom")
        return undefined;
    const data = entry.data;
    if (!data || data.version !== 1)
        throw new Error("Unsupported sandbox session permissions version.");
    // Session snapshots have always included Tools. Unlike old global files,
    // an incomplete snapshot must not gain the default trusted-tool grants.
    if (!data.permissions || typeof data.permissions !== "object" ||
        data.permissions.subagentTools === undefined) {
        throw new Error("Sandbox session permissions require explicit subagent tool settings.");
    }
    return parseSandboxPermissions(data.permissions);
}
export function appendSessionPermissions(pi, settings) {
    pi.appendEntry(SESSION_PERMISSION_ENTRY, { version: 1, permissions: parseSandboxPermissions(settings) });
}
