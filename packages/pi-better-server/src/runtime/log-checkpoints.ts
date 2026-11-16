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
  readonly metrics = { restores: 0, misses: 0, commits: 0, oversized: 0 };
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=FULL;
      CREATE TABLE IF NOT EXISTS checkpoints(path TEXT PRIMARY KEY, version INTEGER, payload TEXT, bytes INTEGER, used INTEGER);`);
  }
  load(path: string): any {
    const row = this.db.prepare("SELECT payload FROM checkpoints WHERE path=? AND version=?").get(path, LOG_CHECKPOINT_VERSION);
    if (!row) { this.metrics.misses++; return undefined; }
    try { const saved = JSON.parse(row.payload); this.metrics.restores++; return saved; } catch { this.metrics.misses++; return undefined; }
  }
  save(path: string, value: unknown) {
    const payload = JSON.stringify(value), bytes = Buffer.byteLength(payload);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM checkpoints WHERE path=?").run(path);
      if (bytes <= LOG_CHECKPOINT_ENTRY_BUDGET) {
        this.db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?,?)").run(path, LOG_CHECKPOINT_VERSION, payload, bytes, Date.now());
      }
      else this.metrics.oversized++;
      while (this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM checkpoints").get().n > LOG_CHECKPOINT_BUDGET) {
        this.db.exec("DELETE FROM checkpoints WHERE path=(SELECT path FROM checkpoints ORDER BY used,path LIMIT 1)");
      }
      this.db.prepare("DELETE FROM checkpoints WHERE path IN (SELECT path FROM checkpoints ORDER BY used DESC,path DESC LIMIT -1 OFFSET ?)").run(LOG_CHECKPOINT_MAX_ENTRIES);
      this.db.exec("COMMIT");
      this.metrics.commits++;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { this.db.close(); }
}
