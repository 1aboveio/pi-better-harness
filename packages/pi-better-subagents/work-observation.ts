import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { WorkClient } from "./shared-work-client.mjs";

let client: WorkClient | undefined;
let failure = "Shared runtime observation is connecting.";
let generation = 0;
const details = new Map<string, any>();
const pendingDetails = new Set<string>();
let refresh = () => {};

export function workObservation() { return client?.snapshot; }
export function workObservationFailure() { return client?.snapshot?.reason ?? failure; }

export async function startWorkObservation(agentDir: string, origin: { cwd: string; sessionId?: string }, changed: () => void) {
    stopWorkObservation();
    const current = generation;
    refresh = changed;
    try {
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
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
        if (client.snapshot?.status === "rebuilding") await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { stop(); reject(new Error("Runtime scope is still rebuilding; retry the observation.")); }, 5000);
            const stop = client!.onChange(snapshot => {
                if (snapshot.status !== "rebuilding") { stop(); clearTimeout(timer); resolve(); }
            });
        });
    } catch (error) {
        if (current !== generation) return;
        failure = `Shared runtime observation unavailable: ${String(error)}`;
        changed();
    }
}

export async function observedAssignment(id: string) {
    await ensureObservation();
    const snapshot = await client!.get({ id, limit: 1 });
    const row = snapshot.rows[0];
    if (!row) throw new Error(snapshot.status === "ready" ? `No shared observation for ${id}` : snapshot.reason);
    return { assignment: row.assignment, snapshot };
}

export async function observedList(scope: object) {
    await ensureObservation();
    return client!.get(scope);
}

async function ensureObservation() {
    if (!client) await startWorkObservation(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), { cwd: process.cwd() }, () => {});
    if (!client) throw new Error(workObservationFailure());
}

export function stopWorkObservation() {
    generation++; client?.close(); client = undefined; details.clear(); pendingDetails.clear();
}

export function requestWorkDetail(id: string) {
    const cached = details.get(id);
    if (cached?.seq === client?.snapshot?.seq || pendingDetails.has(id) || !client) return cached?.row;
    pendingDetails.add(id);
    const current = generation;
    void client.get({ id, detail: true, limit: 1 }).then(snapshot => {
        if (current !== generation) return;
        details.set(id, { seq: snapshot.seq, row: snapshot.rows[0] });
        if (details.size > 16) details.delete(details.keys().next().value!);
        refresh();
    }).catch(error => {
        if (current !== generation) return;
        failure = String(error);
        details.set(id, { seq: client?.snapshot?.seq, row: { ...cached?.row, observationError: failure } });
        refresh();
    }).finally(() => { pendingDetails.delete(id); });
    return cached?.row;
}
