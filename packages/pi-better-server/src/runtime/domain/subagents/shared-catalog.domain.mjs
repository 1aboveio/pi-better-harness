// Generated fixed launch domain from packages/pi-better-subagents/shared-catalog.ts. Do not edit directly.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "./shared-work-client.mjs";
import { catalogSnapshotFromWire, defaultUserRoot } from "./catalog-store.domain.mjs";
import { catalogHostAuthority } from "./catalog-host-admission.domain.mjs";
/** Short-lived catalog connection. No transcript or permission authority travels here. */
export async function openSharedCatalog(cwd, userRoot = defaultUserRoot(), sessionId = "catalog", projectAccess) {
    const agentDir = realpathSync(userRoot);
    let registration;
    try {
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await ensureCatalogRuntime(agentDir);
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    if (registration.version !== 1 || registration.agentDir !== agentDir)
        throw new Error("Invalid canonical runtime registration");
    const client = await connectCatalogClient(agentDir, registration.serverDir);
    const register = async () => {
        const authority = await catalogHostAuthority(agentDir, cwd, join(registration.serverDir, "pi-server.sock"));
        await client.request("runtime_register_catalog", { cwd, sessionId: authority?.sessionId ?? sessionId, authority, projectAccess: projectAccess === false ? "deny" : undefined });
    };
    try {
        await client.ready;
        await register();
    }
    catch (error) {
        client.close();
        throw error;
    }
    return {
        async get(overlay) {
            await register();
            const wire = await client.request("runtime_get_catalog", { overlay });
            return catalogSnapshotFromWire(wire);
        },
        async edit(edit) { await register(); return client.request("runtime_edit_catalog", edit); },
        async scopedAgents(scope) { await register(); return client.request("runtime_get_catalog_scope", { scope }); },
        async subscribe(changed) {
            await register();
            client.onCatalog(wire => {
                if (wire.status !== "revoked") {
                    changed(catalogSnapshotFromWire(wire));
                    return;
                }
                changed(undefined);
                if (!client.closed)
                    void register().then(() => client.request("runtime_subscribe_catalog"))
                        .then(next => changed(catalogSnapshotFromWire(next)), () => changed(undefined));
            });
            return catalogSnapshotFromWire(await client.request("runtime_subscribe_catalog"));
        },
        close: () => client.close(),
    };
}
/** Retry connection establishment only; never replay a Catalog edit or authorization failure. */
export async function connectCatalogClient(agentDir, serverDir, ensure = ensureCatalogRuntime) {
    const connect = async () => {
        const client = new WorkClient(join(serverDir, "pi-server.sock"), agentDir, ["runtime-catalog-v1"]);
        try {
            await client.ready;
            return client;
        }
        catch (error) {
            client.close();
            throw error;
        }
    };
    try {
        return await connect();
    }
    catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes(error.code ?? ""))
            throw error;
        await ensure(agentDir);
        return connect();
    }
}
async function ensureCatalogRuntime(agentDir) {
    const path = "./runtime-client/src/runtime/client.mjs";
    const { ensureRuntime } = await import(path);
    await ensureRuntime({ agentDir });
}
