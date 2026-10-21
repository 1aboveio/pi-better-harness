import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServerArtifact, decodeServerArtifact, ownPackageDir, readStagedRuntime } from "../src/startup/artifact.ts";
import { digest, stable } from "../scripts/private-runtime/format.ts";

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "pi-artifact-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/cli.ts"), "export const cli = true;\n");
  writeFileSync(join(root, "src/server.ts"), "export const server = true;\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }));
  cpSync(join(ownPackageDir, "scripts/private-runtime"), join(root, "scripts/private-runtime"), { recursive: true });
  return root;
}
test("artifact identity tracks unpublished source and target, ignores formatting and unrelated files", (t) => {
  const packageDir = fixture(t);
  const options = { platform: "linux-x64" as const, packageDir };
  const first = createServerArtifact(options);
  writeFileSync(join(packageDir, "package.json"), '{ "version": "1.0.0", "type": "module", "name": "fixture" }');
  writeFileSync(join(packageDir, "private-notes.txt"), "must not ship");
  mkdirSync(join(packageDir, "src/node_modules"));
  writeFileSync(join(packageDir, "src/node_modules/secret"), "must not ship");
  writeFileSync(join(packageDir, "src/.env"), "must not ship");
  writeFileSync(join(packageDir, "src/auth.json"), "must not ship");
  const second = createServerArtifact(options);
  assert.deepEqual(second.bytes, first.bytes);
  assert.notEqual(createServerArtifact({ ...options, platform: "linux-arm64" }).build.contentId, first.build.contentId);
  writeFileSync(join(packageDir, "src/server.ts"), "export const server = 'changed';\n");
  assert.notEqual(createServerArtifact(options).build.contentId, first.build.contentId);
  assert.equal(decodeServerArtifact(first).files.some((f) => f.path.includes("node_modules") || f.path.endsWith(".env") || f.path.endsWith("auth.json")), false);
});
test("artifact rejects symlink source and corrupt compressed data", (t) => {
  const packageDir = fixture(t);
  const artifact = createServerArtifact({ platform: "linux-x64", packageDir });
  artifact.bytes[20] = artifact.bytes[20]! ^ 1;
  assert.throws(() => decodeServerArtifact(artifact), /integrity/);
  symlinkSync("server.ts", join(packageDir, "src/link.ts"));
  assert.throws(() => createServerArtifact({ platform: "linux-x64", packageDir }), /symlink/);
});
test("artifact rejects traversal, duplicate paths, exclusions, collisions, and oversized decoded tables", (t) => {
  const packageDir = fixture(t);
  const artifact = createServerArtifact({ platform: "linux-x64", packageDir });
  for (const path of ["../escape", "/absolute", "src/../../escape", "src/node_modules/x", "src/.env.local", "src/settings.json", "src\\escape", "src/cli.ts", "src"]) {
    const payload = decodeServerArtifact(artifact);
    payload.files.push({ path, data: "eA==" });
    const bytes = gzipSync(JSON.stringify(payload));
    assert.throws(() => decodeServerArtifact({ ...artifact, bytes, sha256: digest(bytes) }), /unsafe|duplicate|collision/);
  }
  const bytes = gzipSync(Buffer.alloc(65 * 1024 * 1024, 32));
  assert.throws(() => decodeServerArtifact({ ...artifact, bytes, sha256: digest(bytes) }), /larger|length|size/i);
});
test("staged manifest must bind its paths to its build and actual manifest location", (t) => {
  const packageDir = fixture(t);
  const { build } = createServerArtifact({ platform: "linux-x64", packageDir });
  const root = join(packageDir, "releases", build.contentId);
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "runtime.json");
  const runtime = { format: 1, build, root, installRoot: packageDir, node: join(root, "node/bin/node"), entrypoint: join(root, "src/cli.ts"), manifestPath };
  writeFileSync(manifestPath, stable(runtime));
  assert.deepEqual(readStagedRuntime(manifestPath), runtime);
  writeFileSync(manifestPath, stable({ ...runtime, node: "/foreign/node" }));
  assert.throws(() => readStagedRuntime(manifestPath), /path identity/);
  writeFileSync(manifestPath, stable({ ...runtime, build: { ...build, contentId: "a".repeat(64) } }));
  assert.throws(() => readStagedRuntime(manifestPath), /identity mismatch/);
});
