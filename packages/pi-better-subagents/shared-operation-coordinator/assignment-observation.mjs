// Generated from packages/operation-coordinator/assignment-observation.mjs. Do not edit directly.
import { createRequire } from "node:module";

/** Read-only, bounded projection input. Never creates/migrates a database. */
export function readAssignmentWaits(path, owner) {
    let db;
    try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        db = new DatabaseSync(path, { readOnly: true });
        if (!["1", "2", "3"].includes(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value)) {
            return { verified: false, waits: [], reason: "Unsupported coordinator schema; assignment state is unverified." };
        }
        const rows = db.prepare(`SELECT wait_id, generation, phase, phase_reason,
            acknowledgement_json, cancel_epoch FROM waits
            WHERE owner_kind = 'worker-conversation' AND owner_session_id = ? AND owner_workspace = ?
            ${owner.assignmentId ? "AND json_extract(origin_json, '$.assignmentRef') = ?" : ""}
            ORDER BY created_at DESC, generation DESC LIMIT 100`).all(owner.sessionId, owner.workspace, ...(owner.assignmentId ? [owner.assignmentId] : []));
        const record = owner.assignmentId ? db.prepare("SELECT record_json FROM assignment_outcomes WHERE assignment_id = ?").get(owner.assignmentId) : null;
        const outcome = record ? JSON.parse(record.record_json) : null;
        if (outcome && (outcome.owner.sessionId !== owner.sessionId || outcome.owner.workspace !== owner.workspace)) throw new Error("Foreign assignment outcome");
        return { verified: true, outcome, waits: rows.map((row) => ({
            waitId: row.wait_id, generation: row.generation, phase: row.phase,
            reason: row.phase_reason, cancelEpoch: row.cancel_epoch,
            acknowledgement: row.acknowledgement_json ? JSON.parse(row.acknowledgement_json) : null,
        })) };
    } catch {
        return { verified: false, waits: [], reason: "Coordinator state is unverified; compatible supervision is unavailable." };
    } finally {
        db?.close();
    }
}
