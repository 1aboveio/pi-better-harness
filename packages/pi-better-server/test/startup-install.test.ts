import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServerArtifact, ownPackageDir, readStagedRuntime } from "../src/startup/artifact.ts";
import { digest } from "../scripts/private-runtime/format.ts";
import { stageRuntime } from "../src/startup/install.ts";
import type { RunRemote, RuntimePlatform } from "../src/startup/managed-types.ts";
import { privateRuntimeNode } from "./private-runtime-node.ts";

function execute(command: string, args: string[], env: NodeJS.ProcessEnv, input?: Buffer, onStderr?: (text: string) => void) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; onStderr?.(String(chunk)); });
    child.on("error", reject); child.stdin.on("error", () => undefined);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr })); child.stdin.end(input);
  });
}
function unseal(root: string) {
  if (!existsSync(root)) return;
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) unseal(join(root, entry.name));
}
function fixture(t: any) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-test-")));
  t.after(() => { unseal(home); rmSync(home, { recursive: true, force: true }); });
  const pkg = join(home, "source");
  mkdirSync(join(pkg, "src"), { recursive: true });
  cpSync(join(ownPackageDir, "scripts/private-runtime"), join(pkg, "scripts/private-runtime"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "installer-fixture", version: "1.0.0", type: "module" }));
  writeFileSync(join(pkg, "src/cli.ts"), "throw new Error('staging must not start the CLI');");
  writeFileSync(join(pkg, "src/server.ts"), `import {readdirSync} from 'node:fs'; if (process.env.EXTERNAL_SECRET || !process.env.PI_CODING_AGENT_DIR.endsWith('/home/agent') || readdirSync(process.env.PI_CODING_AGENT_DIR).length) throw new Error('isolation failed'); export const imported = true;`);
  const artifact = createServerArtifact({ platform: `${process.platform}-${process.arch}` as RuntimePlatform, packageDir: pkg });
  const root = join(home, "managed"); mkdirSync(root);
  const trace = join(home, "npm-installs");
  function work(name: string, nodeVersion?: string) {
    const privateNode = privateRuntimeNode();
    const path = join(root, name); mkdirSync(join(path, "node/bin"), { recursive: true });
    let versionArgs = "";
    if (nodeVersion) {
      // Only the mismatch rejection test overrides the real binary's version.
      const preload = join(path, "node", "fixture-version.mjs");
      writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });`);
      versionArgs = ` --import '${preload.replaceAll("'", `'"'"'`)}'`;
    }
    writeFileSync(join(path, "node/bin/node"), `#!/bin/sh\nexec '${privateNode.node.replaceAll("'", `'"'"'`)}'${versionArgs} "$@"\n`, { mode: 0o755 });
    const npm = join(path, "node/lib/node_modules/npm/bin"); mkdirSync(npm, { recursive: true });
    // npm is the external boundary here. The real pinned npm/SDK closure is exercised by the opt-in integration below.
    writeFileSync(join(npm, "npm-cli.js"), `const fs=require('node:fs'); const p=require('node:path'); if (!process.argv.includes('--ignore-scripts')) throw Error('scripts allowed'); fs.appendFileSync(${JSON.stringify(trace)}, 'install\\n'); const d=p.join(process.cwd(),'node_modules/@earendil-works/pi-coding-agent');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.2.0',type:'module',main:'index.js'}));fs.writeFileSync(p.join(d,'index.js'),"export const VERSION='1.2.0';");`);
    writeFileSync(join(path, "artifact.gz"), artifact.bytes);
    for (const name of ["installer.ts", "format.ts"]) copyFileSync(join(pkg, "scripts/private-runtime", name), join(path, name));
    return path;
  }
  const install = (path: string, onStderr?: (text: string) => void) => execute(join(path, "node/bin/node"), [join(path, "installer.ts"), path, root, artifact.sha256, "online"], { HOME: home, PATH: process.env.PATH, EXTERNAL_SECRET: "must-be-cleared" }, undefined, onStderr);
  return { home, root, artifact, trace, work, install };
}

test("first install and same-build connectors publish once, isolate imports, and reject corrupted cache", async (t) => {
  const setup = fixture(t);
  mkdirSync(join(setup.home, ".pi/agent/packages"), { recursive: true });
  const untouched = new Map<string, Buffer>();
  for (const [path, data] of [[".pi/remote-server.json", "invalid registration stays untouched"], [".pi/agent/auth.json", "synthetic auth bytes"], [".pi/agent/settings.json", "synthetic settings bytes"], [".pi/agent/packages/package.txt", "installed package bytes"]]) {
    const full = join(setup.home, path!); const bytes = Buffer.from(data!); writeFileSync(full, bytes); untouched.set(full, bytes);
  }
  const outcomes = await Promise.all([setup.install(setup.work("one")), setup.install(setup.work("two"))]);
  for (const result of outcomes) assert.equal(result.exitCode, 0, result.stderr);
  const runtime = JSON.parse(outcomes[0]!.stdout);
  assert.deepEqual(JSON.parse(outcomes[1]!.stdout), runtime);
  assert.deepEqual(readStagedRuntime(runtime.manifestPath), runtime);
  assert.equal(readFileSync(setup.trace, "utf8"), "install\n");
  assert.equal(existsSync(join(setup.home, ".pi/agent/server")), false);
  for (const [path, bytes] of untouched) assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
  const sdk = join(runtime.root, "node_modules/@earendil-works/pi-coding-agent/index.js");
  chmodSync(sdk, 0o600); writeFileSync(sdk, "corrupt cached SDK");
  const corrupted = await setup.install(setup.work("three"));
  assert.notEqual(corrupted.exitCode, 0);
  assert.match(corrupted.stderr, /corrupt cache.*integrity/);
  assert.equal(readFileSync(sdk, "utf8"), "corrupt cached SDK", "staging does not repair or overwrite a published build");
});

test("installer rejects a runtime whose Node version differs from its artifact", async t => {
  const setup = fixture(t);
  const result = await setup.install(setup.work("wrong-node", "22.0.0"));
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Node version mismatch/);
  assert.equal(existsSync(join(setup.root, "releases", setup.artifact.build.contentId)), false);
});

test("cancelled install removes only its candidate and releases its owner lock", async (t) => {
  const setup = fixture(t);
  const path = setup.work("cancelled"); writeFileSync(join(path, "cancel"), "");
  const result = await setup.install(path);
  assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /cancelled/);
  assert.equal(existsSync(join(setup.root, "releases", setup.artifact.build.contentId)), false);
});

test("an old live-owner lock survives a waiting connector's cancellation", { timeout: 15_000 }, async (t) => {
  const setup = fixture(t);
  const lock = join(setup.root, "locks", setup.artifact.build.contentId);
  mkdirSync(lock, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, work: "another connector" });
  writeFileSync(join(lock, "owner.json"), owner);
  utimesSync(lock, new Date(0), new Date(0));
  const work = setup.work("waiter");
  const result = await setup.install(work, (text) => { if (text.includes("Waiting for runtime build owner")) writeFileSync(join(work, "cancel"), ""); });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /installation cancelled/);
  assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), owner);
  assert.equal(existsSync(work), false);
  assert.equal(existsSync(setup.trace), false);
});

test("stage refuses corrupt artifacts, explicit opt-out, and platform mismatch before creating directories", async (t) => {
  const setup = fixture(t);
  let commands = 0;
  const run: RunRemote = async () => { commands++; return { exitCode: 0, stdout: `${setup.home}\nLinux\nx86_64\n/explicit/launcher\nabsent\n`, stderr: "" }; };
  await assert.rejects(stageRuntime({ run, artifact: { ...setup.artifact, sha256: "bad" } }), /integrity/);
  assert.equal(commands, 0);
  await assert.rejects(stageRuntime({ run, artifact: setup.artifact }), /opts out/);
  assert.equal(commands, 1);
  await assert.rejects(stageRuntime({ run: async () => ({ exitCode: 0, stdout: `${setup.home}\nLinux\ns390x\n\nabsent\n`, stderr: "" }), artifact: setup.artifact }), /unsupported platform/);
  assert.deepEqual(readdirSync(setup.root), []);
});

for (const response of ["success", "lost", "timeout"] as const) {
test(`stage ${response} response after scratch creation cleans only its owned directory`, async (t) => {
  const setup = fixture(t);
  const published = join(setup.root, "releases", "existing-build");
  mkdirSync(published, { recursive: true });
  writeFileSync(join(published, "keep"), "shared release");
  const controller = new AbortController();
  const run: RunRemote = async (command, input) => {
    const result = await execute("/bin/sh", ["-c", command], { HOME: setup.home, PATH: process.env.PATH }, input);
    if (command.startsWith("set -eu; umask 077;")) {
      if (response === "timeout") return { ...result, timedOut: true };
      controller.abort();
      if (response === "lost") throw new DOMException("setup response lost", "AbortError");
    }
    return result;
  };
  await assert.rejects(stageRuntime({ run, artifact: setup.artifact, installRoot: setup.root, signal: controller.signal }), response === "timeout" ? /staging setup/ : { name: "AbortError" });
  assert.deepEqual(readdirSync(setup.root), ["releases"]);
  assert.equal(readFileSync(join(published, "keep"), "utf8"), "shared release");
});
}

test("stage rejects a symlink install root before downloading or writing through it", async (t) => {
  const setup = fixture(t);
  const foreign = join(setup.home, "foreign"); mkdirSync(foreign);
  const linked = join(setup.home, "linked"); symlinkSync(foreign, linked);
  const run: RunRemote = (command, input) => execute("/bin/sh", ["-c", command], { HOME: setup.home, PATH: process.env.PATH }, input);
  await assert.rejects(stageRuntime({ run, artifact: setup.artifact, installRoot: linked }), /staging setup.*permission.*symlink/);
  assert.deepEqual(readdirSync(foreign), []);
});

test("real private Node and locked SDK install through client-download fallback without touching the agent", { skip: process.env.PI_TEST_PRIVATE_RUNTIME_NETWORK !== "1", timeout: 600_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-install-network-")));
  t.after(() => { unseal(home); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".pi/agent/packages"), { recursive: true });
  const originals = ["auth.json", "settings.json", "packages/installed.txt"].map((name) => { const path = join(home, ".pi/agent", name); writeFileSync(path, `synthetic ${name}`); return [path, readFileSync(path)] as const; });
  const phases: string[] = [];
  const downloadCache = process.env.PI_TEST_PRIVATE_RUNTIME_DOWNLOADS;
  if (downloadCache) t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => new Response(readFileSync(join(downloadCache, digest(String(url))))));
  const run: RunRemote = (command, input) => {
    // Model a target with no outbound network, while preserving the real shell/upload/installer execution.
    if (command.startsWith("curl ")) return Promise.resolve({ exitCode: 7, stdout: "", stderr: "forced remote download failure" });
    if (command.endsWith(" online")) return Promise.resolve({ exitCode: 75, stdout: "", stderr: "forced remote registry download failure" });
    return execute("/bin/sh", ["-c", command], { HOME: home, PATH: process.env.PATH }, input);
  };
  const artifact = createServerArtifact({ platform: `${process.platform}-${process.arch}` as RuntimePlatform });
  const runtime = await stageRuntime({ run, artifact, onProgress: (phase) => { phases.push(phase); console.log(`private-runtime integration: ${phase}`); } });
  assert.ok(phases.includes("node-upload")); assert.ok(phases.includes("dependencies-upload"));
  assert.deepEqual(readStagedRuntime(runtime.manifestPath), runtime);
  const version = await execute(runtime.node, ["--version"], { HOME: home });
  assert.equal(version.stdout.trim(), "v24.14.1");
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(join(home, ".pi/remote-server.json")), false);
  assert.equal(existsSync(join(home, ".pi/agent/server")), false);
  assert.deepEqual(await stageRuntime({ run, artifact }), runtime, "a real sealed Node/npm/SDK release must pass integrity validation on reuse");
});
