import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "packages/log-utils/index.ts");
const banner = "// Generated from packages/log-utils/index.ts. Do not edit directly.\n";
const targets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-log-utils.ts"),
  resolve(root, "packages/pi-better-subagents/shared-log-utils.ts"),
];
const content = `${banner}${readFileSync(source, "utf8")}`;

for (const target of targets) {
  writeFileSync(target, content);
}