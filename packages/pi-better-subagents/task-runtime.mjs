/** Trusted native entry point. Any failure before/inside guard installation is fatal. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fail = (error) => {
  process.stderr.write(`Task sandbox bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
};

try {
  const [sdkEntry, policyPath, ...args] = process.argv.slice(2);
  if (!sdkEntry || !policyPath || !isAbsolute(sdkEntry) || !isAbsolute(policyPath)) throw new Error("Missing trusted runtime paths.");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (typeof policy.agentDir !== "string" || !isAbsolute(policy.agentDir)) throw new Error("Invalid runtime agent directory.");
  process.env.PI_CODING_AGENT_DIR = policy.agentDir;
  const sdkRequire = createRequire(sdkEntry);
  const { version } = JSON.parse(readFileSync(join(dirname(sdkEntry), "..", "package.json"), "utf8"));
  const [major, minor, patch] = version.split(".").map(Number);
  if (!(major > 0 || minor > 82 || (minor === 82 && patch >= 1))) throw new Error("Task confinement requires Pi SDK 0.82.1 or newer.");
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
  const load = createJiti(import.meta.url, {
    tryNative: false, fsCache: false, moduleCache: false, interopDefault: true,
    alias: { "@earendil-works/pi-coding-agent": sdkEntry },
  });
  // Import the complete guard before invoking Pi. Unlike an ordinary CLI -e
  // extension, an import error here cannot be downgraded to a startup warning.
  const guard = await load.import(fileURLToPath(new URL("./task-guard.ts", import.meta.url)), { default: true });
  if (typeof guard !== "function") throw new Error("Task guard has no extension factory.");
  const { main } = await import(pathToFileURL(join(dirname(sdkEntry), "main.js")).href);
  await main(args, {
    extensionFactories: [{ name: "task-sandbox", factory: async (pi) => {
      try { await guard(pi, policy, fail); } catch (error) { fail(error); }
    } }],
  });
} catch (error) {
  fail(error);
}
