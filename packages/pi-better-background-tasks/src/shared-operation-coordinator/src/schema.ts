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
}

/** Test and diagnostic seam: read the recorded schema version without opening a store. */
export function readSchemaVersion(ctx: StoreContext): number | null {
    const row = getRow(ctx, "SELECT value FROM schema_meta WHERE key = ?", SCHEMA_VERSION_KEY);
    return row ? Number(columnText(row, "value")) : null;
}
