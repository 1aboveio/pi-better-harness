// Generated from packages/operation-coordinator/src/assignment-outcomes.ts. Do not edit directly.
import { createHash, randomUUID } from "node:crypto";
import { StoreError } from "./errors.ts";
import { columnText, getRow, getRows, run, type StoreContext } from "./sqlite.ts";
import { requireWait, readPins } from "./rows.ts";
import { releaseGenerationPins, voidGenerationOutbox } from "./outbox.ts";
import { normalizeOwner, requireId, requireText, sameOwner, requireCounter, requireEnum } from "./validate.ts";
import type { EvidenceRefInput, OwnerIdentity, WaitRef } from "./types.ts";

export interface AssignmentOutcomeInput {
    assignmentId: string;
    owner: OwnerIdentity;
    recipient: OwnerIdentity;
    revision: number;
    outcome: "succeeded" | "failed" | "cancelled";
    reason: string;
    evidence: EvidenceRefInput[];
    waits: Array<WaitRef & { generation: number; cancelEpoch: number }>;
    /** Reporting a terminal assignment never proves termination. */
    processUncertain: boolean;
}

export interface AssignmentOutcomeRecord extends AssignmentOutcomeInput {
    eventId: string;
    inspectedAt: number | null;
    disposition: { kind: "consumed" | "dismissed"; note: string; at: number } | null;
    deliveryReceipt: { entryId: string; at: number } | null;
}

export function registerAssignment(ctx: StoreContext, input: Pick<AssignmentOutcomeInput, "assignmentId" | "owner" | "recipient"> & { attemptId?: string }): void {
    const id = requireId("assignmentId", input.assignmentId);
    const owner = normalizeOwner("owner", input.owner);
    const recipient = normalizeOwner("recipient", input.recipient);
    if (owner.kind !== "worker-conversation" || recipient.kind !== "parent-session") throw new StoreError("foreign-owner", "Assignment needs a worker and recorded parent.");
    ctx.transaction(() => {
        const existing = getRow(ctx, "SELECT * FROM assignment_bindings WHERE assignment_id = ?", id);
        if (existing) {
            if (!sameOwner(JSON.parse(columnText(existing, "owner_json")), owner) || !sameOwner(JSON.parse(columnText(existing, "recipient_json")), recipient)) throw new StoreError("foreign-owner", "Assignment ownership and recipient are immutable.");
        } else {
            run(ctx, "INSERT INTO assignment_bindings VALUES (?, ?, ?)", id, JSON.stringify(owner), JSON.stringify(recipient));
        }
        if (input.attemptId) {
            const attemptId = requireId("attemptId", input.attemptId);
            const attempt = getRow(ctx, "SELECT assignment_id FROM assignment_attempts WHERE attempt_id = ?", attemptId);
            if (attempt && attempt.assignment_id !== id) throw new StoreError("foreign-owner", "Attempt belongs to another assignment.");
            if (!attempt && getAssignmentOutcome(ctx, id)) throw new StoreError("validation", "A terminal assignment cannot admit a new attempt.");
            run(ctx, "INSERT OR IGNORE INTO assignment_attempts VALUES (?, ?)", attemptId, id);
        }
    });
}

export function getAssignmentOutcome(ctx: StoreContext, assignmentId: string): AssignmentOutcomeRecord | null {
    const row = getRow(ctx, "SELECT record_json FROM assignment_outcomes WHERE assignment_id = ?", requireId("assignmentId", assignmentId));
    return row ? JSON.parse(columnText(row, "record_json")) as AssignmentOutcomeRecord : null;
}

function save(ctx: StoreContext, record: AssignmentOutcomeRecord): void {
    run(ctx, "UPDATE assignment_outcomes SET record_json = ? WHERE assignment_id = ?", JSON.stringify(record), record.assignmentId);
}

export function recordAssignmentOutcome(ctx: StoreContext, input: AssignmentOutcomeInput): AssignmentOutcomeRecord {
    const assignmentId = requireId("assignmentId", input.assignmentId);
    const owner = normalizeOwner("owner", input.owner);
    const recipient = normalizeOwner("recipient", input.recipient);
    if (owner.kind !== "worker-conversation" || recipient.kind !== "parent-session") {
        throw new StoreError("foreign-owner", "An assignment outcome needs its worker and recorded parent in the same workspace.");
    }
    const revision = requireCounter("revision", input.revision);
    if (revision < 1) throw new StoreError("validation", "Outcome revision must be positive.");
    const outcome = requireEnum("outcome", input.outcome, ["succeeded", "failed", "cancelled"] as const);
    const reason = requireText("reason", input.reason, 8192);
    if (typeof input.processUncertain !== "boolean" || !Array.isArray(input.evidence) || input.evidence.length > 100
        || !Array.isArray(input.waits) || input.waits.length > 100) throw new StoreError("validation", "Invalid outcome evidence or wait bounds.");
    const evidence = input.evidence.map((e) => ({
        kind: requireEnum("evidence.kind", e.kind, ["terminal-record", "log", "summary", "artifact"] as const),
        ref: requireText("evidence.ref", e.ref, 1024),
        ...(e.summary === undefined ? {} : { summary: requireText("evidence.summary", e.summary, 2048) }),
        detailLost: e.detailLost === true,
        ...(e.bytes === undefined ? {} : { bytes: requireCounter("evidence.bytes", e.bytes) }),
    }));
    const waits = input.waits.map((w) => ({ waitId: requireId("waitId", w.waitId), generation: requireCounter("generation", w.generation), cancelEpoch: requireCounter("cancelEpoch", w.cancelEpoch) }));
    const normalized = { assignmentId, owner, recipient, revision, outcome, reason, evidence, waits, processUncertain: input.processUncertain };
    return ctx.transaction(() => {
        const binding = getRow(ctx, "SELECT * FROM assignment_bindings WHERE assignment_id = ?", assignmentId);
        if (!binding || !sameOwner(JSON.parse(columnText(binding, "owner_json")), owner)
            || !sameOwner(JSON.parse(columnText(binding, "recipient_json")), recipient)) throw new StoreError("foreign-owner", "Outcome must match the assignment's captured worker and recipient.");
        const existing = getAssignmentOutcome(ctx, assignmentId);
        if (existing) {
            const { eventId: _event, inspectedAt: _read, disposition: _disposition, deliveryReceipt: _receipt, ...decision } = existing;
            if (JSON.stringify(decision) !== JSON.stringify(normalized)) throw new StoreError("validation", "A terminal assignment cannot be rewritten or reopened.");
            return existing;
        }
        const linked = waits.map((ref) => {
            const wait = requireWait(ctx, ref.waitId, ref.generation);
            if (!sameOwner(wait.owner, owner) || wait.origin?.assignmentRef !== assignmentId || wait.cancelEpoch !== ref.cancelEpoch) {
                throw new StoreError("foreign-owner", "Outcome wait relationship or cancellation epoch does not match the assignment.");
            }
            if (outcome === "succeeded" && wait.acknowledgement === null) throw new StoreError("wait-phase", "Success requires dependency interpretation.");
            return wait;
        });
        // Reject omission of a known assignment wait: every dispatch path must close.
        for (const row of getRows(ctx, "SELECT wait_id, generation FROM waits WHERE owner_kind = ? AND owner_session_id = ? AND owner_workspace = ? AND json_extract(origin_json, '$.assignmentRef') = ?", owner.kind, owner.sessionId, owner.workspace, assignmentId)) {
            if (!waits.some((w) => w.waitId === row.wait_id && w.generation === row.generation)) throw new StoreError("validation", "Outcome omitted an assignment wait.");
        }
        const eventId = `assignment_${createHash("sha256").update(assignmentId).digest("hex")}`;
        const record: AssignmentOutcomeRecord = { ...normalized, eventId, inspectedAt: null, disposition: null, deliveryReceipt: null };
        const at = ctx.now();
        run(ctx, "INSERT INTO assignment_outcomes VALUES (?, ?, ?)", assignmentId, eventId, JSON.stringify(record));
        const retained = evidence.map((e) => ({ ...e, operationId: assignmentId, terminalRevision: revision }));
        for (const wait of linked) {
            run(ctx, "INSERT INTO assignment_outcome_waits VALUES (?, ?, ?)", assignmentId, wait.waitId, wait.generation);
            retained.push(...readPins(ctx, wait.waitId, wait.generation, false).map((pin) => ({ operationId: pin.operationId, terminalRevision: pin.terminalRevision, kind: pin.kind, ref: pin.ref, summary: pin.summary ?? undefined, detailLost: pin.detailLost, bytes: pin.bytes ?? undefined })));
            releaseGenerationPins(ctx, wait.waitId, wait.generation, `transferred:${eventId}`, at);
            voidGenerationOutbox(ctx, wait.waitId, wait.generation, "assignment-terminal", at);
            if (!["consumed", "cancelled"].includes(wait.phase)) {
                run(ctx, "UPDATE waits SET dispatch_disarmed = 1, phase = 'held', phase_reason = ?, updated_at = ? WHERE wait_id = ? AND generation = ?", `assignment-terminal:${outcome}`, at, wait.waitId, wait.generation);
            }
            // A published claim may still own a writer. Keep its lease and launch identity.
            run(ctx, "UPDATE resume_claims SET state = 'invalidated', invalidated_at = ?, reason = 'assignment-terminal' WHERE wait_id = ? AND generation = ? AND state = 'claimed'", at, wait.waitId, wait.generation);
        }
        for (const e of retained) run(ctx, `INSERT OR IGNORE INTO evidence_pins (pin_id, wait_id, generation, operation_id, terminal_revision, kind, ref, summary, detail_lost, bytes, pinned_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, `pin_${randomUUID()}`, eventId, e.operationId, e.terminalRevision, e.kind, e.ref, e.summary ?? null, e.detailLost ? 1 : 0, e.bytes ?? null, at);
        run(ctx, `INSERT INTO outbox_events (event_id, event_type, operation_id, terminal_revision, wait_id, generation, recipient_kind, recipient_session_id, recipient_workspace, recipient_branch_id, recipient_goal_id, state, created_at) VALUES (?, 'assignment-outcome', ?, ?, ?, 1, ?, ?, ?, ?, ?, 'pending', ?)`, eventId, assignmentId, revision, eventId, recipient.kind, recipient.sessionId, recipient.workspace, recipient.branchId ?? null, recipient.goalId ?? null, at);
        return record;
    });
}

export function inspectAssignmentOutcome(ctx: StoreContext, input: { assignmentId: string; recipient: OwnerIdentity; revision: number }): AssignmentOutcomeRecord {
    return ctx.transaction(() => {
        const record = requireRecipient(ctx, input);
        record.inspectedAt ??= ctx.now();
        save(ctx, record);
        return record;
    });
}

/** Call after reconciling the stable event ID with the recipient's durable transcript. */
export function receiptAssignmentOutcome(ctx: StoreContext, input: { assignmentId: string; recipient: OwnerIdentity; revision: number; entryId: string }): AssignmentOutcomeRecord {
    const entryId = requireId("entryId", input.entryId);
    return ctx.transaction(() => {
        const record = requireRecipient(ctx, input);
        if (record.deliveryReceipt) return record;
        record.deliveryReceipt = { entryId, at: ctx.now() };
        save(ctx, record);
        run(ctx, "UPDATE outbox_events SET state = CASE WHEN state = 'acknowledged' THEN state ELSE 'delivered' END, delivered_at = ?, dispatch_claim_json = NULL WHERE event_id = ?", ctx.now(), record.eventId);
        return record;
    });
}

function requireRecipient(ctx: StoreContext, input: { assignmentId: string; recipient: OwnerIdentity; revision: number }): AssignmentOutcomeRecord {
    const record = getAssignmentOutcome(ctx, input.assignmentId);
    if (!record || !sameOwner(record.recipient, normalizeOwner("recipient", input.recipient))) throw new StoreError("foreign-owner", "Outcome belongs to a different parent.");
    if (record.revision !== input.revision) throw new StoreError("stale-evidence", "Outcome revision does not match.");
    return record;
}

export function consumeAssignmentOutcome(ctx: StoreContext, input: { assignmentId: string; recipient: OwnerIdentity; revision: number; disposition: "consumed" | "dismissed"; note: string }): AssignmentOutcomeRecord {
    const kind = requireEnum("disposition", input.disposition, ["consumed", "dismissed"] as const);
    const note = requireText("note", input.note, 8192);
    return ctx.transaction(() => {
        const record = requireRecipient(ctx, input);
        if (record.inspectedAt === null) throw new StoreError("stale-evidence", "Inspect the exact outcome before disposing it.");
        if (record.disposition) {
            if (record.disposition.kind !== kind || record.disposition.note !== note) throw new StoreError("validation", "Outcome disposition already recorded.");
            return record;
        }
        record.disposition = { kind, note, at: ctx.now() };
        save(ctx, record);
        releaseGenerationPins(ctx, record.eventId, 1, `outcome-${kind}`, ctx.now());
        run(ctx, "UPDATE outbox_events SET state = 'acknowledged', acknowledged_at = ?, dispatch_claim_json = NULL WHERE event_id = ?", ctx.now(), record.eventId);
        return record;
    });
}
