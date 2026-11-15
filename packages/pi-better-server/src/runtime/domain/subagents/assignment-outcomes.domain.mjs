// Generated fixed launch domain from packages/pi-better-subagents/assignment-outcomes.ts. Do not edit directly.
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, relative, isAbsolute, dirname, resolve } from "node:path";
import { openSync, closeSync, fstatSync, readSync, realpathSync, constants } from "node:fs";
import { openStore, ownerDiff, StoreError } from "./shared-operation-coordinator/index.domain.mjs";
import { processStartToken, readMeta } from "./registry.domain.mjs";
import { credentialFilePaths } from "./shared-sandbox-core.domain.mjs";
import { readAssignmentReport } from "./assignment-report.domain.mjs";
export const ASSIGNMENT_OUTCOMES_VERSION = 1;
const closedHosts = globalThis.__assignmentOutcomeClosedHosts ??= new Set();
export function createOutcomeHost() {
    return `assignment:${process.pid}:${encodeURIComponent(processStartToken(process.pid) ?? "unknown")}:${randomUUID()}`;
}
export function closeOutcomeHost(hostId) {
    closedHosts.add(hostId);
}
export function claimOutcome(meta, hostId) {
    const outcome = readOutcome(meta);
    if (!outcome)
        return false;
    return withStore((store) => {
        const event = store.listOutbox().find((e) => e.eventId === outcome.eventId);
        if (!event || ["delivered", "acknowledged"].includes(event.state))
            return false;
        if (event.dispatchClaim) {
            if (event.dispatchClaim.claimedBy === hostId)
                return true;
            const [prefix, pidText, token] = event.dispatchClaim.claimedBy.split(":");
            let dead = closedHosts.has(event.dispatchClaim.claimedBy);
            if (prefix === "assignment" && !dead) {
                try {
                    process.kill(Number(pidText), 0);
                }
                catch (error) {
                    dead = error.code === "ESRCH";
                }
                const current = processStartToken(Number(pidText));
                if (current && token !== "unknown" && encodeURIComponent(current) !== token)
                    dead = true;
            }
            if (!dead)
                return false;
            store.releaseOutbox({ eventId: event.eventId, claimToken: event.dispatchClaim.token, reason: "prior outcome delivery host exited" });
        }
        return store.claimOutbox({ type: "assignment-outcome", eventId: outcome.eventId, recipient: outcome.recipient, claimToken: `outcome_${randomUUID()}`, claimedBy: hostId, limit: 1 }).length === 1;
    });
}
export function coordinatorPath() {
    return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "operation-coordinator.sqlite");
}
function withStore(body) {
    const path = coordinatorPath();
    const borrowed = runtimeStores.get(canonicalRoot(dirname(path)));
    if (borrowed)
        return body(borrowed.store);
    const store = openStore({ path });
    try {
        return body(store);
    }
    finally {
        store.close();
    }
}
const runtimeStores = new Map();
function canonicalRoot(root) {
    try {
        return realpathSync(root);
    }
    catch {
        return resolve(root);
    }
}
/** Fixed runtime adapter borrows its mutation connection; it retains ownership. */
export function bindRuntimeOutcomeStore(root, store) {
    const key = canonicalRoot(root);
    let entry = runtimeStores.get(key);
    if (entry && entry.store !== store)
        throw new Error("Assignment runtime store already bound");
    if (!entry) {
        entry = { store, leases: 0 };
        runtimeStores.set(key, entry);
    }
    entry.leases++;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        if (--entry.leases === 0)
            runtimeStores.delete(key);
    };
}
export function registerAssignmentAttempt(binding, attemptId) {
    if (binding.version !== ASSIGNMENT_OUTCOMES_VERSION)
        throw new Error("Unsupported assignment outcome capability.");
    withStore((store) => store.registerAssignment({ ...binding, attemptId }));
}
/** Called before any completion handoff, including callback:false and inactive parents. */
export function commitAssignmentTerminal(meta, recoveryFailure = false) {
    const binding = meta.assignment;
    if (!binding)
        return null;
    return withStore((store) => {
        const existing = store.getAssignmentOutcome(binding.assignmentId);
        if (existing)
            return existing;
        if (!["failed", "completed", "killed", "lost"].includes(meta.status) || (meta.status === "completed" && meta.park))
            return null;
        const waits = store.listWaits({ owner: binding.owner }).filter((w) => w.origin?.assignmentRef === binding.assignmentId);
        // A published automatic attempt's exit belongs to bounded recovery first.
        if (!recoveryFailure && meta.status !== "killed" && meta.operations?.resumeLaunchToken && waits.some((w) => !w.acknowledgement && ["resuming", "ready"].includes(w.phase)))
            return null;
        // A coherent attempt exit does not establish interpretation or completion.
        if (meta.status === "completed" && waits.some((w) => !w.acknowledgement))
            return null;
        let report = null;
        let invalidReport = "";
        try {
            report = readAssignmentReport(meta);
        }
        catch {
            if (meta.status === "completed")
                invalidReport = "Assignment completion is unverified: retained report evidence is unavailable or changed.";
        }
        const complete = meta.status === "completed" && (report ? report.status === "complete"
            : !invalidReport && waits.some((w) => w.acknowledgement?.disposition === "assignment-complete"));
        try {
            return store.recordAssignmentOutcome({ ...binding, revision: 1,
                outcome: complete ? "succeeded" : meta.status === "killed" ? "cancelled" : "failed",
                reason: meta.failureReason || invalidReport || (meta.status === "completed" && report ? report.reason : complete ? "Assigned work and required interpretation are complete."
                    : meta.status === "completed" ? "Assignment completion is unverified: the attempt exited without an evidence-backed completion decision. Inspect retained output and continue unfinished work or report a concrete blocker."
                        : `Assignment ended ${meta.status}; retained attempt evidence is available.`),
                processUncertain: meta.status === "lost" || typeof meta.exitCode !== "number"
                    || waits.some((w) => w.dependencies.some((d) => d.terminalRevision === 0)
                        || store.listResumeClaims({ waitId: w.waitId, generation: w.generation, state: "published" }).length > 0),
                evidence: [{ kind: "log", ref: meta.logPath, summary: `Attempt ${meta.id}: ${meta.status}` },
                    ...(report ? [{ kind: "artifact", ref: meta.assignmentReport.path, summary: report.reason },
                        ...report.evidence.map((e) => ({ kind: "artifact", ref: e.path, summary: e.explanation }))] : [])],
                waits: waits.map((w) => ({ waitId: w.waitId, generation: w.generation, cancelEpoch: w.cancelEpoch })), });
        }
        catch (error) {
            // A competing finalizer may commit after our initial read. The store
            // still refuses rewrites; return only the same captured binding's winner.
            if (error instanceof StoreError && error.code === "validation" && error.message === "A terminal assignment cannot be rewritten or reopened.") {
                const winner = store.getAssignmentOutcome(binding.assignmentId);
                const current = readMeta(meta.id);
                if (winner && winner.assignmentId === binding.assignmentId && ownerDiff(winner.owner, binding.owner) === "none"
                    && ownerDiff(winner.recipient, binding.recipient) === "none"
                    && current?.assignment?.assignmentId === binding.assignmentId
                    && ownerDiff(current.assignment.owner, binding.owner) === "none" && ownerDiff(current.assignment.recipient, binding.recipient) === "none"
                    && current.sessionId === meta.sessionId && current.cwd === meta.cwd && current.pid === meta.pid && current.pidStartTime === meta.pidStartTime
                    && isDeepStrictEqual(current.management, meta.management)
                    && current.operations?.resumeLaunchToken === meta.operations?.resumeLaunchToken
                    && winner.evidence.some(evidence => evidence.kind === "log" && evidence.ref === meta.logPath))
                    return winner;
            }
            throw error;
        }
    });
}
export function readOutcome(meta) {
    return meta.assignment ? withStore((store) => store.getAssignmentOutcome(meta.assignment.assignmentId)) : null;
}
export function assignmentRetainsEvidence(meta) {
    if (!meta.assignment)
        return false;
    return withStore((store) => {
        const outcome = store.getAssignmentOutcome(meta.assignment.assignmentId);
        if (!outcome)
            return false;
        if (!outcome.disposition)
            return true;
        const waits = store.listWaits({ owner: outcome.owner }).filter((w) => w.origin?.assignmentRef === outcome.assignmentId);
        return waits.some((w) => store.listResumeClaims({ waitId: w.waitId, generation: w.generation, state: "published" }).length > 0);
    });
}
export function receiptOutcome(meta, entryId) {
    const record = readOutcome(meta);
    if (record)
        withStore((store) => store.receiptAssignmentOutcome({ assignmentId: record.assignmentId, recipient: record.recipient, revision: record.revision, entryId }));
}
export function outcomeTranscriptReceipt(entries, eventId) {
    for (const raw of entries) {
        const entry = raw;
        const message = entry.type === "custom_message" ? entry
            : entry.type === "message" && entry.message?.role === "custom" ? entry.message : null;
        if (message?.customType !== "background-completion-batch")
            continue;
        const ids = message.details?.completionEventIds;
        if (Array.isArray(ids) && ids.includes(eventId))
            return entry.id ?? eventId;
    }
    return null;
}
function under(path, root) {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function inspectOutcome(meta, input) {
    if (input.disposition && !Number.isInteger(input.revision))
        throw new Error("Outcome disposition requires the exact outcome_revision.");
    if (!meta.assignment)
        throw new Error("This run has no durable assignment outcome capability.");
    return withStore((store) => {
        const outcome = store.getAssignmentOutcome(meta.assignment.assignmentId);
        if (!outcome || outcome.recipient.sessionId !== input.recipient.sessionId || outcome.recipient.workspace !== input.recipient.workspace
            || (outcome.recipient.branchId && outcome.recipient.branchId !== input.recipient.branchId && !input.branchIds?.includes(outcome.recipient.branchId)))
            throw new Error("Outcome belongs to a different parent session or branch.");
        const policy = input.permissions?.permissions;
        if (meta.operations?.policy.sandbox && !policy)
            throw new Error("Current mandatory read authority is unavailable.");
        const readable = (path) => {
            const real = realpathSync(path);
            if (credentialFilePaths(homedir()).some((p) => {
                try {
                    return under(real, realpathSync(p));
                }
                catch {
                    return under(real, p);
                }
            }))
                throw new Error("Credential evidence access is refused.");
            const access = under(real, realpathSync(input.recipient.workspace)) ? policy?.projectFiles : policy?.outsideProject;
            if (policy?.enabled && access !== "read" && access !== "read-write")
                throw new Error("Current file read permission refuses this evidence.");
            return real;
        };
        const waits = store.listWaits({ owner: outcome.owner }).filter((w) => w.origin?.assignmentRef === outcome.assignmentId);
        let logs = [];
        if (input.operationId) {
            if (!waits.some((w) => w.dependencies.some((d) => d.operationId === input.operationId)))
                throw new Error("Operation is not an assignment dependency.");
            logs = store.listOperationEvidence(input.operationId).filter((e) => e.kind === "log").slice(0, 2).map((e) => {
                if (!isAbsolute(e.ref))
                    throw new Error("Legacy dependency log has no verified absolute path; inspect its retained summary instead.");
                const fd = openSync(readable(e.ref), constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const size = fstatSync(fd).size;
                    const bytes = Buffer.alloc(Math.min(size, 4096));
                    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
                    return { ref: e.ref, text: bytes.subarray(0, count).toString("utf8") };
                }
                finally {
                    closeSync(fd);
                }
            });
        }
        // Check retained references before recording an inspection, never a worker read.
        const unavailableEvidence = [];
        for (const pin of [...outcome.evidence, ...store.listEvidencePins({ waitId: outcome.eventId, generation: 1 })]) {
            if ((pin.kind === "log" || pin.kind === "artifact") && isAbsolute(pin.ref)) {
                try {
                    readable(pin.ref);
                }
                catch (error) {
                    if (error.code !== "ENOENT")
                        throw error;
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
