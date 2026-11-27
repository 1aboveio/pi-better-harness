import { existsSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

if (process.env.CONTINUATION_CRASH_POINT === "lease") {
  const fs = createRequire(import.meta.url)("node:fs");
  const link = fs.linkSync;
  fs.linkSync = (...args: any[]) => {
    const result = link(...args);
    const marker = process.env.CONTINUATION_CRASH_MARKER;
    if (marker && !existsSync(marker)) {
      try {
        const lease = JSON.parse(fs.readFileSync(args[1], "utf8"));
        if (lease.sessionId && lease.attemptId && lease.attemptId !== lease.sessionId) {
          writeFileSync(marker, JSON.stringify({ attemptId: lease.attemptId, sessionId: lease.sessionId })); process.kill(process.pid, "SIGKILL");
        }
      } catch { /* unrelated atomic file */ }
    }
    return result;
  };
  syncBuiltinESMExports();
}
const sqlite = createRequire(import.meta.url)("node:sqlite");
const OriginalDatabase = sqlite.DatabaseSync;
const metrics = { opens: 0, active: 0, maximum: 0 };
sqlite.DatabaseSync = class extends OriginalDatabase {
  private counted = true;
  private crashAfterCommit = false;
  constructor(...args: any[]) {
    super(...args); metrics.opens++; metrics.active++; metrics.maximum = Math.max(metrics.maximum, metrics.active);
  }
  prepare(sql: string) {
    const statement = super.prepare(sql);
    const run = statement.run.bind(statement);
    statement.run = (...args: any[]) => {
      const result = run(...args);
      if (process.env.CONTINUATION_CRASH_POINT === "claim" && /INSERT INTO resume_claims/.test(sql)) this.crashAfterCommit = true;
      if (process.env.CONTINUATION_CRASH_POINT === "spawn" && /UPDATE subagent_launch_intents SET attempts/.test(sql)
          && JSON.parse(String(args[0])).some((attempt: any) => attempt.state === "spawned" && attempt.recoveryMeta?.resumedFrom)) this.crashAfterCommit = true;
      if (process.env.CONTINUATION_CRASH_POINT === "published" && /UPDATE resume_claims[\s\S]*state = 'published'/.test(sql)) this.crashAfterCommit = true;
      if (process.env.CONTINUATION_CRASH_POINT === "result" && /INSERT INTO assignment_outcomes/.test(sql)) this.crashAfterCommit = true;
      return result;
    };
    return statement;
  }
  exec(sql: string) {
    const result = super.exec(sql);
    const marker = process.env.CONTINUATION_CRASH_MARKER;
    if (this.crashAfterCommit && /^COMMIT/i.test(sql.trim()) && marker && !existsSync(marker)) {
      writeFileSync(marker, "claim committed");
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  }
  close() {
    super.close();
    if (this.counted) { metrics.active--; this.counted = false; }
  }
};
const { startDaemon } = await import("../../src/server.ts");
const { createRpcEvidence } = await import('./rpc-evidence.ts');
const evidence = createRpcEvidence();
const { CatalogSources } = await import("../../src/runtime/catalog-sources.ts");
let catalogMetrics: InstanceType<typeof CatalogSources>["metrics"] | undefined;
const loadCatalog = CatalogSources.prototype.load;
CatalogSources.prototype.load = function (...args) {
  catalogMetrics = this.metrics;
  return loadCatalog.apply(this, args);
};

const daemon = await startDaemon({ serverDir: process.env.PI_SERVER_DIR, sessionIdleMs: 0, daemonIdleMs: 0, rpcEvidence: evidence });
process.send?.({ ready: daemon.socketPath });
process.on("message", async command => {
  if (command && typeof command === 'object' && 'rpcEvidence' in command) {
    process.send?.({ rpcEvidence: command.rpcEvidence, snapshot: evidence.snapshot() });
    return;
  }
  if (command === "cpu") { process.send?.(process.cpuUsage()); return; }
  if (command === "metrics") {
    const domain = "../../src/runtime/domain/subagents/index.domain.mjs";
    const { isHealthTickerActive } = await import(domain);
    process.send?.({ sqlite: metrics, subagentHealthActive: isHealthTickerActive(), catalog: catalogMetrics });
  }
  else void daemon.stop().then(() => process.exit(0));
});
