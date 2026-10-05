import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "harness-settings-pack-"));
try {
  const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--json", "--pack-destination", dir, "-w", "packages/pi-better-harness"], {
    cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"],
  });
  const packed = selectPackedResult(output);
  if (!packed?.filename) throw new Error("Harness pack did not return a tarball");
  const sdkRoot = process.env.PI_CODEMODE_TEST_SDK_DIR ?? resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const sdkVersion = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "harness-settings-install-smoke", private: true,
    dependencies: { "@earendil-works/pi-coding-agent": sdkVersion } }));
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", join(dir, packed.filename)], {
    cwd: dir, shell: process.platform === "win32", stdio: "inherit",
  });
  const installed = join(dir, "node_modules", "pi-better-harness");
  execFileSync(process.execPath, ["--import", "tsx", "--import", "./scripts/isolate-registry.mjs", "--test", "scripts/harness-settings.tui.e2e.test.mjs"], {
    cwd: root, env: { ...process.env, PI_HARNESS_SETTINGS_PACKAGE_DIR: installed }, stdio: "inherit",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}