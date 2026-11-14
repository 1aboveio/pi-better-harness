/** Versioned reconciliation evidence in the existing durable conversation store. */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableSubagentRoot } from "./session-store.ts";
import type { ParkRecord, RunMeta } from "./registry.ts";

export interface OutageObservation {
    version: 1;
    id: string;
    observedRevision: { generation: number; claimId: string | null; launchToken: string | null; cancelled?: true };
    coordinatorEvidence?: ParkRecord["observedCoordinator"];
    meta: RunMeta;
    record: ParkRecord;
    attempt?: RunMeta;
    resolved?: true;
}

function directory(): string { return join(durableSubagentRoot(), "observations-v1"); }

function publish(path: string, value: unknown): void {
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const temporary = join(directory(), `.${randomBytes(12).toString("hex")}.tmp`);
    try {
        writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        const fd = openSync(temporary, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, path);
        const dir = openSync(directory(), "r");
        try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
        try { unlinkSync(temporary); } catch { /* Already published. */ }
    }
}

export function assertObservationStorage(): void {
    try { publish(join(directory(), "storage-probe.json"), { version: 1 }); }
    catch (error) { throw new Error(`Degraded supervision: durable conversation storage unavailable; new parking refused (${String(error)}).`); }
}

export function retainObservation(meta: RunMeta, record: ParkRecord, attempt?: RunMeta): OutageObservation {
    const observedRevision = { generation: record.generation, claimId: record.resumeClaimId ?? null,
        launchToken: record.resumeLaunchToken ?? null, ...(record.phase === "cancelled" ? { cancelled: true as const } : {}) };
    const id = createHash("sha256").update(JSON.stringify([meta.assignment?.assignmentId ?? meta.id,
        record.waitId, observedRevision])).digest("hex");
    const path = join(directory(), `${id}.json`);
    try {
        const existing = JSON.parse(readFileSync(path, "utf8")) as OutageObservation;
        if (existing.version !== 1 || existing.id !== id) throw new Error("Invalid observation identity");
        return existing;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const report: OutageObservation = { version: 1, id, observedRevision, coordinatorEvidence: record.observedCoordinator,
        meta, record, ...(attempt ? { attempt } : {}) };
    publish(path, report);
    return report;
}

export function pendingObservations(): OutageObservation[] {
    let names: string[];
    try { names = readdirSync(directory()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => {
        const report = JSON.parse(readFileSync(join(directory(), name), "utf8")) as OutageObservation;
        if (report.version !== 1 || `${report.id}.json` !== name) throw new Error("Unsupported or corrupt outage observation");
        return report;
    }).filter((report) => !report.resolved);
}

export function resolveObservation(report: OutageObservation): void {
    publish(join(directory(), `${report.id}.json`), { ...report, resolved: true });
}
