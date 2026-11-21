/** Intersect captured execution authority with the current mandatory Background profile. */
export function effectiveBackgroundPolicy(captured: any, fresh: any, workspace: string): any {
    if (!captured && !fresh.enabled)
        return undefined;
    if (captured && ['failed', 'unavailable'].includes(captured.state))
        return captured;
    const old = captured?.permissions;
    const finish = (profile: any) => ({ ...captured, state: profile.enabled ? 'enabled' : captured?.state ?? 'inactive',
        writableRoot: captured?.writableRoot ?? workspace, denyWrite: captured?.denyWrite ?? [], permissions: profile,
        reason: 'Captured Background authority intersected with current mandatory profile' });
    if (!fresh.enabled) return finish(old?.enabled ? { ...old } : { ...fresh });
    if (!old?.enabled) return finish({ ...fresh });
    const access = ['off', 'read', 'write', 'read-write'];
    const profile = { ...fresh };
    for (const key of ['projectFiles', 'outsideProject', 'storedCredentials']) {
        if (!access.includes(old[key]) || !access.includes(fresh[key]))
            throw new Error('permission-unavailable: invalid Background profile');
        profile[key] = access[access.indexOf(old[key]) & access.indexOf(fresh[key])];
    }
    for (const key of ['commands', 'network'])
        profile[key] = Boolean(old[key] && fresh[key]);
    profile.shell = old.shell !== false && fresh.shell !== false;
    profile.processAccess = old.processAccess === 'read' && fresh.processAccess === 'read' ? 'read' : 'off';
    const limits = [old.commandTimeoutSeconds, fresh.commandTimeoutSeconds].filter(n => typeof n === 'number' && n > 0);
    profile.commandTimeoutSeconds = limits.length ? Math.min(...limits) : null;
    return finish(profile);
}
