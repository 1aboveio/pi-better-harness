// Generated canonical coordinator. Do not edit directly.
/** Additive observation journal. Triggers also cover already-running old writers. */
export function ensureAssignmentChanges(ctx) {
    ctx.transaction(() => {
        ctx.db.exec(`CREATE TABLE IF NOT EXISTS assignment_change_source (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL);
            INSERT OR IGNORE INTO assignment_change_source VALUES(1, lower(hex(randomblob(16))));
            CREATE TABLE IF NOT EXISTS assignment_changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '',
                assignment_id TEXT, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
                changed_at INTEGER NOT NULL DEFAULT (unixepoch()*1000));
            CREATE TRIGGER IF NOT EXISTS assignment_changes_retention AFTER INSERT ON assignment_changes
            BEGIN DELETE FROM assignment_changes WHERE seq <= NEW.seq - 4096; END;`);
        const sources = [
            { table: "waits", select: (r) => `SELECT 'wait', ${r}.wait_id || ':' || ${r}.generation, json_extract(${r}.origin_json,'$.assignmentRef'), ${r}.owner_session_id, ${r}.owner_workspace WHERE ${r}.owner_kind='worker-conversation'` },
            { table: "resume_claims", select: (r) => `SELECT 'claim', ${r}.claim_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
            { table: "assignment_bindings", select: (r) => `SELECT 'binding', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.owner_json,'$.sessionId'), json_extract(${r}.owner_json,'$.workspace')` },
            { table: "assignment_outcomes", select: (r) => `SELECT 'outcome', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.record_json,'$.owner.sessionId'), json_extract(${r}.record_json,'$.owner.workspace')` },
            { table: "outbox_events", select: (r) => `SELECT 'receipt', ${r}.event_id, b.assignment_id, json_extract(b.owner_json,'$.sessionId'), json_extract(b.owner_json,'$.workspace') FROM assignment_bindings b WHERE b.assignment_id=${r}.operation_id UNION ALL SELECT 'receipt', ${r}.event_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
        ];
        for (const { table, select } of sources)
            for (const action of ["INSERT", "UPDATE", "DELETE"]) {
                const records = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
                ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS assignment_change_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${records.map(r => `INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace) ${select(r)};`).join(" ")} END;`);
            }
    });
}
