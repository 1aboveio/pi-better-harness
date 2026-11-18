import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";

// Only the original mixed-history regression starts this entrypoint.
const fs = createRequire(import.meta.url)("node:fs");
const readFileSync = fs.readFileSync;
const evidence = { total: 0, dropped: 0, reads: [] };
fs.readFileSync = function(path, ...args) {
  let value, failure;
  try {
    value = readFileSync.call(this, path, ...args);
    return value;
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (typeof path === "string" && basename(path) === "meta.json"
          && new Error().stack?.includes("BackgroundHistory.refresh")) {
        evidence.total++;
        const id = basename(dirname(path));
        if (evidence.reads.length < 16) evidence.reads.push({ sequence: evidence.total,
          id: id.slice(0, 128), idTruncated: id.length > 128,
          ...(failure ? { error: failure.code ?? "read-failed" } : {
            bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") }) });
        else evidence.dropped++;
      }
    } catch {}
  }
};
syncBuiltinESMExports();
const { WorkReadModel } = await import("../../src/runtime/read-model.ts");
const descriptor = Object.getOwnPropertyDescriptor(WorkReadModel.prototype, "metrics");
Object.defineProperty(WorkReadModel.prototype, "metrics", { ...descriptor, get() {
  return { ...descriptor.get.call(this), historyMetadataEvidence: { ...evidence, reads: [...evidence.reads] } };
} });
await import("../../src/runtime/query-worker.mjs");
