import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise the shipped staging script and npm bundle without touching workspace dependencies or running sync hooks. */
export function installedHarnessFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-installed-harness-"));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  try {
    cpSync(join(repo, "packages"), join(root, "packages"), {
      recursive: true, filter: (source) => basename(source) !== "node_modules",
    });
    mkdirSync(join(root, "scripts"));
    cpSync(join(repo, "scripts/stage-harness-dependencies.mjs"), join(root, "scripts/stage-harness-dependencies.mjs"));
    const env = { ...process.env, npm_config_ignore_scripts: "true" };
    execFileSync(process.execPath, [join(root, "scripts/stage-harness-dependencies.mjs")], {
      cwd: root, env, stdio: "pipe",
    });
    const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: join(root, "packages/pi-better-harness"), env, encoding: "utf8", stdio: "pipe",
    });
    const packed = JSON.parse(output) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", join(root, packed[0]!.filename), "-C", root], { stdio: "pipe" });
    // The SDK host and external libraries resolve normally; bundled first-party packages stay real extracted files.
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
    return { root, installed: join(root, "package"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function registeredProducerTools(source: string, cwd: string): Promise<ReturnType<ExtensionAPI["getAllTools"]>> {
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  const loaded = await discoverAndLoadExtensions([source], cwd, agentDir);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  return loaded.extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => ({
    name: tool.definition.name, description: tool.definition.description,
    parameters: tool.definition.parameters, sourceInfo: tool.sourceInfo,
  })));
}

export function bundledProducerSource(installed: string): string {
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { pi: { extensions: string[] } };
  const entry = manifest.pi.extensions.find((path) => path === "extensions/subagents/index.ts");
  if (!entry) throw new Error("Installed harness does not expose its subagents extension");
  return join(installed, entry);
}
