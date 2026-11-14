// Generated from packages/pi-better-subagents/assignment-projection.mjs. Do not edit directly.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAssignmentWaits } from "./shared-assignment-observation.mjs";

export const ASSIGNMENT_STATES = ["running", "waiting", "completed", "failed", "cancelled"];

/** A projection revision is a content-addressed semantic token, not a clock. */
export function projectAssignment(meta, processStatus, observation = { verified: true, waits: [] }) {
    const waits = observation.waits;
    const pending = waits.find((wait) => !["consumed", "cancelled"].includes(wait.phase));
    let state;
    let reason;
    if (observation.outcome) {
        state = { succeeded: "completed", failed: "failed", cancelled: "cancelled" }[observation.outcome.outcome];
        reason = observation.outcome.reason;
    } else if (waits[0]?.phase === "cancelled") {
        state = "cancelled";
        reason = waits[0]?.reason || "Assignment explicitly cancelled.";
    } else if (!observation.verified && (meta.operations || meta.park)) {
        state = "waiting";
        reason = observation.reason;
    } else if (pending) {
        state = "waiting";
        reason = pending.reason || (pending.phase === "ready" || pending.phase === "resuming"
            ? "Dependency evidence awaits worker interpretation."
            : "Waiting for dependencies and supervised continuation.");
    } else if (meta.status === "killed") {
        state = "cancelled";
        reason = "Assignment explicitly cancelled.";
    } else if (processStatus === "running") {
        state = "running";
        reason = "Worker is advancing the assignment.";
    } else if (meta.status === "failed") {
        state = "failed";
        reason = meta.failureReason || "Worker execution failed; retained evidence is available.";
    } else if (meta.status === "completed" && !String(meta.lifecycleClassification ?? "").startsWith("incomplete") && (!meta.park || waits.some((wait) =>
        wait.acknowledgement?.disposition === "assignment-complete"))) {
        state = "completed";
        reason = "Assigned work and required interpretation are complete.";
    } else {
        state = "waiting";
        reason = meta.park && waits.some((wait) => wait.phase === "consumed")
            ? "Dependency interpretation recorded; assignment completion is not yet proven."
            : "Execution outcome is unverified; supervised reconciliation is required.";
    }
    reason = String(reason ?? "Assignment state is unverified.").slice(0, 512);
    const evidence = waits.slice(0, 8).map((wait) => `wait:${wait.waitId}:${wait.generation}`);
    evidence.push(`run:${meta.id}:output.log`, `run:${meta.id}:meta.json`);
    const revision = createHash("sha256").update(JSON.stringify([meta.rootRunId ?? meta.id, meta.id, state, reason, evidence])).digest("hex").slice(0, 16);
    return { state, reason, revision, attemptId: meta.id, processStatus,
        termination: !["running", "orphaned", "lost", "exited"].includes(processStatus)
            && (typeof meta.exitCode === "number" || meta.signal) ? "attempt exit recorded" : "unproven",
        evidence, verified: observation.verified };
}

/** All consumers use the same lineage and authoritative wait read. Park caches are hints only. */
export function assignmentFor(meta, processStatus = meta.status, options = {}) {
    return createAssignmentProjector(options)(meta, processStatus);
}

function readAttempt(base, id) {
    try {
        const candidate = JSON.parse(readFileSync(join(base, "runs", id, "meta.json"), "utf8"));
        return candidate && typeof candidate === "object" ? candidate : undefined;
    } catch { /* A partial unrelated record must not hide a continuation. */ }
}

const attemptIndexes = new Map();
const UNCOMMITTED_RETRY_MS = 1_000;
const conversationKey = (sessionId, cwd) => JSON.stringify([sessionId, cwd]);

function removeIdentity(index, id) {
    const key = index.identities.get(id);
    if (key === undefined) return;
    index.identities.delete(id);
    const group = index.byConversation.get(key);
    group.delete(id);
    if (!group.size) index.byConversation.delete(key);
}

function setIdentity(index, id, candidate) {
    const key = conversationKey(candidate.sessionId, candidate.cwd);
    if (index.identities.get(id) === key) return;
    removeIdentity(index, id);
    index.identities.set(id, key);
    let group = index.byConversation.get(key);
    if (!group) index.byConversation.set(key, group = new Set());
    group.add(id);
}

function runsSignature(base) {
    try {
        const stat = statSync(join(base, "runs"), { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { return undefined; }
}

function prepareAttemptIndex(options) {
    const base = options.baseDir ?? join(tmpdir(), "pi-better-subagents");
    const signature = runsSignature(base);
    if (!signature) {
        attemptIndexes.delete(base);
        return { index: { base, byConversation: new Map() } };
    }
    let index = attemptIndexes.get(base);
    let initialAttempts;
    if (!index) {
        let ids;
        try { ids = new Set(readdirSync(join(base, "runs"))); }
        catch { return { index: { base, byConversation: new Map() } }; }
        index = { base, signature, ids, identities: new Map(), byConversation: new Map(),
            uncommitted: new Set(), nextRetryAt: Date.now() + UNCOMMITTED_RETRY_MS };
        initialAttempts = new Map();
        for (const id of ids) {
            const candidate = readAttempt(base, id);
            if (candidate) {
                setIdentity(index, id, candidate);
                initialAttempts.set(id, candidate);
            }
            else index.uncommitted.add(id);
        }
        attemptIndexes.set(base, index);
        if (attemptIndexes.size > 8) attemptIndexes.delete(attemptIndexes.keys().next().value);
    } else if (index.signature !== signature) {
        let ids;
        try { ids = new Set(readdirSync(join(base, "runs"))); }
        catch {
            attemptIndexes.delete(base);
            return { index: { base, byConversation: new Map() } };
        }
        for (const id of index.ids) {
            if (ids.has(id)) continue;
            removeIdentity(index, id);
            index.uncommitted.delete(id);
        }
        for (const id of ids) {
            if (index.ids.has(id)) continue;
            const candidate = readAttempt(base, id);
            if (candidate) setIdentity(index, id, candidate);
            else index.uncommitted.add(id);
        }
        index.ids = ids;
        index.signature = signature;
    }
    if (Date.now() >= index.nextRetryAt) {
        for (const id of index.uncommitted) {
            const candidate = readAttempt(base, id);
            if (!candidate) continue;
            setIdentity(index, id, candidate);
            index.uncommitted.delete(id);
        }
        index.nextRetryAt = Date.now() + UNCOMMITTED_RETRY_MS;
    }
    return { index, initialAttempts };
}

function readConversationAttempts(index, meta, initialAttempts) {
    const matches = [];
    for (const id of index.byConversation.get(conversationKey(meta.sessionId, meta.cwd)) ?? []) {
        const fresh = initialAttempts?.get(id) ?? readAttempt(index.base, id);
        if (!fresh) {
            removeIdentity(index, id);
            index.uncommitted.add(id);
            continue;
        }
        setIdentity(index, id, fresh);
        if (fresh.sessionId === meta.sessionId && fresh.cwd === meta.cwd) matches.push(fresh);
    }
    return matches;
}

/** One synchronous UI refresh shares a snapshot; the next refresh reads disk again. */
export function createAssignmentProjector(options = {}) {
    let prepared;
    const snapshots = new Map();
    const readSnapshot = (meta) => {
        const key = conversationKey(meta.sessionId, meta.cwd);
        if (!snapshots.has(key)) {
            prepared ??= prepareAttemptIndex(options);
            snapshots.set(key, readConversationAttempts(prepared.index, meta, prepared.initialAttempts));
        }
        return snapshots.get(key);
    };
    return (meta, processStatus = meta.status) => assignmentFromSnapshot(meta, processStatus, options,
        () => readSnapshot(meta));
}

function assignmentFromSnapshot(meta, processStatus, options, readSnapshot) {
    const attempts = new Map([[meta.id, meta]]);
    let current = meta;
    if (meta.operations || meta.park) {
        for (const candidate of readSnapshot()) {
            if (candidate.sessionId === meta.sessionId && candidate.cwd === meta.cwd
                && (!meta.assignment || candidate.assignment?.assignmentId === meta.assignment.assignmentId)) attempts.set(candidate.id, candidate);
        }
    }
    // Conversation roots survive explicit follow-ups. Only automatic resume edges
    // join attempts into one assignment; manual continuation starts a new one.
    const lineage = new Map([[meta.id, meta]]);
    let ancestor = meta;
    while (ancestor.operations?.resumeLaunchToken && attempts.has(ancestor.resumedFrom) && !lineage.has(ancestor.resumedFrom)) {
        ancestor = attempts.get(ancestor.resumedFrom);
        lineage.set(ancestor.id, ancestor);
    }
    let added;
    do {
        added = false;
        for (const candidate of attempts.values()) {
            if (candidate.operations?.resumeLaunchToken && lineage.has(candidate.resumedFrom) && !lineage.has(candidate.id)) {
                lineage.set(candidate.id, candidate);
                added = true;
            }
        }
    } while (added);
    for (const candidate of lineage.values()) {
        if (candidate.startedAt > current.startedAt) current = candidate;
    }
    const status = current.id === meta.id ? processStatus : current.status;
    const sessionId = current.operations?.conversationId ?? current.sessionId;
    const observation = options.observation ?? (sessionId && (current.assignment || current.operations || current.park)
        ? readAssignmentWaits(options.coordinatorPath ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "operation-coordinator.sqlite"),
            { sessionId, workspace: current.operations?.workspace ?? current.cwd,
                ...(current.assignment ? { assignmentId: current.assignment.assignmentId } : {}),
                attemptIds: [...lineage.keys()], waitRefs: [...lineage.values()].flatMap((attempt) =>
                    attempt.park?.waitId && Number.isSafeInteger(attempt.park.generation)
                        ? [{ waitId: attempt.park.waitId, generation: attempt.park.generation }] : []) })
        : current.park ? { verified: false, waits: [], reason: "Coordinator identity is unavailable; assignment state is unverified." }
            : { verified: true, waits: [] });
    return projectAssignment(current, status, observation);
}

export function assignmentDiagnostic(assignment) {
    return `Assignment ${assignment.state} r${assignment.revision}: ${assignment.reason} Process ${assignment.processStatus}; termination ${assignment.termination}. Evidence: ${assignment.evidence.join(", ")}`;
}
