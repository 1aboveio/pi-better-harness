import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = join(root, "packages/pi-better-harness");
const stagingDir = mkdtempSync(join(tmpdir(), "pi-better-harness-pack-"));
const packageNames = [
  "pi-better-background-tasks",
  "pi-better-goal",
  "pi-better-subagents",
];

try {
  for (const packageName of packageNames) {
    const packageDir = join(root, "packages", packageName);
    const packOutput = execFileSync(
      "npm",
      ["pack", "--dry-run=false", "--json", "--pack-destination", stagingDir, packageDir],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const [packed] = JSON.parse(packOutput);
    if (!packed?.filename) {
      throw new Error(`npm pack did not return a tarball for ${packageName}`);
    }

    const targetDir = join(harnessDir, "node_modules", packageName);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    execFileSync(
      "tar",
      ["-xzf", join(stagingDir, packed.filename), "--strip-components=1", "-C", targetDir],
      { stdio: "inherit" },
    );
  }
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}