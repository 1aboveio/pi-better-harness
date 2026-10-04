import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "./atomic-write.mjs";

const files = {
  "index.ts": "shared-task-sandbox.ts", "files.ts": "shared-task-files.ts",
  "apply-patch.ts": "shared-task-apply-patch.ts", "tools.ts": "shared-task-tools.ts",
  "process-list.ts": "shared-task-process-list.ts",
};
const consumers = ["pi-better-sandbox", "pi-better-subagents"];
export function taskSandboxCopies(root = resolve(import.meta.dirname, "..")) {
  return Object.entries(files).flatMap(([source, target]) => {
    const content = `// Generated from packages/task-sandbox/${source}. Do not edit directly.\n` +
      readFileSync(resolve(root, "packages/task-sandbox", source), "utf8")
        .replaceAll('"../sandbox-core/index.ts"', '"./shared-sandbox-core.ts"')
        .replaceAll('"./files.ts"', '"./shared-task-files.ts"')
        .replaceAll('"./apply-patch.ts"', '"./shared-task-apply-patch.ts"')
        .replaceAll('"./tools.ts"', '"./shared-task-tools.ts"')
        .replaceAll('"./process-list.ts"', '"./shared-task-process-list.ts"');
    return consumers.map((consumer) => ({ path: resolve(root, "packages", consumer, target), content }));
  });
}
export function syncTaskSandbox(root) {
  for (const { path, content } of taskSandboxCopies(root)) writeFileAtomically(path, content);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) syncTaskSandbox();
