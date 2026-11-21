import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WorkClient, connectWorkClient } from "./shared-work-client.mjs";
import { catalogSnapshotFromWire, defaultUserRoot, type CatalogSnapshot } from "./catalog-store.ts";
import type { AgentSessionOverrides } from "./agent-session-settings.ts";
import { catalogHostAuthority } from "./catalog-host-admission.ts";

/** Short-lived catalog connection. No transcript or permission authority travels here. */
export async function openSharedCatalog(cwd: string, userRoot = defaultUserRoot(), sessionId = "catalog", projectAccess?: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const agentDir = realpathSync(userRoot);
    let registration;
    try { registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8")); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await waitForCatalogSetup(ensureCatalogRuntime(agentDir, undefined, undefined, signal), signal);
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    if (registration.version !== 1 || registration.agentDir !== agentDir) throw new Error("Invalid canonical runtime registration");
    const client = await connectCatalogClient(agentDir, registration.serverDir, undefined, signal);
    const register = async (setupSignal?: AbortSignal) => {
        const authority = await catalogHostAuthority(agentDir, cwd, join(registration.serverDir, "pi-server.sock"));
        setupSignal?.throwIfAborted();
        await client.request("runtime_register_catalog", { cwd, sessionId: authority?.sessionId ?? sessionId, authority, projectAccess: projectAccess === false ? "deny" : undefined });
    };
    try {
        await waitForCatalogSetup(register(signal), signal);
    } catch (error) { client.close(); throw error; }
    return {
        async get(overlay?: AgentSessionOverrides): Promise<CatalogSnapshot> {
            await register();
            const wire = await client.request("runtime_get_catalog", { overlay });
            return catalogSnapshotFromWire(wire);
        },
        async edit(edit: Record<string, unknown>) { await register(); return client.request("runtime_edit_catalog", edit); },
        async scopedAgents(scope: "user" | "project") { await register(); return client.request("runtime_get_catalog_scope", { scope }); },
        async subscribe(changed: (snapshot: CatalogSnapshot | undefined) => void) {
            await register();
            client.onCatalog(wire => {
                if (wire.status !== "revoked") { changed(catalogSnapshotFromWire(wire)); return; }
                changed(undefined);
                if (!client.closed) void register().then(() => client.request("runtime_subscribe_catalog"))
                    .then(next => changed(catalogSnapshotFromWire(next)), () => changed(undefined));
            });
            return catalogSnapshotFromWire(await client.request("runtime_subscribe_catalog"));
        },
        close: () => client.close(),
    };
}

/** Retry connection establishment only; never replay a Catalog edit or authorization failure. */
export async function connectCatalogClient(agentDir: string, serverDir: string, ensure = ensureCatalogRuntime, signal?: AbortSignal): Promise<WorkClient> {
    return connectWorkClient(join(serverDir, "pi-server.sock"), agentDir, ["runtime-catalog-v1"], {
        signal,
        recover: ({ timeoutMs, signal }) => ensure(agentDir, serverDir, timeoutMs, signal),
    });
}

/** Cancel an individual wait without revoking a Catalog authority shared with other callers. */
export function waitForCatalogSetup<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
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

async function ensureCatalogRuntime(agentDir: string, serverDir?: string, timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const path = "./runtime-client/src/runtime/client.mjs";
    const { ensureRuntime } = await import(path);
    await ensureRuntime({ agentDir, serverDir, timeoutMs, signal });
}
