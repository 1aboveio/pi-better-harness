import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAssignmentWaits } from "./shared-operation-coordinator/assignment-observation.mjs";

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
    return assignmentFromSnapshot(meta, processStatus, options, () => readAttempts(options));
}

function readAttempts(options) {
    const base = options.baseDir ?? join(tmpdir(), "pi-better-subagents");
    const attempts = [];
    try {
        for (const id of readdirSync(join(base, "runs"))) {
            try {
                const candidate = JSON.parse(readFileSync(join(base, "runs", id, "meta.json"), "utf8"));
                if (candidate && typeof candidate === "object") attempts.push(candidate);
            }
            catch { /* A partial unrelated record must not hide a continuation. */ }
        }
    } catch { /* Registry gaps cannot establish a newer attempt. */ }
    return attempts;
}

/** One synchronous UI refresh shares a snapshot; the next refresh reads disk again. */
export function createAssignmentProjector(options = {}) {
    let snapshot;
    const readSnapshot = (meta) => {
        if (!snapshot) {
            snapshot = new Map();
            for (const candidate of readAttempts(options)) {
                let workspaces = snapshot.get(candidate.sessionId);
                if (!workspaces) snapshot.set(candidate.sessionId, workspaces = new Map());
                let attempts = workspaces.get(candidate.cwd);
                if (!attempts) workspaces.set(candidate.cwd, attempts = []);
                attempts.push(candidate);
            }
        }
        return snapshot.get(meta.sessionId)?.get(meta.cwd) ?? [];
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
