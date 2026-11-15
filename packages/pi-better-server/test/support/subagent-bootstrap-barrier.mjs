import { existsSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";

// Test-only observer pauses the actual process before the fixed bootstrap imports.
if (process.argv[1]?.endsWith("managed-worker.mjs") && process.env.BOOTSTRAP_BARRIER) {
  const root = process.env.BOOTSTRAP_BARRIER;
  writeFileSync(`${root}/waiting`, String(process.pid));
  const watcher = watch(root);
  try { while (!existsSync(`${root}/release`)) await once(watcher, "change"); }
  finally { watcher.close(); }
}
