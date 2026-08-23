import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceFile = "index.ts";
// Single-file targets, not directories: `pi-better-subagents` packs `*.ts` from
// its package root, so a vendored subdirectory would be dropped from the tarball.
const consumerTargets = [
  "packages/pi-better-subagents/shared-sandbox-core.ts",
  "packages/pi-better-sandbox/shared-sandbox-core.ts",
  // `pi-better-background-tasks` packs `src/**/*.ts` instead, so its copy is a
  // root-level file inside `src/`. It must never land in `src/shared-ssh-core/`
  // or overwrite `src/shared-log-utils.ts` — those are other modules' vendored
  // copies with their own sync scripts.
  "packages/pi-better-background-tasks/src/shared-sandbox-core.ts",
];

export const sharedSandboxCoreBanner =
  `// Generated from packages/sandbox-core/${sourceFile}. Do not edit directly.\n`;

/** The exact bytes every vendored copy must contain. */
export function sharedSandboxCoreContent(root = resolve(import.meta.dirname, "..")) {
  const source = resolve(root, "packages/sandbox-core", sourceFile);
  return `${sharedSandboxCoreBanner}${readFileSync(source, "utf8")}`;
}

/** Absolute paths of every generated vendored copy. */
export function sharedSandboxCoreTargets(root = resolve(import.meta.dirname, "..")) {
  return consumerTargets.map((target) => resolve(root, target));
}

export function syncSharedSandboxCore(root = resolve(import.meta.dirname, "..")) {
  const content = sharedSandboxCoreContent(root);
  for (const target of sharedSandboxCoreTargets(root)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  syncSharedSandboxCore();
}
