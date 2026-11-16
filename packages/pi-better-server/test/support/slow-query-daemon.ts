import { createRequire, syncBuiltinESMExports } from "node:module";
const threads = createRequire(import.meta.url)("node:worker_threads");
const OriginalWorker = threads.Worker;
let reads: InstanceType<typeof OriginalWorker>;
threads.Worker = class extends OriginalWorker {
  constructor(url: URL, options: any) {
    const isRead = url.pathname.endsWith("/runtime/query-worker.mjs");
    super(isRead ? new URL("./cancellable-query-worker.mjs", import.meta.url) : url, options);
    if (isRead) {
      reads = this;
      this.on("message", (message: any) => {
        if (["query-blocked", "wedged"].includes(message.type)) process.send?.(message);
      });
    }
  }
};
syncBuiltinESMExports();
const { startDaemon } = await import("../../src/server.ts");
const daemon = await startDaemon({ sessionIdleMs: 0, daemonIdleMs: 0 });
process.send?.({ type: "ready", socket: daemon.socketPath });
process.on("message", message => {
  if (message === "stop") void daemon.stop().then(() => process.exit(0));
  else reads?.postMessage({ type: message });
});
