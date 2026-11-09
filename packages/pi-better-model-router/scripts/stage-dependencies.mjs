import { createRequire } from "node:module";
import { cpSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm workspaces hoist dependencies; Pi's manifest needs a package-local path.
// Copy the installed, lockfile-resolved dependency before packing.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localRequire = createRequire(join(root, "package.json"));
const parentRequire = createRequire(join(dirname(root), "package.json"));
const target = join(root, "node_modules", "pi-ollama-cloud");
let source;
try {
  source = dirname(parentRequire.resolve("pi-ollama-cloud/package.json"));
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
  source = dirname(localRequire.resolve("pi-ollama-cloud/package.json"));
}
if (realpathSync(source) !== target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
