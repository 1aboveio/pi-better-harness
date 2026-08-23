import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = join(root, "packages/pi-better-harness");
const packageNames = [
  "pi-better-background-tasks",
  "pi-better-goal",
  "pi-better-sandbox",
  "pi-better-subagents",
];

export function selectPackedResult(packOutput) {
  const parsed = JSON.parse(packOutput);
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed?.filename) return parsed;
  return Object.values(parsed).find((value) => value?.filename);
}

function stageHarnessDependencies() {
  const stagingDir = mkdtempSync(join(tmpdir(), "pi-better-harness-pack-"));
  try {
    for (const packageName of packageNames) {
      const packageDir = join(root, "packages", packageName);
      const packOutput = execFileSync(
        "npm",
        ["pack", "--dry-run=false", "--json", "--pack-destination", stagingDir, packageDir],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      const packed = selectPackedResult(packOutput);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stageHarnessDependencies();
}