import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomically } from "./atomic-write.mjs";

const root = resolve(import.meta.dirname, "..");
const logUtilsSource = resolve(root, "packages/log-utils/index.ts");
const navigatorSource = resolve(root, "packages/navigator/index.ts");
const renderSchedulerSource = resolve(root, "packages/render-scheduler/index.ts");
const stallDetectorSource = resolve(root, "packages/stall-detector/index.ts");
const failureObservationsSource = resolve(root, "packages/failure-observations/index.ts");
const permissionBlockerSource = resolve(root, "packages/failure-observations/permission-blocker.ts");
const callbackBatcherSource = resolve(root, "packages/callback-batcher/index.ts");
const harnessSettingsSource = resolve(root, "packages/harness-settings/index.ts");
const harnessSettingsTargets = [
  "packages/callback-batcher/shared-harness-settings.ts",
  "packages/pi-better-subagents/shared-harness-settings.ts",
  "packages/pi-better-background-tasks/src/shared-harness-settings.ts",
  "packages/pi-better-goal/src/shared-harness-settings.ts",
  "packages/pi-better-sandbox/shared-harness-settings.ts",
  "packages/pi-better-harness/extensions/shared-harness-settings.ts",
];
const banner = "// Generated from packages/log-utils/index.ts. Do not edit directly.\n";
const logUtilsTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-log-utils.ts"),
  resolve(root, "packages/pi-better-subagents/shared-log-utils.ts"),
];
const navigatorTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-navigator.ts"),
  resolve(root, "packages/pi-better-subagents/shared-navigator.ts"),
];
const renderSchedulerTargets = [
  resolve(root, "packages/navigator/shared-render-scheduler.ts"),
  resolve(root, "packages/pi-better-background-tasks/src/shared-render-scheduler.ts"),
  resolve(root, "packages/pi-better-subagents/shared-render-scheduler.ts"),
  resolve(root, "packages/pi-better-goal/src/shared-render-scheduler.ts"),
];
const stallDetectorTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-stall-detector.ts"),
  resolve(root, "packages/pi-better-subagents/shared-stall-detector.ts"),
  resolve(root, "packages/pi-better-goal/src/shared-stall-detector.ts"),
];
const failureObservationsTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-failure-observations.ts"),
  resolve(root, "packages/pi-better-subagents/shared-failure-observations.ts"),
];
const callbackBatcherTargets = [
  resolve(root, "packages/pi-better-background-tasks/src/shared-callback-batcher.ts"),
  resolve(root, "packages/pi-better-subagents/shared-callback-batcher.ts"),
];
const logUtilsContent = `${banner}${readFileSync(logUtilsSource, "utf8")}`;
const permissionBlockerTargets = [
  resolve(root, "packages/pi-better-subagents/shared-permission-blocker.ts"),
  resolve(root, "packages/pi-better-sandbox/shared-permission-blocker.ts"),
  resolve(root, "packages/pi-better-background-tasks/src/shared-permission-blocker.ts"),
  resolve(root, "packages/pi-better-goal/src/shared-permission-blocker.ts"),
];
const navigatorContent = readFileSync(navigatorSource, "utf8");
const renderSchedulerContent = `// Generated from packages/render-scheduler/index.ts. Do not edit directly.\n${readFileSync(renderSchedulerSource, "utf8")}`;
const stallDetectorContent = `// Generated from packages/stall-detector/index.ts. Do not edit directly.\n${readFileSync(stallDetectorSource, "utf8")}`;
const callbackBatcherContent = `// Generated from packages/callback-batcher/index.ts. Do not edit directly.\n${readFileSync(callbackBatcherSource, "utf8")}`;

for (const target of harnessSettingsTargets) {
  writeFileAtomically(resolve(root, target), `// Generated from packages/harness-settings/index.ts. Do not edit directly.\n${readFileSync(harnessSettingsSource, "utf8")}`);
}

for (const target of logUtilsTargets) {
  writeFileAtomically(target, logUtilsContent);
}

for (const target of navigatorTargets) {
  writeFileAtomically(target, navigatorContent);
}

for (const target of renderSchedulerTargets) {
  writeFileAtomically(target, renderSchedulerContent);
}

for (const target of stallDetectorTargets) {
  writeFileAtomically(target, stallDetectorContent);
}

for (const target of failureObservationsTargets) {
  const source = readFileSync(failureObservationsSource, "utf8").replaceAll('"./permission-blocker.ts"', '"./shared-permission-blocker.ts"');
  writeFileAtomically(target, `// Generated from packages/failure-observations/index.ts. Do not edit directly.\n${source}`);
}

for (const target of permissionBlockerTargets) {
  writeFileAtomically(target, `// Generated from packages/failure-observations/permission-blocker.ts. Do not edit directly.\n${readFileSync(permissionBlockerSource, "utf8")}`);
}

for (const target of callbackBatcherTargets) {
  writeFileAtomically(target, callbackBatcherContent);
}