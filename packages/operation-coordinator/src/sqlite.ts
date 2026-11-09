/**
 * `node:sqlite` access for the coordinator store.
 *
 * The runtime provides SQLite (Node 24+). When it does not, the store refuses to
 * open instead of degrading to an in-memory approximation: durability is the
 * whole point of these records.
 *
 * Writes use `BEGIN IMMEDIATE` so a mutation queue is serialised by SQLite's own
 * reserved lock rather than by a second locking scheme. Nested calls join the
 * outer transaction, which lets one logical step (record terminal outcome → mark
 * waits ready → enqueue delivery) commit atomically.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StoreError } from "./errors.ts";

const nodeRequire = createRequire(import.meta.url);

export interface StatementLike {
    run(...params: Array<string | number | null>): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
    all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
}

export interface DatabaseLike {
    exec(sql: string): void;
    prepare(sql: string): StatementLike;
    close(): void;
}

let databaseSyncCtor: (new (path: string) => DatabaseLike) | null | undefined;

export function databaseSync(): (new (path: string) => DatabaseLike) | null {
    if (databaseSyncCtor !== undefined) return databaseSyncCtor;
    try {
        const loaded = nodeRequire("node:sqlite") as { DatabaseSync?: new (path: string) => DatabaseLike };
        databaseSyncCtor = loaded.DatabaseSync ?? null;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = error instanceof Error ? error.message : String(error);
        const missing = code === "ERR_UNKNOWN_BUILTIN_MODULE"
            || message.includes("Cannot find package")
            || message.includes("Cannot find module")
            || message.includes("No such built-in module");
        if (!missing) throw error;
        databaseSyncCtor = null;
    }
    return databaseSyncCtor;
}

function isSqliteBusy(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY|database table is locked/i.test(message);
}

export interface OpenDatabaseOptions {
    busyTimeoutMs: number;
}

export function openDatabase(path: string, options: OpenDatabaseOptions): DatabaseLike {
    const Ctor = databaseSync();
    if (!Ctor) {
        throw new StoreError(
            "sqlite-unavailable",
            "The durable operation coordinator requires node:sqlite, which this runtime does not provide. Upgrade to Node 24 or newer; no in-memory fallback is offered.",
        );
    }
    if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const db = new Ctor(path);
    const waitMs = Math.min(60_000, Math.max(0, Math.floor(options.busyTimeoutMs)));
    try {
        db.exec(`PRAGMA busy_timeout = ${waitMs}`);
        if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
        // A terminal revision must survive an ordinary process crash.
        db.exec("PRAGMA synchronous = FULL");
        db.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
        try { db.close(); } catch { /* preserve the pragma failure */ }
        throw error;
    }
    return db;
}

export interface StoreContext {
    readonly db: DatabaseLike;
    /** Monotonic-epoch-millisecond clock seam. */
    now(): number;
    /** Current transaction nesting depth; 0 means no transaction is open. */
    readonly transactionDepth: number;
    /** Run `body` in one immediate transaction, joining an open outer transaction. */
    transaction<T>(body: () => T): T;
}

export function createContext(
    db: DatabaseLike,
    options: { now?: () => number } = {},
): StoreContext {
    const now = options.now ?? (() => Date.now());
    let depth = 0;
    const context: StoreContext = {
        db,
        now,
        get transactionDepth() {
            return depth;
        },
        transaction<T>(body: () => T): T {
            if (depth > 0) {
                depth += 1;
                try {
                    return body();
                } finally {
                    depth -= 1;
                }
            }
            try {
                db.exec("BEGIN IMMEDIATE");
            } catch (error) {
                if (isSqliteBusy(error)) {
                    throw new StoreError(
                        "store-busy",
                        "Another process is writing to the operation coordinator store. Retry after it commits.",
                    );
                }
                throw error;
            }
            depth = 1;
            try {
                const result = body();
                db.exec("COMMIT");
                return result;
            } catch (error) {
                try {
                    db.exec("ROLLBACK");
                } catch {
                    // A rollback failure must not hide the refusal that caused it.
                }
                throw error;
            } finally {
                depth = 0;
            }
        },
    };
    return context;
}

/**
 * Detect a uniqueness refusal (a concurrent process won the same insert).
 * SQLite names either the columns or the partial index that rejected the write.
 */
export function isUniqueViolation(error: unknown, ...markers: string[]): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (!/UNIQUE constraint failed/i.test(message)) return false;
    return markers.length === 0 || markers.some((marker) => message.includes(marker));
}

/** Run one statement. `changes` is normalised to a number for callers. */
export function run(
    ctx: StoreContext,
    sql: string,
    ...params: Array<string | number | null>
): number {
    const result = ctx.db.prepare(sql).run(...params);
    return Number(result.changes);
}

export function getRow(
    ctx: StoreContext,
    sql: string,
    ...params: Array<string | number | null>
): Record<string, unknown> | undefined {
    return ctx.db.prepare(sql).get(...params);
}

export function getRows(
    ctx: StoreContext,
    sql: string,
    ...params: Array<string | number | null>
): Array<Record<string, unknown>> {
    return ctx.db.prepare(sql).all(...params);
}

/** Strict column readers: a stored row that cannot be read back is corruption, not a guess. */
export function columnText(row: Record<string, unknown>, column: string): string {
    const value = row[column];
    if (typeof value !== "string") throw corruption(column, "string", value);
    return value;
}

export function columnNullableText(row: Record<string, unknown>, column: string): string | null {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw corruption(column, "string or null", value);
    return value;
}

export function columnNumber(row: Record<string, unknown>, column: string): number {
    const value = row[column];
    if (typeof value === "bigint") return Number(value);
    if (typeof value !== "number") throw corruption(column, "number", value);
    return value;
}

export function columnNullableNumber(row: Record<string, unknown>, column: string): number | null {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (typeof value === "bigint") return Number(value);
    if (typeof value !== "number") throw corruption(column, "number or null", value);
    return value;
}

export function columnBoolean(row: Record<string, unknown>, column: string): boolean {
    const value = columnNumber(row, column);
    return value !== 0;
}

/** Parse a JSON column; a corrupt payload is reported, never replaced. */
export function columnJson<T>(row: Record<string, unknown>, column: string): T | null {
    const raw = columnNullableText(row, column);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new StoreError(
            "store-corruption",
            `Stored column ${column} is not valid JSON. The record is left in place for inspection.`,
        );
    }
}

function corruption(column: string, expected: string, value: unknown): StoreError {
    return new StoreError(
        "store-corruption",
        `Stored column ${column} is not a ${expected} (found ${typeof value}). The record is left in place for inspection.`,
    );
}
