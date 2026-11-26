// Generated fixed launch domain from packages/pi-better-background-tasks/src/shared-operation-coordinator/src/schema.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/schema.ts. Do not edit directly.
/**
 * Schema v5 for the durable operation coordinator.
 *
 * The store refuses to open a database whose recorded version it does not
 * understand, and leaves the file untouched. An unreadable or newer database
 * disables the feature; it never deletes records to recover.
 *
 * Uniqueness constraints carry lifecycle invariants into the database itself:
 *
 * - one durable operation per background task id;
 * - one pending wait generation per owner identity (partial unique index);
 * - one active resume claim per wait generation (partial unique index);
 * - one outbox event per terminal revision per wait generation;
 * - one evidence pin per reference and one evidence read per revision.
 */
import { SCHEMA_VERSION } from "./types.domain.mjs";
import { StoreError } from "./errors.domain.mjs";
import { columnText, getRow, getRows, run } from "./sqlite.domain.mjs";
// Enforce the handoff even for an older process still using its bundled store.
// Unknown legacy scopes conservatively conflict with any managed root scope.
const RESULT_ADMISSION_FENCE = `CREATE TRIGGER IF NOT EXISTS result_scope_admission_v1
    BEFORE INSERT ON operations
    WHEN NEW.observer_kind = 'local-supervisor'
      AND COALESCE(json_extract(NEW.supervision_json, '$.resultAdapter'), 0) != 1
      AND EXISTS (SELECT 1 FROM coordinator_state
          WHERE key LIKE 'result-scope-v1:%'
            AND (json_extract(NEW.supervision_json, '$.resultScope') IS NULL
              OR key = 'result-scope-v1:' || json_extract(NEW.supervision_json, '$.resultScope')))
    BEGIN SELECT RAISE(ABORT, 'permission-unavailable: legacy launch into managed result scope'); END`;
const BACKGROUND_CALLBACK_DDL = [
    `CREATE TABLE IF NOT EXISTS background_parent_callbacks (
        operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
        owner_kind TEXT NOT NULL CHECK(owner_kind='parent-session'),
        owner_workspace TEXT NOT NULL,
        owner_session_id TEXT NOT NULL
    )`,
    `CREATE TRIGGER IF NOT EXISTS background_parent_callback_registration
        AFTER INSERT ON operations
        WHEN NEW.owner_kind='parent-session' AND NEW.observer_kind='local-supervisor'
        BEGIN INSERT OR IGNORE INTO background_parent_callbacks(operation_id,owner_kind,owner_workspace,owner_session_id)
            VALUES(NEW.operation_id,NEW.owner_kind,NEW.owner_workspace,NEW.owner_session_id); END`,
    `CREATE INDEX IF NOT EXISTS background_parent_callbacks_owner ON background_parent_callbacks(owner_kind,owner_workspace,owner_session_id,operation_id)`,
    `CREATE INDEX IF NOT EXISTS operations_background_recent ON operations(terminal_at,operation_id) WHERE observer_kind='local-supervisor' AND terminal_revision>0`,
    `CREATE INDEX IF NOT EXISTS operations_background_owner_recent ON operations(owner_kind,owner_workspace,owner_session_id,terminal_at,operation_id) WHERE observer_kind='local-supervisor' AND terminal_revision>0`,
    `CREATE INDEX IF NOT EXISTS operations_background_parent_seed ON operations(operation_id) WHERE owner_kind='parent-session' AND observer_kind='local-supervisor'`,
    `CREATE TABLE IF NOT EXISTS background_parent_callback_migration (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        after_operation_id TEXT NOT NULL,
        through_operation_id TEXT NOT NULL,
        done INTEGER NOT NULL CHECK(done IN (0,1))
    )`,
    `INSERT OR IGNORE INTO background_parent_callback_migration(singleton,after_operation_id,through_operation_id,done)
        SELECT 1,'',COALESCE(MAX(operation_id),''),CASE WHEN MAX(operation_id) IS NULL THEN 1 ELSE 0 END
        FROM operations WHERE owner_kind='parent-session' AND observer_kind='local-supervisor'`,
];
const ASSIGNMENT_ATTEMPTS_DDL = `CREATE TABLE IF NOT EXISTS assignment_attempts (
    attempt_id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL REFERENCES assignment_bindings (assignment_id)
)`;
const ASSIGNMENT_ATTEMPT_COLUMN = `assignment_attempt_id TEXT REFERENCES assignment_attempts (attempt_id)`;
const EXPIRY_INDEXES = [
    "CREATE INDEX IF NOT EXISTS operations_expiry ON operations(created_at) WHERE phase = 'running' AND terminal_revision = 0",
    "CREATE INDEX IF NOT EXISTS waits_expiry ON waits(created_at) WHERE phase NOT IN ('consumed', 'cancelled') AND dispatch_disarmed = 0",
    "CREATE INDEX IF NOT EXISTS claims_expiry ON resume_claims(claimed_at) WHERE state IN ('claimed', 'published')",
];
const ASSIGNMENT_CLEANUP_INDEX = `CREATE INDEX IF NOT EXISTS operations_assignment_cleanup
    ON operations (operation_id, assignment_attempt_id)
    WHERE assignment_attempt_id IS NOT NULL`;
// Terminal evidence is written before the operation's terminal revision in the same transaction.
function needsAssignmentCleanup(row) {
    return `(${row}.terminal_revision = 0 OR ${row}.terminal_outcome = 'lost' OR EXISTS (
        SELECT 1 FROM operation_evidence e WHERE e.operation_id = ${row}.operation_id
          AND e.terminal_revision = ${row}.terminal_revision AND e.kind = 'terminal-record'
          AND e.summary LIKE '%groupCleanup=unproven%'))`;
}
const CLEANUP_FOR_ASSIGNMENT = `SELECT op.operation_id, op.supervision_host_id
    FROM assignment_attempts a JOIN operations op ON op.assignment_attempt_id = a.attempt_id
    WHERE a.assignment_id = NEW.assignment_id AND ${needsAssignmentCleanup("op")}`;
// Triggers also cover older processes that still have an open coordinator connection.
const PENDING_CLEANUP_DDL = [
    `CREATE TABLE IF NOT EXISTS assignment_cleanup_pending (
        operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
        supervision_host_id TEXT
    ) WITHOUT ROWID`,
    `CREATE INDEX assignment_cleanup_host ON assignment_cleanup_pending(supervision_host_id, operation_id)`,
    `CREATE INDEX assignment_attempts_by_assignment ON assignment_attempts(assignment_id, attempt_id)`,
    `CREATE INDEX operations_by_assignment_attempt ON operations(assignment_attempt_id)
        WHERE assignment_attempt_id IS NOT NULL`,
    `CREATE TRIGGER assignment_cleanup_enqueue AFTER INSERT ON assignment_outcomes BEGIN
        INSERT INTO assignment_cleanup_pending ${CLEANUP_FOR_ASSIGNMENT};
    END`,
    `CREATE TRIGGER assignment_cleanup_terminal AFTER UPDATE OF terminal_revision ON operations
        WHEN NEW.assignment_attempt_id IS NOT NULL AND NEW.terminal_revision > 0 AND NOT ${needsAssignmentCleanup("NEW")} BEGIN
        DELETE FROM assignment_cleanup_pending WHERE operation_id = NEW.operation_id;
    END`,
    `CREATE TRIGGER assignment_cleanup_transfer AFTER UPDATE OF supervision_host_id ON operations
        WHEN NEW.assignment_attempt_id IS NOT NULL AND NEW.supervision_host_id IS NOT OLD.supervision_host_id BEGIN
        UPDATE assignment_cleanup_pending SET supervision_host_id = NEW.supervision_host_id WHERE operation_id = NEW.operation_id;
    END`,
    `CREATE TRIGGER assignment_cleanup_verified AFTER INSERT ON coordinator_state
        WHEN NEW.key GLOB 'assignment-cleanup-verified:*' BEGIN
        DELETE FROM assignment_cleanup_pending WHERE operation_id = substr(NEW.key, length('assignment-cleanup-verified:') + 1);
    END`,
];
const DDL = [
    `CREATE TABLE task_cancellation_authorities (
        credential_hash TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        directory TEXT NOT NULL
    )`,
    `CREATE TABLE task_cancellation_requests (
        owner_key TEXT NOT NULL,
        request_key TEXT NOT NULL,
        operation_id TEXT NOT NULL REFERENCES operations (operation_id),
        intent_json TEXT NOT NULL,
        result_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'stop-requested')),
        PRIMARY KEY (owner_key, request_key)
    )`,
    `CREATE TABLE assignment_repairs (
        fault_key TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        fault_json TEXT NOT NULL,
        claim_id TEXT NOT NULL
    )`,
    `CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE TABLE operations (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        launch_token TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        owner_workspace TEXT NOT NULL,
        owner_branch_id TEXT,
        owner_goal_id TEXT,
        ${ASSIGNMENT_ATTEMPT_COLUMN},
        observer_kind TEXT NOT NULL,
        observer_version TEXT NOT NULL,
        supervision_json TEXT,
        supervision_host_id TEXT,
        authority_ref TEXT,
        intent_ref TEXT,
        phase TEXT NOT NULL,
        health TEXT NOT NULL,
        health_reason TEXT,
        terminal_revision INTEGER NOT NULL DEFAULT 0,
        terminal_outcome TEXT,
        terminal_event_id TEXT,
        terminal_detail_lost INTEGER NOT NULL DEFAULT 0,
        terminal_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        terminal_at INTEGER
    )`,
    ...BACKGROUND_CALLBACK_DDL,
    `CREATE INDEX operations_owner ON operations (owner_kind, owner_session_id)`,
    `CREATE INDEX operations_phase ON operations (phase)`,
    `CREATE INDEX operations_running_supervisor ON operations (phase, supervision_host_id)`,
    ASSIGNMENT_CLEANUP_INDEX,
    // Discovery leadership is separate from per-operation supervision. The token
    // fences stale acquisition and release; the host id is checked with process
    // identity before a replacement.
    `CREATE TABLE discovery_claims (
        scope TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        token TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    // Small shared state for change notification. The table is additive so an
    // older reader that understands schema version 1 can safely ignore it.
    `CREATE TABLE coordinator_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
    `CREATE TABLE operation_evidence (
        operation_id TEXT NOT NULL REFERENCES operations (operation_id),
        terminal_revision INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        summary TEXT,
        detail_lost INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (operation_id, terminal_revision, ordinal)
    )`,
    `CREATE TABLE waits (
        dispatch_disarmed INTEGER NOT NULL DEFAULT 0,
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        owner_workspace TEXT NOT NULL,
        owner_branch_id TEXT,
        owner_goal_id TEXT,
        phase TEXT NOT NULL,
        phase_reason TEXT,
        cancel_epoch INTEGER NOT NULL DEFAULT 0,
        continuation_note TEXT NOT NULL,
        park_json TEXT,
        origin_json TEXT,
        settled_at INTEGER,
        acknowledged_at INTEGER,
        acknowledgement_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (wait_id, generation)
    )`,
    // At most one generation per owner identity (session + branch) may be pending.
    `CREATE UNIQUE INDEX waits_one_pending_per_owner
        ON waits (owner_kind, owner_session_id, coalesce(owner_branch_id, ''))
        WHERE phase NOT IN ('consumed', 'cancelled') AND dispatch_disarmed = 0`,
    `CREATE INDEX waits_owner ON waits (owner_kind, owner_session_id)`,
    `CREATE TABLE wait_dependencies (
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        operation_id TEXT NOT NULL REFERENCES operations (operation_id),
        link TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL DEFAULT 0,
        terminal_outcome TEXT,
        settled_at INTEGER,
        PRIMARY KEY (wait_id, generation, operation_id)
    )`,
    `CREATE INDEX wait_dependencies_operation ON wait_dependencies (operation_id, terminal_revision)`,
    `CREATE TABLE resume_claims (
        claim_id TEXT PRIMARY KEY,
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        cancel_epoch INTEGER NOT NULL,
        claim_token TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        attempt_id TEXT UNIQUE,
        launch_token TEXT,
        lease_json TEXT NOT NULL,
        reserved_checkpoint_id TEXT NOT NULL,
        claimed_at INTEGER NOT NULL,
        published_at INTEGER,
        released_at INTEGER,
        invalidated_at INTEGER,
        reason TEXT
    )`,
    `CREATE UNIQUE INDEX resume_claims_one_active
        ON resume_claims (wait_id, generation)
        WHERE state IN ('claimed', 'published')`,
    `CREATE TABLE evidence_reads (
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL,
        reader_kind TEXT NOT NULL,
        reader_session_id TEXT NOT NULL,
        reader_workspace TEXT NOT NULL,
        reader_branch_id TEXT,
        reader_goal_id TEXT,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (wait_id, generation, operation_id, terminal_revision)
    )`,
    `CREATE TABLE evidence_pins (
        pin_id TEXT PRIMARY KEY,
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        summary TEXT,
        detail_lost INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER,
        pinned_at INTEGER NOT NULL,
        released_at INTEGER,
        release_reason TEXT
    )`,
    `CREATE UNIQUE INDEX evidence_pins_reference
        ON evidence_pins (wait_id, generation, operation_id, terminal_revision, kind, ref)`,
    `CREATE INDEX evidence_pins_operation ON evidence_pins (operation_id, terminal_revision, released_at)`,
    `CREATE TABLE outbox_events (
        event_type TEXT NOT NULL DEFAULT 'dependency-ready',
        event_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        terminal_revision INTEGER NOT NULL,
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        recipient_kind TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        recipient_workspace TEXT NOT NULL,
        recipient_branch_id TEXT,
        recipient_goal_id TEXT,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        dispatch_claim_json TEXT,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        delivered_at INTEGER,
        acknowledged_at INTEGER,
        voided_at INTEGER,
        reason TEXT,
        UNIQUE (operation_id, terminal_revision, wait_id, generation)
    )`,
    `CREATE INDEX outbox_recipient ON outbox_events (recipient_kind, recipient_session_id, state)`,
    `CREATE INDEX outbox_wait ON outbox_events (wait_id, generation)`,
    `CREATE TABLE assignment_outcomes (
        assignment_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL
    )`,
    `CREATE TABLE assignment_bindings (
        assignment_id TEXT PRIMARY KEY,
        owner_json TEXT NOT NULL,
        recipient_json TEXT NOT NULL
    )`,
    ASSIGNMENT_ATTEMPTS_DDL,
    `CREATE TABLE assignment_outcome_waits (
        assignment_id TEXT NOT NULL REFERENCES assignment_outcomes (assignment_id),
        wait_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (wait_id, generation)
    )`,
    RESULT_ADMISSION_FENCE,
    ...PENDING_CLEANUP_DDL,
];
const SCHEMA_VERSION_KEY = "schema_version";
function existingTables(ctx) {
    return getRows(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map((row) => columnText(row, "name"));
}
/**
 * Create the schema on an empty database, or verify the recorded version.
 * Any mismatch refuses without modifying the file.
 */
export function ensureSchema(ctx) {
    const tables = existingTables(ctx);
    const hasMeta = tables.includes("schema_meta");
    if (!hasMeta) {
        if (tables.length > 0) {
            throw new StoreError("schema-version", `The database at this path holds tables (${tables.join(", ")}) but no ${SCHEMA_VERSION_KEY}. It was not written by the operation coordinator; refusing to reuse or clear it.`);
        }
        ctx.transaction(() => {
            for (const statement of [...DDL, ...EXPIRY_INDEXES])
                ctx.db.exec(statement);
            run(ctx, "INSERT INTO schema_meta (key, value) VALUES (?, ?)", SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
        });
        return;
    }
    const row = getRow(ctx, "SELECT value FROM schema_meta WHERE key = ?", SCHEMA_VERSION_KEY);
    if (!row) {
        throw new StoreError("schema-version", `The database at this path has no ${SCHEMA_VERSION_KEY} record. Refusing to read or migrate unknown records.`);
    }
    const raw = columnText(row, "value");
    const recorded = Number(raw);
    if (!Number.isInteger(recorded) || recorded < 1) {
        throw new StoreError("schema-version", `The database records schema version ${JSON.stringify(raw)}, which is not a usable version. Records are left in place.`);
    }
    if (recorded > SCHEMA_VERSION) {
        throw new StoreError("schema-version", `The database was written by schema version ${recorded}; this build understands version ${SCHEMA_VERSION}. Upgrade the harness instead of downgrading the records.`);
    }
    if (recorded < SCHEMA_VERSION) {
        ctx.transaction(() => {
            // Another opener may have finished the upgrade before we acquired the write lock.
            const current = readSchemaVersion(ctx);
            if (current === SCHEMA_VERSION)
                return;
            if (current !== recorded) {
                throw new StoreError("schema-version", "The coordinator schema changed during opening. Reopen the store to verify it.");
            }
            ensureAdditiveSchema(ctx);
            if (recorded <= 2) {
                if (recorded === 1)
                    ctx.db.exec("ALTER TABLE outbox_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'dependency-ready'");
                for (const statement of DDL.filter((sql) => sql.startsWith("CREATE TABLE assignment_")))
                    ctx.db.exec(statement.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
                ctx.db.exec("ALTER TABLE waits ADD COLUMN dispatch_disarmed INTEGER NOT NULL DEFAULT 0");
                ctx.db.exec("UPDATE waits SET dispatch_disarmed = 1 WHERE EXISTS (SELECT 1 FROM assignment_outcome_waits aw WHERE aw.wait_id = waits.wait_id AND aw.generation = waits.generation)");
                ctx.db.exec("DROP INDEX waits_one_pending_per_owner");
                ctx.db.exec(DDL.find((sql) => sql.startsWith("CREATE UNIQUE INDEX waits_one_pending_per_owner")));
            }
            else if (recorded === 3) {
                ctx.db.exec(DDL.find((sql) => sql.startsWith("CREATE TABLE assignment_repairs")));
            }
            ensureAssignmentCleanupSchema(ctx);
            run(ctx, "UPDATE schema_meta SET value = ? WHERE key = ?", String(SCHEMA_VERSION), SCHEMA_VERSION_KEY);
        });
        return;
    }
    ensureAdditiveSchema(ctx);
    ensureAssignmentCleanupSchema(ctx);
}
function ensureAssignmentCleanupSchema(ctx) {
    for (const statement of EXPIRY_INDEXES)
        ctx.db.exec(statement);
    const hasColumn = () => getRows(ctx, "PRAGMA table_info(operations)").some(row => row.name === "assignment_attempt_id");
    const hasPending = () => !!getRow(ctx, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assignment_cleanup_pending'");
    if (hasPending())
        return;
    ctx.transaction(() => {
        if (hasPending())
            return;
        ctx.db.exec(ASSIGNMENT_ATTEMPTS_DDL);
        // Legacy writers leave the nullable provenance unset.
        if (!hasColumn())
            ctx.db.exec(`ALTER TABLE operations ADD COLUMN ${ASSIGNMENT_ATTEMPT_COLUMN}`);
        ctx.db.exec(ASSIGNMENT_CLEANUP_INDEX);
        for (const statement of PENDING_CLEANUP_DDL)
            ctx.db.exec(statement);
        if (process.platform === "win32") {
            // Earlier Windows writers mistook an unsupported group probe for proof of exit.
            ctx.db.exec("DELETE FROM coordinator_state WHERE key GLOB 'assignment-cleanup-verified:*'");
        }
        ctx.db.exec(`INSERT INTO assignment_cleanup_pending
            SELECT op.operation_id, op.supervision_host_id FROM operations op
            JOIN assignment_attempts a ON a.attempt_id = op.assignment_attempt_id
            JOIN assignment_outcomes o ON o.assignment_id = a.assignment_id
            WHERE ${needsAssignmentCleanup("op")} AND NOT EXISTS (SELECT 1 FROM coordinator_state
                WHERE key = 'assignment-cleanup-verified:' || op.operation_id)`);
    });
}
/**
 * Schema version 1 is extended additively: older readers ignore the new column,
 * index and tables, so a live session on the previous build does not lose its
 * records during a rolling upgrade. Missing additions are created once on open.
 */
function ensureAdditiveSchema(ctx) {
    // Schema/index creation is atomic; legacy obligation seeding is performed
    // separately in bounded batches by the canonical manager.
    ctx.transaction(() => { for (const statement of BACKGROUND_CALLBACK_DDL)
        ctx.db.exec(statement); });
    const hasColumn = () => getRows(ctx, "PRAGMA table_info(operations)").some((row) => columnText(row, "name") === "supervision_host_id");
    const hasIndex = () => getRows(ctx, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", "operations_running_supervisor").length > 0;
    const hasTable = (name) => existingTables(ctx).includes(name);
    if (hasColumn()
        && hasIndex()
        && hasTable("discovery_claims")
        && hasTable("coordinator_state")
        && hasTable("task_cancellation_requests")
        && hasTable("task_cancellation_authorities")
        && getRows(ctx, "PRAGMA table_info(task_cancellation_requests)").some(row => row.name === "result_json")) {
        ctx.db.exec(RESULT_ADMISSION_FENCE);
        return;
    }
    ctx.transaction(() => {
        ctx.db.exec(DDL.find((sql) => sql.startsWith("CREATE TABLE task_cancellation_requests")).replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
        if (!getRows(ctx, "PRAGMA table_info(task_cancellation_requests)").some(row => row.name === "result_json"))
            ctx.db.exec("ALTER TABLE task_cancellation_requests ADD COLUMN result_json TEXT");
        ctx.db.exec(DDL.find((sql) => sql.startsWith("CREATE TABLE task_cancellation_authorities")).replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
        if (!hasColumn()) {
            ctx.db.exec("ALTER TABLE operations ADD COLUMN supervision_host_id TEXT");
            ctx.db.exec(`UPDATE operations
                SET supervision_host_id = CASE
                    WHEN json_valid(supervision_json) THEN json_extract(supervision_json, '$.hostId')
                    ELSE NULL
                END`);
        }
        ctx.db.exec("CREATE INDEX IF NOT EXISTS operations_running_supervisor ON operations (phase, supervision_host_id)");
        ctx.db.exec(`CREATE TABLE IF NOT EXISTS discovery_claims (
            scope TEXT PRIMARY KEY,
            host_id TEXT NOT NULL,
            token TEXT NOT NULL,
            claimed_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`);
        ctx.db.exec(`CREATE TABLE IF NOT EXISTS coordinator_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);
        ctx.db.exec(RESULT_ADMISSION_FENCE);
    });
}
/** Test and diagnostic seam: read the recorded schema version without opening a store. */
export function readSchemaVersion(ctx) {
    const row = getRow(ctx, "SELECT value FROM schema_meta WHERE key = ?", SCHEMA_VERSION_KEY);
    return row ? Number(columnText(row, "value")) : null;
}
