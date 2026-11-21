import { createRequire } from "node:module";
const sqlite = createRequire(import.meta.url)("node:sqlite");
const Original = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends Original {
  exec(sql: string) {
    if (sql === "COMMIT" && process.env.CHECKPOINT_CRASH === "before") process.kill(process.pid, "SIGKILL");
    const result = super.exec(sql);
    if (sql === "COMMIT" && process.env.CHECKPOINT_CRASH === "after") process.kill(process.pid, "SIGKILL");
    return result;
  }
};
const { LogCheckpoints } = await import("../../src/runtime/log-checkpoints.ts");
const owner = process.argv[3] === "shared" ? new sqlite.DatabaseSync(":memory:") : undefined;
const store = new LogCheckpoints(process.argv[2]!, owner);
owner?.exec("BEGIN");
store.save("log", { display: { offset: 20, usage: 2 }, health: { offset: 20, tools: 0 } });
owner?.exec("COMMIT");
store.close();
owner?.close();
