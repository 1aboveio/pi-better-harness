// Generated fixed launch domain from packages/pi-better-subagents/shared-catalog.ts. Do not edit directly.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { connectWorkClient } from "./shared-work-client.mjs";
import { catalogSnapshotFromWire, defaultUserRoot } from "./catalog-store.domain.mjs";
import { catalogHostAuthority } from "./catalog-host-admission.domain.mjs";
/** Short-lived catalog connection. No transcript or permission authority travels here. */
export async function openSharedCatalog(cwd, userRoot = defaultUserRoot(), sessionId = "catalog", projectAccess, signal, hostAuthority = catalogHostAuthority) {
    signal?.throwIfAborted();
    const agentDir = realpathSync(userRoot);
    let registration;
    try {
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await waitForCatalogSetup(ensureCatalogRuntime(agentDir, undefined, undefined, signal), signal);
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    if (registration.version !== 1 || registration.agentDir !== agentDir)
        throw new Error("Invalid canonical runtime registration");
    const client = await connectCatalogClient(agentDir, registration.serverDir, undefined, signal);
    const register = async (setupSignal) => {
        const authority = await hostAuthority(agentDir, cwd, join(registration.serverDir, "pi-server.sock"));
        setupSignal?.throwIfAborted();
        await client.request("runtime_register_catalog", { cwd, sessionId: authority?.sessionId ?? sessionId, authority, projectAccess: projectAccess === false ? "deny" : undefined });
    };
    try {
        await waitForCatalogSetup(register(signal), signal);
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
        async decision(action, scope, token, answer) {
            await register();
            return client.request("runtime_supervisor_review", { action, scope, token, answer });
        },
        async sharedReadDiagnosis(verifiedIncident) {
            await register();
            return client.request("runtime_supervisor_review", { action: "read-health", verifiedIncident });
        },
        async review(scenario, action, token) {
            await register();
            return client.request("runtime_supervisor_review", { scenario, action, token });
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
export async function connectCatalogClient(agentDir, serverDir, ensure = ensureCatalogRuntime, signal) {
    return connectWorkClient(join(serverDir, "pi-server.sock"), agentDir, ["runtime-catalog-v1"], {
        signal,
        recover: ({ timeoutMs, signal }) => ensure(agentDir, serverDir, timeoutMs, signal),
    });
}
/** Cancel an individual wait without revoking a Catalog authority shared with other callers. */
export function waitForCatalogSetup(pending, signal) {
    if (!signal)
        return pending;
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) {
            signal.removeEventListener("abort", abort);
            abort();
        }
    });
}
async function ensureCatalogRuntime(agentDir, serverDir, timeoutMs, signal) {
    const path = "./runtime-client/src/runtime/client.mjs";
    const { ensureRuntime } = await import(path);
    await ensureRuntime({ agentDir, serverDir, timeoutMs, signal });
}
