import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "./shared-work-client.mjs";

let client: WorkClient | undefined;
let failure = "Shared runtime observation is connecting.";
let generation = 0;

export function workObservation() { return client?.snapshot; }
export function workObservationFailure() { return client?.snapshot?.reason ?? failure; }

export async function startWorkObservation(agentDir: string, origin: { cwd: string; sessionId?: string }, changed: () => void) {
    stopWorkObservation();
    const current = generation;
    try {
        agentDir = realpathSync(agentDir);
        let registration;
        try { registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8")); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            // The generated standalone installer is shipped at prepack, never loaded by render.
            const path = "./runtime-client/src/runtime/client.mjs";
            const { ensureRuntime } = await import(path);
            await ensureRuntime({ agentDir });
            registration = JSON.parse(readFileSync(join(agentDir, "server-registration-v1.json"), "utf8"));
        }
        if (current !== generation) return;
        if (registration.version !== 1 || registration.agentDir !== agentDir) throw new Error("Invalid canonical runtime registration");
        client = new WorkClient(join(registration.serverDir, "pi-server.sock"), agentDir);
        client.onChange(changed);
        await client.subscribe({ ...origin, limit: 200 });
    } catch (error) {
        if (current !== generation) return;
        failure = `Shared runtime observation unavailable: ${String(error)}`;
        changed();
    }
}

export async function observedAssignment(id: string) {
    if (!client) throw new Error(workObservationFailure());
    const snapshot = await client.get({ id, limit: 1 });
    const row = snapshot.rows[0];
    if (!row) throw new Error(snapshot.status === "ready" ? `No shared observation for ${id}` : snapshot.reason);
    return { assignment: row.assignment, snapshot };
}

export function stopWorkObservation() {
    generation++; client?.close(); client = undefined;
}
