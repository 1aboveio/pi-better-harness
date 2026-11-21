import { symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Stage the same installed dependency tree used by the real SDK import. */
export function stageDependencies(root: string): void {
  let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (basename(directory) !== "node_modules") {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Staged runtime fixture requires an installed SDK dependency tree");
    directory = parent;
  }
  symlinkSync(directory, join(root, "node_modules"));
}
