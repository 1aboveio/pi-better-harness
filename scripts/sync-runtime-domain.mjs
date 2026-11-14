import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "packages/pi-better-server/src/runtime/domain");
mkdirSync(target, { recursive: true });
writeFileSync(join(root, "packages/pi-better-subagents/shared-work-client.mjs"), readFileSync(join(root, "packages/pi-better-server/src/runtime/work-client.mjs")));
for (const [name, source] of [
  ["assignment-projection.mjs", "packages/pi-better-subagents/assignment-projection.mjs"],
  ["assignment-observation.mjs", "packages/operation-coordinator/assignment-observation.mjs"],
]) {
  const text = readFileSync(join(root, source), "utf8").replace("./shared-operation-coordinator/assignment-observation.mjs", "./assignment-observation.mjs");
  writeFileSync(join(target, name), `// Generated from ${source}. Do not edit directly.\n${text}`);
}
