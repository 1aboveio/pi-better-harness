// Generated fixed launch domain from packages/pi-better-subagents/continuation-authority.ts. Do not edit directly.
/** Intersect captured permissions with the current mandatory profile. */
export function intersectContinuationPermissions(captured, current) {
    if (!captured || !current)
        throw new Error("Continuation permission authority unavailable");
    if (captured.subagentTools && JSON.stringify(captured.subagentTools) !== JSON.stringify(current.subagentTools)) {
        throw new Error("Continuation tool authority changed; explicit re-admission required");
    }
    const intersect = (old, fresh) => {
        if (!old || !fresh)
            throw new Error("Continuation permission profile unavailable");
        const access = ["off", "read", "write", "read-write"];
        const value = { ...fresh, enabled: old.enabled || fresh.enabled };
        for (const key of ["projectFiles", "outsideProject", "storedCredentials"]) {
            if (!access.includes(old[key]) || !access.includes(fresh[key]))
                throw new Error("Invalid continuation permission profile");
            value[key] = access[Math.min(access.indexOf(old[key]), access.indexOf(fresh[key]))];
        }
        for (const key of ["commands", "network"])
            value[key] = old[key] && fresh[key];
        value.shell = old.shell !== false && fresh.shell !== false;
        value.processAccess = old.processAccess === "read" && fresh.processAccess === "read" ? "read" : "off";
        const caps = [old.commandTimeoutSeconds, fresh.commandTimeoutSeconds].filter((n) => typeof n === "number" && n > 0);
        value.commandTimeoutSeconds = caps.length ? Math.min(...caps) : null;
        return value;
    };
    return { permissions: captured.permissions ? intersect(captured.permissions, current.main) : current.main,
        subagentPermissions: captured.subagentPermissions ? intersect(captured.subagentPermissions, current.subagents) : current.subagents,
        subagentTools: captured.subagentTools ?? current.subagentTools };
}
