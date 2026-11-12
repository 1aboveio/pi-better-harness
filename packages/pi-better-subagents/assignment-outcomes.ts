import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { openSync, closeSync, fstatSync, readSync, realpathSync, constants } from "node:fs";
import { openStore, type OwnerIdentity, type AssignmentOutcomeRecord } from "./shared-operation-coordinator/index.ts";
import type { RunMeta } from "./registry.ts";
import { processStartToken } from "./registry.ts";
import type { PermissionSnapshot } from "./permission-policy.ts";
import { credentialFilePaths } from "./shared-sandbox-core.ts";

export const ASSIGNMENT_OUTCOMES_VERSION = 1;
const closedHosts = (globalThis as typeof globalThis & { __assignmentOutcomeClosedHosts?: Set<string> }).__assignmentOutcomeClosedHosts ??= new Set<string>();
export function createOutcomeHost(): string {
    return `assignment:${process.pid}:${encodeURIComponent(processStartToken(process.pid) ?? "unknown")}:${randomUUID()}`;
}
export function closeOutcomeHost(hostId: string): void {
    closedHosts.add(hostId);
}
export function claimOutcome(meta: RunMeta, hostId: string): boolean {
    const outcome = readOutcome(meta);
    if (!outcome) return false;
    return withStore((store) => {
        const event = store.listOutbox().find((e) => e.eventId === outcome.eventId);
        if (!event || ["delivered", "acknowledged"].includes(event.state)) return false;
        if (event.dispatchClaim) {
            if (event.dispatchClaim.claimedBy === hostId) return true;
            const [prefix, pidText, token] = event.dispatchClaim.claimedBy.split(":");
            let dead = closedHosts.has(event.dispatchClaim.claimedBy);
            if (prefix === "assignment" && !dead) {
                try { process.kill(Number(pidText), 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
                const current = processStartToken(Number(pidText));
                if (current && token !== "unknown" && encodeURIComponent(current) !== token) dead = true;
            }
            if (!dead) return false;
            store.releaseOutbox({ eventId: event.eventId, claimToken: event.dispatchClaim.token, reason: "prior outcome delivery host exited" });
        }
        return store.claimOutbox({ type: "assignment-outcome", eventId: outcome.eventId, recipient: outcome.recipient, claimToken: `outcome_${randomUUID()}`, claimedBy: hostId, limit: 1 }).length === 1;
    });
}
export interface AssignmentBinding { version: 1; assignmentId: string; owner: OwnerIdentity; recipient: OwnerIdentity }
export function coordinatorPath(): string {
    return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "operation-coordinator.sqlite");
}
function withStore<T>(body: (store: ReturnType<typeof openStore>) => T): T {
    const store = openStore({ path: coordinatorPath() });
    try { return body(store); } finally { store.close(); }
}
export function registerAssignmentAttempt(binding: AssignmentBinding, attemptId: string): void {
    if (binding.version !== ASSIGNMENT_OUTCOMES_VERSION) throw new Error("Unsupported assignment outcome capability.");
    withStore((store) => store.registerAssignment({ ...binding, attemptId }));
}
/** Called before any completion handoff, including callback:false and inactive parents. */
export function commitAssignmentTerminal(meta: RunMeta): AssignmentOutcomeRecord | null {
    const binding = meta.assignment;
    if (!binding) return null;
    return withStore((store) => {
        const existing = store.getAssignmentOutcome(binding.assignmentId);
        if (existing) return existing;
        if (!["failed", "completed", "killed", "lost"].includes(meta.status) || (meta.status === "completed" && meta.park)) return null;
        const waits = store.listWaits({ owner: binding.owner }).filter((w) => w.origin?.assignmentRef === binding.assignmentId);
        // A coherent attempt exit does not establish interpretation or completion.
        if (meta.status === "completed" && waits.some((w) => !w.acknowledgement)) return null;
        return store.recordAssignmentOutcome({ ...binding, revision: 1,
            outcome: meta.status === "completed" ? "succeeded" : meta.status === "killed" ? "cancelled" : "failed",
            reason: meta.failureReason || (meta.status === "completed" ? "Assigned work and required interpretation are complete." : `Assignment ended ${meta.status}; retained attempt evidence is available.`),
            processUncertain: meta.status === "lost" || typeof meta.exitCode !== "number"
                || waits.some((w) => w.dependencies.some((d) => d.terminalRevision === 0)
                    || store.listResumeClaims({ waitId: w.waitId, generation: w.generation, state: "published" }).length > 0),
            evidence: [{ kind: "log", ref: meta.logPath, summary: `Attempt ${meta.id}: ${meta.status}` }],
            waits: waits.map((w) => ({ waitId: w.waitId, generation: w.generation, cancelEpoch: w.cancelEpoch })),
        });
    });
}
export function readOutcome(meta: RunMeta): AssignmentOutcomeRecord | null {
    return meta.assignment ? withStore((store) => store.getAssignmentOutcome(meta.assignment!.assignmentId)) : null;
}
export function assignmentRetainsEvidence(meta: RunMeta): boolean {
    if (!meta.assignment) return false;
    return withStore((store) => {
        const outcome = store.getAssignmentOutcome(meta.assignment!.assignmentId);
        if (!outcome) return false;
        if (!outcome.disposition) return true;
        const waits = store.listWaits({ owner: outcome.owner }).filter((w) => w.origin?.assignmentRef === outcome.assignmentId);
        return waits.some((w) => store.listResumeClaims({ waitId: w.waitId, generation: w.generation, state: "published" }).length > 0);
    });
}
export function receiptOutcome(meta: RunMeta, entryId: string): void {
    const record = readOutcome(meta);
    if (record) withStore((store) => store.receiptAssignmentOutcome({ assignmentId: record.assignmentId, recipient: record.recipient, revision: record.revision, entryId }));
}
export function outcomeTranscriptReceipt(entries: readonly unknown[], eventId: string): string | null {
    for (const raw of entries) {
        const entry = raw as { id?: string; type?: string; message?: { role?: string; customType?: string; details?: { completionEventIds?: unknown } } };
        if (entry.type !== "message" || entry.message?.role !== "custom" || entry.message.customType !== "background-completion-batch") continue;
        const ids = entry.message.details?.completionEventIds;
        if (Array.isArray(ids) && ids.includes(eventId)) return entry.id ?? eventId;
    }
    return null;
}
function under(path: string, root: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function inspectOutcome(meta: RunMeta, input: { recipient: OwnerIdentity; branchIds?: readonly string[]; permissions?: PermissionSnapshot; operationId?: string; revision?: number; disposition?: "consumed" | "dismissed"; note?: string }) {
    if (input.disposition && !Number.isInteger(input.revision)) throw new Error("Outcome disposition requires the exact outcome_revision.");
    if (!meta.assignment) throw new Error("This run has no durable assignment outcome capability.");
    return withStore((store) => {
        const outcome = store.getAssignmentOutcome(meta.assignment!.assignmentId);
        if (!outcome || outcome.recipient.sessionId !== input.recipient.sessionId || outcome.recipient.workspace !== input.recipient.workspace
            || (outcome.recipient.branchId && outcome.recipient.branchId !== input.recipient.branchId && !input.branchIds?.includes(outcome.recipient.branchId))) throw new Error("Outcome belongs to a different parent session or branch.");
        const policy = input.permissions?.permissions;
        if (meta.operations?.policy.sandbox && !policy) throw new Error("Current mandatory read authority is unavailable.");
        const readable = (path: string): string => {
            const real = realpathSync(path);
            if (credentialFilePaths(homedir()).some((p) => {
                try { return under(real, realpathSync(p)); } catch { return under(real, p); }
            })) throw new Error("Credential evidence access is refused.");
            const access = under(real, realpathSync(input.recipient.workspace)) ? policy?.projectFiles : policy?.outsideProject;
            if (policy?.enabled && access !== "read" && access !== "read-write") throw new Error("Current file read permission refuses this evidence.");
            return real;
        };
        const waits = store.listWaits({ owner: outcome.owner }).filter((w) => w.origin?.assignmentRef === outcome.assignmentId);
        let logs: Array<{ ref: string; text: string }> = [];
        if (input.operationId) {
            if (!waits.some((w) => w.dependencies.some((d) => d.operationId === input.operationId))) throw new Error("Operation is not an assignment dependency.");
            logs = store.listOperationEvidence(input.operationId).filter((e) => e.kind === "log").slice(0, 2).map((e) => {
                if (!isAbsolute(e.ref)) throw new Error("Legacy dependency log has no verified absolute path; inspect its retained summary instead.");
                const fd = openSync(readable(e.ref), constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const size = fstatSync(fd).size;
                    const bytes = Buffer.alloc(Math.min(size, 4096));
                    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
                    return { ref: e.ref, text: bytes.subarray(0, count).toString("utf8") };
                } finally { closeSync(fd); }
            });
        }
        // Check retained references before recording an inspection, never a worker read.
        const unavailableEvidence: string[] = [];
        for (const pin of [...outcome.evidence, ...store.listEvidencePins({ waitId: outcome.eventId, generation: 1 })]) {
            if ((pin.kind === "log" || pin.kind === "artifact") && isAbsolute(pin.ref)) {
                try { readable(pin.ref); } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    unavailableEvidence.push(pin.ref);
                }
            }
        }
        const request = { assignmentId: outcome.assignmentId, recipient: outcome.recipient, revision: input.revision ?? outcome.revision };
        const record = input.disposition
            ? store.consumeAssignmentOutcome({ ...request, disposition: input.disposition, note: input.note ?? "" })
            : store.inspectAssignmentOutcome(request);
        return { outcome: record, unavailableEvidence, dependencies: waits.slice(0, 20).map((w) => ({ waitId: w.waitId, generation: w.generation, phase: w.phase, acknowledgement: w.acknowledgement, dependencies: w.dependencies.slice(0, 20) })), logs };
    });
}
