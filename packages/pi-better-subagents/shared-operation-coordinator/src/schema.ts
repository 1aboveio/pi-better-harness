// Generated from packages/operation-coordinator/src/schema.ts. Do not edit directly.
/**
 * Schema v1 for the durable operation coordinator.
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
import { SCHEMA_VERSION } from "./types.ts";
import { StoreError } from "./errors.ts";
import { columnText, getRow, getRows, run, type StoreContext } from "./sqlite.ts";

const DDL: readonly string[] = [
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
        observer_kind TEXT NOT NULL,
        observer_version TEXT NOT NULL,
        supervision_json TEXT,
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
    `CREATE INDEX operations_owner ON operations (owner_kind, owner_session_id)`,
    `CREATE INDEX operations_phase ON operations (phase)`,
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
        WHERE phase NOT IN ('consumed', 'cancelled')`,
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
    // Owner-scoped change hints. They are hints, not deliveries: the shared
    // coordinator routes them to subscribed clients, which then read exactly
    // their own operation/wait/outbox state. A hint never wakes a model.
    `CREATE TABLE IF NOT EXISTS coordinator_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        operation_id TEXT,
        task_id TEXT,
        owner_kind TEXT NOT NULL,
        owner_session_id TEXT NOT NULL,
        owner_workspace TEXT NOT NULL,
        owner_branch_id TEXT,
        owner_goal_id TEXT,
        terminal_revision INTEGER NOT NULL DEFAULT 0,
        wait_id TEXT,
        generation INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS coordinator_changes_owner
        ON coordinator_changes (owner_kind, owner_session_id, owner_workspace, seq)`,
    // Retention reservations/tombstones. A reservation blocks new references;
    // `complete` is retained as a tombstone so a task id is not silently reused
    // and a retried cleanup reports completion rather than deleting again.
    `CREATE TABLE IF NOT EXISTS retention_units (
        operation_id TEXT PRIMARY KEY,
        task_id TEXT,
        launch_token TEXT,
        token TEXT NOT NULL,
        state TEXT NOT NULL,
        artifact_ref TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        detail TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS retention_units_state ON retention_units (state, updated_at)`,
    // Cross-client safety: an old client that does not know about retention
    // still cannot add a reference to an operation the coordinator reserved.
    `CREATE TRIGGER IF NOT EXISTS retention_blocks_wait_dependency
        BEFORE INSERT ON wait_dependencies
        WHEN EXISTS (SELECT 1 FROM retention_units WHERE operation_id = NEW.operation_id)
        BEGIN
            SELECT RAISE(ABORT, 'retention-reserved operation cannot gain a wait dependency');
        END`,
    `CREATE TRIGGER IF NOT EXISTS retention_blocks_evidence_pin
        BEFORE INSERT ON evidence_pins
        WHEN EXISTS (SELECT 1 FROM retention_units WHERE operation_id = NEW.operation_id)
        BEGIN
            SELECT RAISE(ABORT, 'retention-reserved operation cannot gain an evidence pin');
        END`,
    `CREATE TRIGGER IF NOT EXISTS retention_blocks_outbox
        BEFORE INSERT ON outbox_events
        WHEN EXISTS (SELECT 1 FROM retention_units WHERE operation_id = NEW.operation_id)
        BEGIN
            SELECT RAISE(ABORT, 'retention-reserved operation cannot gain an outbox event');
        END`,
    `CREATE TRIGGER IF NOT EXISTS retention_blocks_resume_claim
        BEFORE INSERT ON resume_claims
        WHEN EXISTS (
            SELECT 1 FROM wait_dependencies d
            JOIN retention_units r ON r.operation_id = d.operation_id
            WHERE d.wait_id = NEW.wait_id AND d.generation = NEW.generation
        )
        BEGIN
            SELECT RAISE(ABORT, 'retention-reserved operation cannot gain a resume reference');
        END`,
    // A completed tombstone means the launch identity was physically pruned.
    // Even an old v1 client that does not know the retention API must not
    // resurrect that identity and create records the current coordinator can no
    // longer legally clean up.
    `CREATE TRIGGER IF NOT EXISTS retention_blocks_tombstoned_operation
        BEFORE INSERT ON operations
        WHEN EXISTS (
            SELECT 1 FROM retention_units r
            WHERE r.state = 'complete'
              AND (
                  r.operation_id = NEW.operation_id
                  OR (r.task_id IS NOT NULL AND r.task_id = NEW.task_id)
                  OR (r.launch_token IS NOT NULL AND r.launch_token = NEW.launch_token)
              )
        )
        BEGIN
            SELECT RAISE(ABORT, 'retention-tombstoned operation identity cannot be reused');
        END`,
];

const SCHEMA_VERSION_KEY = "schema_version";

function existingTables(ctx: StoreContext): string[] {
    return getRows(
        ctx,
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((row) => columnText(row, "name"));
}

/**
 * Create the schema on an empty database, or verify the recorded version.
 * Any mismatch refuses without modifying the file.
 */
export function ensureSchema(ctx: StoreContext): void {
    const tables = existingTables(ctx);
    const hasMeta = tables.includes("schema_meta");
    if (!hasMeta) {
        if (tables.length > 0) {
            throw new StoreError(
                "schema-version",
                `The database at this path holds tables (${tables.join(", ")}) but no ${SCHEMA_VERSION_KEY}. It was not written by the operation coordinator; refusing to reuse or clear it.`,
            );
        }
        ctx.transaction(() => {
            for (const statement of DDL) ctx.db.exec(statement);
            run(ctx, "INSERT INTO schema_meta (key, value) VALUES (?, ?)", SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
        });
        return;
    }

    const row = getRow(ctx, "SELECT value FROM schema_meta WHERE key = ?", SCHEMA_VERSION_KEY);
    if (!row) {
        throw new StoreError(
            "schema-version",
            `The database at this path has no ${SCHEMA_VERSION_KEY} record. Refusing to read or migrate unknown records.`,
        );
    }
    const raw = columnText(row, "value");
    const recorded = Number(raw);
    if (!Number.isInteger(recorded) || recorded < 1) {
        throw new StoreError(
            "schema-version",
            `The database records schema version ${JSON.stringify(raw)}, which is not a usable version. Records are left in place.`,
        );
    }
    if (recorded > SCHEMA_VERSION) {
        throw new StoreError(
            "schema-version",
            `The database was written by schema version ${recorded}; this build understands version ${SCHEMA_VERSION}. Upgrade the harness instead of downgrading the records.`,
        );
    }
    if (recorded < SCHEMA_VERSION) {
        throw new StoreError(
            "schema-version",
            `The database is at schema version ${recorded}; this build needs version ${SCHEMA_VERSION}. No migration is provided for this pair; records are left in place.`,
        );
    }
    // Version 1 gained additive tables/triggers without changing any existing
    // record shape. Keeping the version at 1 means an older client can still
    // open the database and simply ignores the hint/retention tables; a newer
    // client creates them on a version-1 database. No record is rewritten.
    ensureAdditiveSchema(ctx);
}

function ensureAdditiveSchema(ctx: StoreContext): void {
    ctx.transaction(() => {
        // Create the additive tables/indexes first, then migrate the launch
        // token column, and only then create triggers that reference it.
        for (const statement of DDL) {
            if (statement.includes("CREATE TABLE IF NOT EXISTS coordinator_changes")
                || statement.includes("CREATE TABLE IF NOT EXISTS retention_units")
                || statement.includes("CREATE INDEX IF NOT EXISTS coordinator_changes_owner")
                || statement.includes("CREATE INDEX IF NOT EXISTS retention_units_state")) {
                ctx.db.exec(statement);
            }
        }
        const columns = getRows(ctx, "PRAGMA table_info(retention_units)");
        if (!columns.some((column) => columnText(column, "name") === "launch_token")) {
            ctx.db.exec("ALTER TABLE retention_units ADD COLUMN launch_token TEXT");
        }
        for (const statement of DDL) {
            if (statement.includes("CREATE TRIGGER IF NOT EXISTS retention_blocks")) {
                ctx.db.exec(statement);
            }
        }
    });
}

/** Test and diagnostic seam: read the recorded schema version without opening a store. */
export function readSchemaVersion(ctx: StoreContext): number | null {
    const row = getRow(ctx, "SELECT value FROM schema_meta WHERE key = ?", SCHEMA_VERSION_KEY);
    return row ? Number(columnText(row, "value")) : null;
}
