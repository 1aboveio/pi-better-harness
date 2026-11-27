import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntime } from "../packages/pi-better-subagents/runtime-client/src/runtime/client.mjs";
import { decodeServerArtifact } from "../packages/pi-better-server/src/startup/artifact.ts";
import { digest, NODE_CHECKSUMS, NODE_EXECUTABLE_CHECKSUMS } from "../packages/pi-better-server/scripts/private-runtime/format.ts";

const platform = "win32-x64";
assert.equal(`${process.platform}-${process.arch}`, platform);
const root = fileURLToPath(new URL("../packages/", import.meta.url));
let build;
for (const name of ["pi-better-subagents", "pi-better-background-tasks"]) {
  const prefix = join(root, name, "runtime-client", "artifacts", platform);
  const manifest = JSON.parse(readFileSync(prefix + ".json", "utf8"));
  const payload = decodeServerArtifact({ ...manifest, bytes: readFileSync(prefix + ".gz") });
  assert.equal(payload.build.platform, platform);
  if (build) assert.deepEqual(payload.build, build);
  build = payload.build;
}

const distribution = `node-v${build.nodeVersion}-win-x64`;
const response = await fetch(`https://nodejs.org/dist/v${build.nodeVersion}/${distribution}.zip`, {
  signal: AbortSignal.timeout(120_000),
});
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(digest(bytes), NODE_CHECKSUMS[platform]);
const staging = mkdtempSync(join(tmpdir(), "pi Windows runtime "));
try {
  // The artifact can ship before the native installer and service are available.
  await assert.rejects(ensureRuntime({ agentDir: staging }), /native Windows managed-service installation/);
  const archive = join(staging, "node.zip");
  writeFileSync(archive, bytes);
  execFileSync("tar.exe", ["-xf", archive, `${distribution}/node.exe`], { cwd: staging });
  const node = join(staging, distribution, "node.exe");
  assert.equal(digest(readFileSync(node)), NODE_EXECUTABLE_CHECKSUMS[platform]);
  assert.equal(execFileSync(node, ["--version"], { encoding: "utf8" }).trim(), `v${build.nodeVersion}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
