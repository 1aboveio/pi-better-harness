import { createRequire } from "node:module";

/** Read-only, bounded projection input. Never creates/migrates a database. */
export function readAssignmentWaits(path, owner, connection) {
    let db;
    try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        db = connection ?? new DatabaseSync(path, { readOnly: true });
        // v4 adds repair accounting; the observed wait/outcome fields are unchanged.
        if (!["1", "2", "3", "4"].includes(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value)) {
            return { verified: false, waits: [], reason: "Unsupported coordinator schema; assignment state is unverified." };
        }
        const rows = db.prepare(`SELECT wait_id, generation, phase, phase_reason,
            acknowledgement_json, cancel_epoch FROM waits
            WHERE owner_kind = 'worker-conversation' AND owner_session_id = ? AND owner_workspace = ?
            ${owner.assignmentId ? "AND json_extract(origin_json, '$.assignmentRef') = ?" : `AND (
                EXISTS (SELECT 1 FROM json_each(?) AS attempt
                    WHERE attempt.value = json_extract(waits.origin_json, '$.attemptId')
                       OR attempt.value = json_extract(waits.park_json, '$.attemptId'))
                OR EXISTS (SELECT 1 FROM resume_claims AS claim, json_each(?) AS attempt
                    WHERE claim.wait_id = waits.wait_id AND claim.generation = waits.generation
                      AND claim.attempt_id = attempt.value)
                OR EXISTS (SELECT 1 FROM json_each(?) AS ref
                    WHERE json_extract(ref.value, '$.waitId') = waits.wait_id
                      AND json_extract(ref.value, '$.generation') = waits.generation)
            )`}
            ORDER BY created_at DESC, generation DESC LIMIT 100`).all(owner.sessionId, owner.workspace,
                ...(owner.assignmentId ? [owner.assignmentId] : [JSON.stringify(owner.attemptIds ?? []), JSON.stringify(owner.attemptIds ?? []), JSON.stringify(owner.waitRefs ?? [])]));
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
        if (!connection) db?.close();
    }
}

/** A root read model owns this connection; ordinary observers remain one-shot. */
export function createAssignmentReader(path) {
    let db;
    let identity;
    const statements = new Map();
    return {
        revision() {
            const { statSync } = createRequire(import.meta.url)("node:fs");
            const stat = statSync(path, { bigint: true });
            const next = `${stat.dev}:${stat.ino}`;
            if (identity !== next) {
                db?.close();
                db = undefined;
                statements.clear();
                identity = next;
            }
            const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
            db ??= new DatabaseSync(path, { readOnly: true });
            return `${identity}:${db.prepare("PRAGMA data_version").get().data_version}`;
        },
        read(owner) {
            try {
                this.revision();
                return readAssignmentWaits(path, owner, { prepare(sql) {
                    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
                    return statements.get(sql);
                } });
            } catch {
                return { verified: false, waits: [], reason: "Coordinator state is unverified; compatible supervision is unavailable." };
            }
        },
        close() { db?.close(); db = undefined; statements.clear(); identity = undefined; },
    };
}
