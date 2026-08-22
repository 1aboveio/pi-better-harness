import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceFiles = [
  "index.ts",
  "test-support/index.ts",
  "test-support/fake-remote-runner.ts",
];
const consumerDirectories = [
  "packages/pi-better-background-tasks/src/shared-ssh-core",
];

export function syncSharedSshCore(root = resolve(import.meta.dirname, "..")) {
  const sourceRoot = resolve(root, "packages/ssh-core");

  for (const consumerDirectory of consumerDirectories) {
    const targetRoot = resolve(root, consumerDirectory);
    rmSync(targetRoot, { recursive: true, force: true });
    for (const relativePath of sourceFiles) {
      const source = resolve(sourceRoot, relativePath);
      const target = resolve(targetRoot, relativePath);
      const banner = `// Generated from packages/ssh-core/${relativePath}. Do not edit directly.\n`;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${banner}${readFileSync(source, "utf8")}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  syncSharedSshCore();
}
