import { cpSync } from "node:fs";
import { basename, join } from "node:path";

const [root, prefix] = process.argv.slice(2);
if (!root || !prefix) throw new Error("Usage: copy-pi-test-providers.mjs <workspace> <prefix>");
for (const name of ["pi-better-subagents", "pi-better-background-tasks", "pi-better-sandbox", "operation-coordinator", "pi-better-goal"]) {
  cpSync(join(root, "packages", name), join(prefix, "packages", name), {
    recursive: true, filter: path => !["node_modules", ".work", ".pi-compat"].includes(basename(path)),
  });
}
