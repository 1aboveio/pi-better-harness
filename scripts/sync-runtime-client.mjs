import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerArtifact } from "../packages/pi-better-server/src/startup/artifact.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "packages/pi-better-server");
const artifacts = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map(platform => createServerArtifact({ platform }));
for (const name of ["pi-better-subagents", "pi-better-background-tasks"]) {
  const target = join(root, "packages", name, "runtime-client");
  rmSync(target, { recursive: true, force: true });
  for (const path of ["src/runtime/client.ts", "src/runtime/root.ts", "src/runtime/socket.ts", "src/runtime/status-cli.ts", "src/daemon-owner.ts",
    "src/startup/artifact.ts", "src/startup/install.ts", "src/startup/runtime.ts", "src/startup/managed-types.ts", "scripts/private-runtime/format.ts"]) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    const output = ts.transpileModule(readFileSync(join(source, path), "utf8"), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
    } }).outputText.replaceAll(/(from\s+["'][^"']+)\.js(["'])/g, "$1.mjs$2").replaceAll(/(import\(["'][^"']+)\.js(["'])/g, "$1.mjs$2");
    writeFileSync(join(target, path.replace(/\.ts$/, ".mjs")), output);
  }
  mkdirSync(join(target, "artifacts"), { recursive: true });
  for (const { build, bytes, sha256 } of artifacts) {
    writeFileSync(join(target, "artifacts", `${build.platform}.gz`), bytes);
    writeFileSync(join(target, "artifacts", `${build.platform}.json`), JSON.stringify({ build, sha256 }));
  }
}
