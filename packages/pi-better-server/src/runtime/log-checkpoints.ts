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
  readonly metrics = { restores: 0, misses: 0, commits: 0, oversized: 0 };
  constructor(path: string, connection?: any) {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.shared = Boolean(connection);
    this.db = connection ?? new DatabaseSync(path);
    this.prefix = connection ? "log_checkpoints." : "";
    // Keep durable folds on the query owner's handle; query tables stay in memory.
    if (connection) this.db.prepare("ATTACH DATABASE ? AS log_checkpoints").run(path);
    const existing = this.db.prepare(`SELECT type FROM ${this.prefix}sqlite_master WHERE name='checkpoints'`).get();
    if (existing) {
      const columns = this.db.prepare(`PRAGMA ${this.prefix}table_info(checkpoints)`).all();
      const expected = [["path", "TEXT", 1], ["version", "INTEGER", 0], ["payload", "TEXT", 0], ["bytes", "INTEGER", 0], ["used", "INTEGER", 0]];
      if (existing.type !== "table" || columns.length !== expected.length || columns.some((column: any, i: number) => column.name !== expected[i]![0] || column.type !== expected[i]![1] || column.pk !== expected[i]![2])) {
        if (this.shared) this.db.exec("DETACH DATABASE log_checkpoints"); else this.db.close();
        throw new Error("Unsupported checkpoint schema");
      }
      return;
    }
    this.db.exec(`PRAGMA ${this.prefix}journal_mode=DELETE`);
    // Setting an already-enabled auto_vacuum still requests a write lock.
    // Reopening a checkpoint reader must not contend with a reserved writer.
    if (this.db.prepare(`PRAGMA ${this.prefix}auto_vacuum`).get().auto_vacuum !== 1) {
      this.db.exec(`PRAGMA ${this.prefix}auto_vacuum=FULL`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.prefix}checkpoints(path TEXT PRIMARY KEY, version INTEGER, payload TEXT, bytes INTEGER, used INTEGER)`);
  }
  load(path: string): any {
    const row = this.db.prepare(`SELECT payload FROM ${this.prefix}checkpoints WHERE path=? AND version=?`).get(path, LOG_CHECKPOINT_VERSION);
    if (!row) { this.metrics.misses++; return undefined; }
    try { const saved = JSON.parse(row.payload); this.metrics.restores++; return saved; } catch { this.metrics.misses++; return undefined; }
  }
  save(path: string, value: unknown) {
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
  close() { if (this.shared) this.db.exec("DETACH DATABASE log_checkpoints"); else this.db.close(); }
}
