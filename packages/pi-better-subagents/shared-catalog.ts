import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "./shared-work-client.mjs";
import { catalogSnapshotFromWire, defaultUserRoot, type CatalogSnapshot } from "./catalog-store.ts";
import type { AgentSessionOverrides } from "./agent-session-settings.ts";

/** Short-lived catalog connection. No transcript or permission authority travels here. */
export async function openSharedCatalog(cwd: string, userRoot = defaultUserRoot(), sessionId = "catalog", projectAccess?: boolean) {
    const agentDir = realpathSync(userRoot);
    let registration;
    try { registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8")); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const path = "./runtime-client/src/runtime/client.mjs";
        const { ensureRuntime } = await import(path);
        await ensureRuntime({ agentDir });
        registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
    }
    if (registration.version !== 1 || registration.agentDir !== agentDir) throw new Error("Invalid canonical runtime registration");
    const client = new WorkClient(join(registration.serverDir, "pi-server.sock"), agentDir, ["runtime-catalog-v1"]);
    try {
        await client.ready;
        await client.request("runtime_register_catalog", { cwd, sessionId, projectAccess: projectAccess === false ? "deny" : undefined });
    } catch (error) { client.close(); throw error; }
    return {
        async get(overlay?: AgentSessionOverrides): Promise<CatalogSnapshot> {
            const wire = await client.request("runtime_get_catalog", { overlay });
            return catalogSnapshotFromWire(wire);
        },
        edit: (edit: Record<string, unknown>) => client.request("runtime_edit_catalog", edit),
        close: () => client.close(),
    };
}
