import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = join(root, "packages/pi-better-harness");

/**
 * The components the Harness bundle ships. `harness-default-capability.test.mjs`
 * asserts this is exactly the packaged `bundledDependencies`, so a retired
 * component cannot linger here and a new one cannot be silently skipped.
 */
export const stagedPackageNames = [
  "pi-better-background-tasks",
  "pi-better-goal",
  "pi-better-sandbox",
  "pi-better-ssh",
  "pi-better-subagents",
];

export function selectPackedResult(packOutput) {
  const parsed = JSON.parse(packOutput);
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed?.filename) return parsed;
  return Object.values(parsed).find((value) => value?.filename);
}

function packPackage(packageDir, stagingDir, ignoreScripts) {
  const args = ["pack", "--dry-run=false", "--json", "--pack-destination", stagingDir];
  if (ignoreScripts) args.push("--ignore-scripts");
  args.push(packageDir);
  const packOutput = execFileSync("npm", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return selectPackedResult(packOutput);
}

/**
 * Pack every bundled component and unpack it into the Harness package's
 * node_modules, so `npm pack -w packages/pi-better-harness` bundles the real
 * published components instead of workspace symlinks.
 *
 * `ignoreScripts` skips each component's `prepack` sync. Prepublish keeps the
 * default so published copies are freshly synchronized; tests set it so reading
 * the packed artifact never rewrites tracked files in another package.
 */
export function stageHarnessDependencies({ harnessRoot = harnessDir, ignoreScripts = false } = {}) {
  const stagingDir = mkdtempSync(join(tmpdir(), "pi-better-harness-pack-"));
  const nodeModulesDir = join(harnessRoot, "node_modules");
  try {
    for (const packageName of stagedPackageNames) {
      const packed = packPackage(join(root, "packages", packageName), stagingDir, ignoreScripts);
      if (!packed?.filename) {
        throw new Error(`npm pack did not return a tarball for ${packageName}`);
      }

      const targetDir = join(nodeModulesDir, packageName);
      rmSync(targetDir, { recursive: true, force: true });
      mkdirSync(targetDir, { recursive: true });
      execFileSync(
        "tar",
        ["-xzf", join(stagingDir, packed.filename), "--strip-components=1", "-C", targetDir],
        { stdio: "inherit" },
      );
    }

    // A component that is no longer bundled (retired Plan) must not stay staged:
    // a stale copy is packed again the moment a dependency of that name returns.
    if (existsSync(nodeModulesDir)) {
      for (const entry of readdirSync(nodeModulesDir)) {
        if (entry.startsWith("pi-better-") && !stagedPackageNames.includes(entry)) {
          rmSync(join(nodeModulesDir, entry), { recursive: true, force: true });
        }
      }
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stageHarnessDependencies();
}
