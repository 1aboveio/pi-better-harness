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
            CREATE INDEX IF NOT EXISTS waits_assignment_observation ON waits
                (owner_kind,owner_session_id,owner_workspace,json_extract(origin_json,'$.assignmentRef'),created_at DESC,generation DESC);
            CREATE INDEX IF NOT EXISTS resume_claims_wait_observation ON resume_claims(wait_id,generation,attempt_id);
            CREATE TABLE IF NOT EXISTS background_input_versions (
                operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
            CREATE TRIGGER IF NOT EXISTS assignment_changes_retention AFTER INSERT ON assignment_changes
            BEGIN DELETE FROM assignment_changes WHERE seq <= NEW.seq - 4096; END;`);
        // Repair is an operation-ID keyset, not an observer equality lookup.
        // A leading observer column competes with the ordered recent-terminal index.
        if (ctx.db.prepare("PRAGMA index_info(background_operation_repair)").all().length > 1)
            ctx.db.exec("DROP INDEX background_operation_repair");
        ctx.db.exec("CREATE INDEX IF NOT EXISTS background_operation_repair ON operations(operation_id) WHERE observer_kind='local-supervisor'");
        const sources = [
            { table: "waits", select: (r) => `SELECT 'wait', ${r}.wait_id || ':' || ${r}.generation, json_extract(${r}.origin_json,'$.assignmentRef'), ${r}.owner_session_id, ${r}.owner_workspace WHERE ${r}.owner_kind='worker-conversation'` },
            { table: "resume_claims", select: (r) => `SELECT 'claim', ${r}.claim_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
            { table: "assignment_bindings", select: (r) => `SELECT 'binding', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.owner_json,'$.sessionId'), json_extract(${r}.owner_json,'$.workspace')` },
            { table: "assignment_attempts", select: (r) => `SELECT 'attempt', ${r}.attempt_id, b.assignment_id, json_extract(b.owner_json,'$.sessionId'), json_extract(b.owner_json,'$.workspace') FROM assignment_bindings b WHERE b.assignment_id=${r}.assignment_id` },
            { table: "assignment_outcomes", select: (r) => `SELECT 'outcome', ${r}.assignment_id, ${r}.assignment_id, json_extract(${r}.record_json,'$.owner.sessionId'), json_extract(${r}.record_json,'$.owner.workspace')` },
            { table: "outbox_events", select: (r) => `SELECT 'receipt', ${r}.event_id, b.assignment_id, json_extract(b.owner_json,'$.sessionId'), json_extract(b.owner_json,'$.workspace') FROM assignment_bindings b WHERE b.assignment_id=${r}.operation_id UNION ALL SELECT 'receipt', ${r}.event_id, json_extract(w.origin_json,'$.assignmentRef'), w.owner_session_id, w.owner_workspace FROM waits w WHERE w.wait_id=${r}.wait_id AND w.generation=${r}.generation AND w.owner_kind='worker-conversation'` },
        ];
        for (const { table, select } of sources)
            for (const action of ["INSERT", "UPDATE", "DELETE"]) {
                const records = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
                ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS assignment_change_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${records.map(r => `INSERT INTO assignment_changes(entity,entity_id,assignment_id,session_id,workspace) ${select(r)};`).join(" ")} END;`);
            }
        // An idle scan may span several pages. Insertions and authority transfers can
        // put a new candidate behind its cursor; deleting completed work cannot.
        const advanceCleanup = `INSERT INTO coordinator_state VALUES ('server-assignment-cleanup-revision', '1')
            ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;`;
        ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS server_cleanup_added AFTER INSERT ON assignment_cleanup_pending
            WHEN NEW.supervision_host_id GLOB 'server:*' BEGIN ${advanceCleanup} END;
            CREATE TRIGGER IF NOT EXISTS server_cleanup_transferred AFTER UPDATE OF supervision_host_id ON assignment_cleanup_pending
            WHEN NEW.supervision_host_id GLOB 'server:*' AND NEW.supervision_host_id IS NOT OLD.supervision_host_id
            BEGIN ${advanceCleanup} END;`);
        // The result grant can arrive after the assignment already ended.
        for (const event of ["INSERT", "UPDATE"])
            ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS server_cleanup_grant_${event}
            AFTER ${event} ON coordinator_state WHEN NEW.key GLOB 'result-supervision-v1:*' AND EXISTS (
                SELECT 1 FROM assignment_cleanup_pending WHERE operation_id=substr(NEW.key,length('result-supervision-v1:')+1)
                AND supervision_host_id GLOB 'server:*') BEGIN ${advanceCleanup} END`);
        // A foreground polls the branch views of one parent. Keep their durable
        // recovery revision even after older entries roll out of the change journal.
        ctx.db.exec(`CREATE TABLE IF NOT EXISTS background_recovery_scopes (
            workspace TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
            PRIMARY KEY(workspace,session_id)) WITHOUT ROWID`);
        const recoverySources = [
            ["operation_added", "INSERT ON operations", "NEW.owner_kind='parent-session'", "NEW.owner_workspace", "NEW.owner_session_id"],
            ["operation_changed", "UPDATE OF terminal_revision, supervision_host_id ON operations",
                "NEW.owner_kind='parent-session' AND (NEW.terminal_revision<>OLD.terminal_revision OR NEW.supervision_host_id IS NOT OLD.supervision_host_id)", "NEW.owner_workspace", "NEW.owner_session_id"],
            ["callback_added", "INSERT ON background_parent_callbacks", "1", "NEW.owner_workspace", "NEW.owner_session_id"],
            ["callback_removed", "DELETE ON background_parent_callbacks", "1", "OLD.owner_workspace", "OLD.owner_session_id"],
            ["delivery_added", "INSERT ON outbox_events", "NEW.event_type='dependency-ready' AND NEW.state='pending' AND NEW.recipient_kind='parent-session'", "NEW.recipient_workspace", "NEW.recipient_session_id"],
            ["delivery_released", "UPDATE OF state ON outbox_events", "NEW.event_type='dependency-ready' AND NEW.state='pending' AND OLD.state<>'pending' AND NEW.recipient_kind='parent-session'", "NEW.recipient_workspace", "NEW.recipient_session_id"],
        ];
        for (const [name, event, condition, workspace, session] of recoverySources) {
            ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS background_recovery_${name} AFTER ${event} WHEN ${condition}
                BEGIN INSERT INTO background_recovery_scopes VALUES(${workspace},${session},1)
                ON CONFLICT(workspace,session_id) DO UPDATE SET revision=revision+1; END`);
        }
        // These are observation inputs, not execution or delivery authority. Old
        // cooperative SQL writers inherit the same atomic invalidation triggers.
        const backgroundSources = [
            { table: "operations", select: (r) => `SELECT ${r}.operation_id, 1 WHERE ${r}.observer_kind='local-supervisor'` },
            { table: "waits", select: (r) => `SELECT d.operation_id, 1 FROM wait_dependencies d JOIN operations o ON o.operation_id=d.operation_id WHERE d.wait_id=${r}.wait_id AND d.generation=${r}.generation AND o.observer_kind='local-supervisor'` },
            { table: "wait_dependencies", select: (r) => `SELECT ${r}.operation_id, 1 WHERE EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=${r}.operation_id AND o.observer_kind='local-supervisor')` },
            { table: "background_parent_callbacks", select: (r) => `SELECT ${r}.operation_id, 1 WHERE 1` },
            { table: "coordinator_state", select: (r) => `SELECT o.operation_id, 1 FROM operations o WHERE ${r}.key LIKE 'result-supervision-v1:%' AND o.operation_id=substr(${r}.key,length('result-supervision-v1:')+1) AND o.observer_kind='local-supervisor'` },
        ];
        // Version 1 installed one-column SELECTs into a two-column INSERT. Replace
        // only these owned triggers, atomically, without resetting source positions.
        const replaceBackgroundTriggers = ctx.db.prepare("SELECT value FROM schema_meta WHERE key='background_input_triggers_version'").get()?.value !== "2";
        for (const { table, select } of backgroundSources)
            for (const action of ["INSERT", "UPDATE", "DELETE"]) {
                if (replaceBackgroundTriggers)
                    ctx.db.exec(`DROP TRIGGER IF EXISTS background_input_${table}_${action.toLowerCase()}`);
                const records = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
                ctx.db.exec(`CREATE TRIGGER IF NOT EXISTS background_input_${table}_${action.toLowerCase()}
                ${action === "DELETE" ? "BEFORE" : "AFTER"} ${action} ON ${table} BEGIN
                ${records.map(r => `INSERT INTO background_input_versions(operation_id,revision) ${select(r)}
                    ON CONFLICT(operation_id) DO UPDATE SET revision=revision+1;`).join(" ")}
                END;`);
            }
        if (replaceBackgroundTriggers)
            ctx.db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('background_input_triggers_version','2')").run();
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
