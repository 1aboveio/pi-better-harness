import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const logUtilsSource = resolve(root, "packages/log-utils/index.ts");
const navigatorSource = resolve(root, "packages/navigator/index.ts");
const banner = "// Generated from packages/log-utils/index.ts. Do not edit directly.\n";
const logUtilsTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-log-utils.ts"),
  resolve(root, "packages/pi-better-subagents/shared-log-utils.ts"),
];
const navigatorTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-navigator.ts"),
  resolve(root, "packages/pi-better-subagents/shared-navigator.ts"),
];
const logUtilsContent = `${banner}${readFileSync(logUtilsSource, "utf8")}`;
const navigatorContent = readFileSync(navigatorSource, "utf8");

for (const target of logUtilsTargets) {
  writeFileSync(target, logUtilsContent);
}

for (const target of navigatorTargets) {
  writeFileSync(target, navigatorContent);
}