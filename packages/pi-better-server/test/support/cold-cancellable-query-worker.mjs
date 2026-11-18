// Deliberately exceed the short caller deadline without exceeding the watchdog.
const { parentPort } = await import("node:worker_threads");
const deferred = [];
const buffer = message => {
  if (["query", "cancel"].includes(message.type)) deferred.push(message);
};
parentPort.on("message", buffer);
await new Promise(resolve => setTimeout(resolve, 600));
// Stop capture before RPC installation so already-owned messages cannot replay twice.
parentPort.off("message", buffer);
await import("./cancellable-query-worker.mjs");
for (const message of deferred) parentPort.emit("message", message);
