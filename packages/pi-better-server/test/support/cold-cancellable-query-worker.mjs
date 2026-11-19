// Deliberately exceed the short caller deadline without exceeding the watchdog.
const { parentPort } = await import("node:worker_threads");
const deferred = [];
const buffer = message => {
  if (["query", "cancel"].includes(message.type)) deferred.push(message);
};
parentPort.on("message", buffer);
await new Promise(resolve => setTimeout(resolve, 600));
await import("./cancellable-query-worker.mjs");
// That module installs RPC at the end of evaluation, with no later async work.
// Transfer the mailbox in this continuation before another message can arrive.
parentPort.off("message", buffer);
for (const message of deferred) parentPort.emit("message", message);
