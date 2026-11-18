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
    let attached = false;
    try {
      // Keep durable folds on the query owner's handle; query tables stay in memory.
      if (connection) {
        this.db.prepare("ATTACH DATABASE ? AS log_checkpoints").run(path);
        attached = true;
      }
      this.db.exec(`PRAGMA ${this.prefix}journal_mode=DELETE`);
      // Setting an already-enabled auto_vacuum still requests a write lock.
      // Reopening a checkpoint reader must not contend with a reserved writer.
      if (this.db.prepare(`PRAGMA ${this.prefix}auto_vacuum`).get().auto_vacuum !== 1) {
        this.db.exec(`PRAGMA ${this.prefix}auto_vacuum=FULL`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.prefix}checkpoints(path TEXT PRIMARY KEY, version INTEGER, payload TEXT, bytes INTEGER, used INTEGER)`);
    } catch (error) {
      // A failed constructor has no caller-visible handle to close. Release only
      // resources acquired here, never an attachment owned by an earlier caller.
      try {
        if (attached) this.db.exec("DETACH DATABASE log_checkpoints");
        else if (!connection) this.db.close();
      } catch { /* Preserve the original bootstrap failure. */ }
      throw error;
    }
  }
  load(path: string): any {
    const row = this.db.prepare(`SELECT payload FROM ${this.prefix}checkpoints WHERE path=? AND version=?`).get(path, LOG_CHECKPOINT_VERSION);
    if (!row) { this.metrics.misses++; return undefined; }
    try { const saved = JSON.parse(row.payload); this.metrics.restores++; return saved; } catch { this.metrics.misses++; return undefined; }
  }
  save(path: string, value: unknown, deferPublication = false) {
    const payload = JSON.stringify(value), bytes = Buffer.byteLength(payload);
    this.db.exec(this.shared ? "SAVEPOINT checkpoint_save" : "BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM ${this.prefix}checkpoints WHERE path=?`).run(path);
      if (bytes <= LOG_CHECKPOINT_ENTRY_BUDGET) {
        this.db.prepare(`INSERT INTO ${this.prefix}checkpoints VALUES(?,?,?,?,?)`).run(path, LOG_CHECKPOINT_VERSION, payload, bytes, Date.now());
      }
      while (this.db.prepare(`SELECT coalesce(sum(bytes),0) AS n FROM ${this.prefix}checkpoints`).get().n > LOG_CHECKPOINT_BUDGET) {
        this.db.exec(`DELETE FROM ${this.prefix}checkpoints WHERE path=(SELECT path FROM ${this.prefix}checkpoints ORDER BY used,path LIMIT 1)`);
      }
      this.db.prepare(`DELETE FROM ${this.prefix}checkpoints WHERE path IN (SELECT path FROM ${this.prefix}checkpoints ORDER BY used DESC,path DESC LIMIT -1 OFFSET ?)`).run(LOG_CHECKPOINT_MAX_ENTRIES);
      this.db.exec(this.shared ? "RELEASE checkpoint_save" : "COMMIT");
      let published = false;
      const publish = () => {
        if (published) return;
        published = true;
        this.metrics.commits++;
        if (bytes > LOG_CHECKPOINT_ENTRY_BUDGET) this.metrics.oversized++;
      };
      if (!deferPublication) publish();
      return publish;
    } catch (error) { this.db.exec(this.shared ? "ROLLBACK TO checkpoint_save; RELEASE checkpoint_save" : "ROLLBACK"); throw error; }
  }
  close() { if (this.shared) this.db.exec("DETACH DATABASE log_checkpoints"); else this.db.close(); }
}
