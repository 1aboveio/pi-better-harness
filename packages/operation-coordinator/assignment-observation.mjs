import { createRequire } from "node:module";

/** Read-only, bounded projection input. Never creates/migrates a database. */
export function readAssignmentWaits(path, owner) {
    let db;
    try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
        db = new DatabaseSync(path, { readOnly: true });
        if (!["1", "2"].includes(db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value)) {
            return { verified: false, waits: [], reason: "Unsupported coordinator schema; assignment state is unverified." };
        }
        const rows = db.prepare(`SELECT wait_id, generation, phase, phase_reason,
            acknowledgement_json, cancel_epoch FROM waits
            WHERE owner_kind = 'worker-conversation' AND owner_session_id = ? AND owner_workspace = ?
            ORDER BY created_at DESC, generation DESC LIMIT 100`).all(owner.sessionId, owner.workspace);
        return { verified: true, waits: rows.map((row) => ({
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
