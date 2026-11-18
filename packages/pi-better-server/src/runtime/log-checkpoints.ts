import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Derived data only. Deletion, eviction and incompatible versions cause replay.
export const LOG_CHECKPOINT_VERSION = 1;
export const LOG_CHECKPOINT_BUDGET = 32 * 1024 * 1024;
export const LOG_CHECKPOINT_ENTRY_BUDGET = 256 * 1024;
export const LOG_CHECKPOINT_MAX_ENTRIES = 4096;

export class LogCheckpoints {
  private db: any;
  private shared: boolean;
  private prefix: string;
  private attached = false;
  private initialized = false;
  private closed = false;
  private path: string;
  readonly metrics = { restores: 0, misses: 0, commits: 0, oversized: 0, acquisitionAttempts: 0, contentions: 0 };
  constructor(path: string, connection?: any, options: { defer?: boolean } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.shared = Boolean(connection);
    this.db = connection ?? new DatabaseSync(path);
    this.prefix = connection ? "log_checkpoints." : "";
    this.path = path;
    if (!options.defer) {
      try { this.acquire(); }
      catch (error) { if (!connection) { this.db.close(); this.closed = true; } throw error; }
    }
  }
  get ready() { return this.initialized && !this.closed; }
  /** One nonblocking attempt, outside the owner's source/derived transaction. */
  initialize(): boolean {
    try { this.acquire(); return true; }
    catch (error) {
      const sqlite = error as { code?: string; errcode?: number };
      if (sqlite.code === "ERR_SQLITE_ERROR" && typeof sqlite.errcode === "number"
          && [5, 6].includes(sqlite.errcode & 255)) {
        this.metrics.contentions++;
        return false;
      }
      throw error;
    }
  }
  private acquire() {
    if (this.closed) throw new Error("Checkpoint participant is closed");
    if (this.initialized) return;
    if (this.db.isTransaction) throw new Error("Checkpoint acquisition requires an unpinned owner");
    this.metrics.acquisitionAttempts++;
    try {
      // Keep durable folds on the query owner's handle; query tables stay in memory.
      if (this.shared && !this.attached) {
        this.db.prepare("ATTACH DATABASE ? AS log_checkpoints").run(this.path);
        this.attached = true;
      }
      this.db.exec(`PRAGMA ${this.prefix}journal_mode=DELETE`);
      // Setting an already-enabled auto_vacuum still requests a write lock.
      // Reopening a checkpoint reader must not contend with a reserved writer.
      if (this.db.prepare(`PRAGMA ${this.prefix}auto_vacuum`).get().auto_vacuum !== 1) {
        this.db.exec(`PRAGMA ${this.prefix}auto_vacuum=FULL`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.prefix}checkpoints(path TEXT PRIMARY KEY, version INTEGER, payload TEXT, bytes INTEGER, used INTEGER)`);
      this.initialized = true;
    } catch (error) {
      // Release only this participant's acquisition; a later attempt must not
      // inherit an unverified attachment or detach another participant's data.
      if (this.attached) {
        try { this.db.exec("DETACH DATABASE log_checkpoints"); this.attached = false; }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Checkpoint initialization and owned attachment cleanup failed"); }
      }
      throw error;
    }
  }
  load(path: string): any {
    if (!this.initialized || this.closed) throw new Error("Checkpoint coverage is unavailable");
    const row = this.db.prepare(`SELECT payload FROM ${this.prefix}checkpoints WHERE path=? AND version=?`).get(path, LOG_CHECKPOINT_VERSION);
    if (!row) { this.metrics.misses++; return undefined; }
    try { const saved = JSON.parse(row.payload); this.metrics.restores++; return saved; } catch { this.metrics.misses++; return undefined; }
  }
  save(path: string, value: unknown) {
    if (!this.initialized || this.closed) throw new Error("Checkpoint coverage is unavailable");
    const payload = JSON.stringify(value), bytes = Buffer.byteLength(payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM ${this.prefix}checkpoints WHERE path=?`).run(path);
      if (bytes <= LOG_CHECKPOINT_ENTRY_BUDGET) {
        this.db.prepare(`INSERT INTO ${this.prefix}checkpoints VALUES(?,?,?,?,?)`).run(path, LOG_CHECKPOINT_VERSION, payload, bytes, Date.now());
      }
      else this.metrics.oversized++;
      while (this.db.prepare(`SELECT coalesce(sum(bytes),0) AS n FROM ${this.prefix}checkpoints`).get().n > LOG_CHECKPOINT_BUDGET) {
        this.db.exec(`DELETE FROM ${this.prefix}checkpoints WHERE path=(SELECT path FROM ${this.prefix}checkpoints ORDER BY used,path LIMIT 1)`);
      }
      this.db.prepare(`DELETE FROM ${this.prefix}checkpoints WHERE path IN (SELECT path FROM ${this.prefix}checkpoints ORDER BY used DESC,path DESC LIMIT -1 OFFSET ?)`).run(LOG_CHECKPOINT_MAX_ENTRIES);
      this.db.exec("COMMIT");
      this.metrics.commits++;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() {
    if (this.closed) return;
    if (this.shared) {
      if (this.attached) { this.db.exec("DETACH DATABASE log_checkpoints"); this.attached = false; }
    } else this.db.close();
    this.closed = true;
  }
}
