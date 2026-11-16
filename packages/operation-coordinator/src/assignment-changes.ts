import type { StoreContext } from "./sqlite.ts";

/** Additive observation journal. Triggers also cover already-running old writers. */
export function ensureAssignmentChanges(ctx: StoreContext): void {
    ctx.transaction(() => {
        ctx.db.exec(`CREATE TABLE IF NOT EXISTS assignment_change_source (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL);
            INSERT OR IGNORE INTO assignment_change_source VALUES(1, lower(hex(randomblob(16))));
            CREATE TABLE IF NOT EXISTS assignment_changes (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '',
                assignment_id TEXT, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
                changed_at INTEGER NOT NULL DEFAULT (unixepoch()*1000));
            CREATE INDEX IF NOT EXISTS waits_assignment_observation ON waits
                (owner_kind,owner_session_id,owner_workspace,json_extract(origin_json,'$.assignmentRef'),created_at DESC,generation DESC);
            CREATE INDEX IF NOT EXISTS resume_claims_wait_observation ON resume_claims(wait_id,generation,attempt_id);
            CREATE TABLE IF NOT EXISTS background_input_versions (
                operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS background_operation_repair ON operations(observer_kind,operation_id);
            CREATE TRIGGER IF NOT EXISTS assignment_changes_retention AFTER INSERT ON assignment_changes
            BEGIN DELETE FROM assignment_changes WHERE seq <= NEW.seq - 4096; END;`);
        const sources = [
            { table: "waits", select: (r: string) => `SELECT 'wait', ${r}.wait_id || ':' || ${r}.generation, json_extract(${r}.origin_json,'$.assignmentRef'), ${r}.owner_session_id, ${r}.owner_workspace WHERE ${r}.owner_kind='worker-conversation'` },
            { table: "resume_claims", select: (r: string) => `SELECT 'claim', ${r}.claim_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
            { table: "assignment_bindings", select: (r: string) => `SELECT 'binding', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.owner_json,'$.sessionId'), json_extract(${r}.owner_json,'$.workspace')` },
            { table: "assignment_attempts", select: (r: string) => `SELECT 'attempt', ${r}.attempt_id, b.assignment_id, json_extract(b.owner_json,'$.sessionId'), json_extract(b.owner_json,'$.workspace') FROM assignment_bindings b WHERE b.assignment_id=${r}.assignment_id` },
            { table: "assignment_outcomes", select: (r: string) => `SELECT 'outcome', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.record_json,'$.owner.sessionId'), json_extract(${r}.record_json,'$.owner.workspace')` },
            { table: "outbox_events", select: (r: string) => `SELECT 'receipt', ${r}.event_id, b.assignment_id, json_extract(b.owner_json,'$.sessionId'), json_extract(b.owner_json,'$.workspace') FROM assignment_bindings b WHERE b.assignment_id=${r}.operation_id UNION ALL SELECT 'receipt', ${r}.event_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
        ];
        for (const { table, select } of sources) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            const records = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
            ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS assignment_change_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${records.map(r => `INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace) ${select(r)};`).join(" ")} END;`);
        }
        // These are observation inputs, not execution or delivery authority. Old
        // cooperative SQL writers inherit the same atomic invalidation triggers.
        const backgroundSources = [
            { table: "operations", select: (r: string) => `SELECT ${r}.operation_id WHERE ${r}.observer_kind='local-supervisor'` },
            { table: "waits", select: (r: string) => `SELECT d.operation_id FROM wait_dependencies d JOIN operations o ON o.operation_id=d.operation_id WHERE d.wait_id=${r}.wait_id AND d.generation=${r}.generation AND o.observer_kind='local-supervisor'` },
            { table: "wait_dependencies", select: (r: string) => `SELECT ${r}.operation_id WHERE EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=${r}.operation_id AND o.observer_kind='local-supervisor')` },
            { table: "background_parent_callbacks", select: (r: string) => `SELECT ${r}.operation_id WHERE 1` },
            { table: "coordinator_state", select: (r: string) => `SELECT o.operation_id FROM operations o WHERE ${r}.key LIKE 'result-supervision-v1:%' AND o.operation_id=substr(${r}.key,length('result-supervision-v1:')+1) AND o.observer_kind='local-supervisor'` },
        ];
        for (const { table, select } of backgroundSources) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            const records = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
            ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS background_input_${table}_${action.toLowerCase()}
                ${action === "DELETE" ? "BEFORE" : "AFTER"} ${action} ON ${table} BEGIN
                ${records.map(r => `INSERT INTO background_input_versions(operation_id,revision) ${select(r)}
                    ON CONFLICT(operation_id) DO UPDATE SET revision=revision+1;`).join(" ")}
                END;`);
        }
        ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS background_journal_insert AFTER INSERT ON background_input_versions BEGIN
            INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace)
            SELECT 'background:operation', NEW.operation_id, NEW.operation_id, owner_session_id, owner_workspace FROM operations WHERE operation_id=NEW.operation_id;
            END;
            CREATE TRIGGER IF NOT EXISTS background_journal_update AFTER UPDATE ON background_input_versions BEGIN
            INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace)
            SELECT 'background:operation', NEW.operation_id, NEW.operation_id, owner_session_id, owner_workspace FROM operations WHERE operation_id=NEW.operation_id;
            END;
            CREATE TRIGGER IF NOT EXISTS background_journal_previous_scope AFTER UPDATE ON operations
            WHEN OLD.observer_kind='local-supervisor' AND (OLD.owner_session_id<>NEW.owner_session_id OR OLD.owner_workspace<>NEW.owner_workspace OR OLD.owner_kind<>NEW.owner_kind)
            BEGIN INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace)
            VALUES('background:operation',OLD.operation_id,OLD.operation_id,OLD.owner_session_id,OLD.owner_workspace); END;`);
    });
}
