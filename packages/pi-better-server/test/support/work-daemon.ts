import { createRequire } from "node:module";

const sqlite = createRequire(import.meta.url)("node:sqlite");
const OriginalDatabase = sqlite.DatabaseSync;
const metrics = { opens: 0, active: 0, maximum: 0 };
sqlite.DatabaseSync = class extends OriginalDatabase {
  private counted = true;
  constructor(...args: any[]) {
    super(...args); metrics.opens++; metrics.active++; metrics.maximum = Math.max(metrics.maximum, metrics.active);
  }
  close() {
    super.close();
    if (this.counted) { metrics.active--; this.counted = false; }
  }
};
const { startDaemon } = await import("../../src/server.ts");

const daemon = await startDaemon({ serverDir: process.env.PI_SERVER_DIR, sessionIdleMs: 0, daemonIdleMs: 0 });
process.send?.({ ready: daemon.socketPath });
process.on("message", async command => {
  if (command === "metrics") {
    const domain = "../../src/runtime/domain/subagents/index.domain.mjs";
    const { isHealthTickerActive } = await import(domain);
    process.send?.({ sqlite: metrics, subagentHealthActive: isHealthTickerActive() });
  }
  else void daemon.stop().then(() => process.exit(0));
});
