import { createRequire, syncBuiltinESMExports } from "node:module";

const threads = createRequire(import.meta.url)("node:worker_threads");
const OriginalWorker = threads.Worker;
const workers = new Set<InstanceType<typeof OriginalWorker>>();
threads.Worker = class extends OriginalWorker {
  constructor(url: URL, options: any) {
    const inventory = url.pathname.endsWith("/runtime/query-worker.mjs");
    super(inventory ? new URL("./blocked-inventory-worker.mjs", import.meta.url) : url, options);
    if (inventory) {
      workers.add(this);
      this.on("message", (message: any) => {
        if (message.type === "inventory-blocked") process.send?.({ type: "inventory-blocked" });
      });
    }
  }
};
syncBuiltinESMExports();
const { startDaemon } = await import("../../src/server.ts");
const daemon = await startDaemon({ sessionIdleMs: 0, daemonIdleMs: 0 });
process.send?.({ type: "ready", socket: daemon.socketPath });
process.on("message", message => {
  if (message === "release-inventory") {
    for (const worker of workers) worker.postMessage({ type: "release-inventory" });
  } else if (message === "stop") {
    void daemon.stop().then(() => process.exit(0));
  }
});
