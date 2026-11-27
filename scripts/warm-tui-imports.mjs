import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const sdkRequire = createRequire(process.argv[3] ? realpathSync(process.argv[3]) : import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = sdkRequire("jiti");
const hostResolver = createJiti(process.argv[3] ? realpathSync(process.argv[3]) : import.meta.resolve("@earendil-works/pi-coding-agent"));

const root = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const alias = {};
for (const name of ["pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai", "pi-ai/compat", "pi-ai/oauth", "pi-ai/providers/all"]) {
  const target = fileURLToPath(hostResolver.esmResolve(`@earendil-works/${name === "pi-ai" ? "pi-ai/compat" : name}`));
  alias[`@earendil-works/${name}`] = target;
  alias[`@mariozechner/${name}`] = target;
}
for (const name of ["typebox", "typebox/compile", "typebox/value"]) {
  alias[name] = sdkRequire.resolve(name);
  alias[`@sinclair/${name}`] = alias[name];
}
const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
for (const entry of manifest.pi.extensions) {
  const started = performance.now();
  const factory = await jiti.import(resolve(root, entry), { default: true });
  if (typeof factory !== "function") throw new Error(`No extension factory: ${entry}`);
  console.log(`${entry}: ${Math.round(performance.now() - started)}ms`);
}