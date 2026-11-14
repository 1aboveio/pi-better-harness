import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

// Keep a losing coordinator's real scratch claim visible until the winner
// inventories the namespace. No owner identity or reservation is replaced.
const unlink = fs.unlinkSync;
fs.unlinkSync = function(path) {
  if (process.argv.includes("activation-worker") && /\/\.activation-owner-[^/]+\/owner-/.test(String(path))) {
    fs.writeFileSync(join(process.env.PI_FAKE_GATE_DIR, "claim.started"), "1");
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(join(process.env.PI_SERVER_DIR, "activation.json"))) {
      if (Date.now() >= deadline) throw new Error("No winning activation journal during claim cleanup");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  return unlink.apply(this, arguments);
};
syncBuiltinESMExports();
