import { Worker } from "node:worker_threads";
import { startDaemon } from "../../src/server.ts";

// Kill the actual read worker on its first query, exercising executor exit handling.
const postMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function(message, ...args) {
  if (message?.type === "query") { void this.terminate(); return; }
  return postMessage.call(this, message, ...args);
};
const daemon = await startDaemon({ runtimeIdleMs: 100, startupGraceMs: 0 });
process.send?.({ socketPath: daemon.socketPath });
await daemon.closed;
process.disconnect?.();
