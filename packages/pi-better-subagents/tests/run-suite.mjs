import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// npm passes optional Node test-runner flags after the script name. Node
// requires them before the test paths, including --test-shard in CI.
const files = readdirSync("tests").filter(name => name.endsWith(".test.mjs")).sort();
if (!files.length) throw new Error("No subagent test files found");
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--import", "./tests/isolate-registry.mjs", "--test",
  ...process.argv.slice(2), ...files.map(name => `tests/${name}`),
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
