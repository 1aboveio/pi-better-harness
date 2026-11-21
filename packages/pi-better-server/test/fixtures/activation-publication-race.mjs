import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Delay only OS publication boundaries in the owned child processes. The real
// daemon, maintenance lease, journal, dialog and successor run unchanged.
const rename = fs.renameSync;
const rmdir = fs.rmdirSync;
const read = fs.readFileSync;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let prepared = 0;
let observations = 0;
fs.readFileSync = function(path) {
  const result = read.apply(this, arguments);
  if (process.argv.includes("activation-worker") && String(path).endsWith("/activation.json")) {
    const journal = JSON.parse(String(result));
    if (journal.operationId === "dialog-upgrade" && journal.phase === "prepared" && ++observations === 2) {
      fs.writeFileSync(`${process.env.PI_FAKE_GATE_DIR}/publication.started`, "1");
    }
  }
  return result;
};
fs.renameSync = function(from, to) {
  if (process.argv.includes("activation-worker") && String(to).endsWith("/activation.json")) {
    const next = JSON.parse(fs.readFileSync(from, "utf8"));
    if (next.operationId === "dialog-upgrade" && next.phase === "prepared" && ++prepared === 2) {
      const deadline = Date.now() + 10_000;
      while (JSON.parse(fs.readFileSync(to, "utf8")).phase !== "stopping") {
        if (Date.now() >= deadline) throw new Error("Daemon did not commit its stop during publication race");
        pause(5);
      }
    }
  }
  return rename.apply(this, arguments);
};
fs.rmdirSync = function(path) {
  const result = rmdir.apply(this, arguments);
  // Releasing the claim precedes process exit. Keep that real interval visible
  // on macOS as well as Linux, where an exited process may remain a zombie.
  if (String(path).endsWith("/daemon-owner") && process.env.PI_SERVER_ACTIVATION_ID === "initial") pause(2_000);
  return result;
};
syncBuiltinESMExports();
