// Deliberately exceed the short caller deadline without exceeding the watchdog.
await new Promise(resolve => setTimeout(resolve, 600));
await import("./cancellable-query-worker.mjs");
