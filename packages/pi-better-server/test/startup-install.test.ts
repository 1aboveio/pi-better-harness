import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
    if (nodeVersion) writeFileSync(join(path, "node/bin/node"), `#!/bin/sh\nexec '${privateNode.node.replaceAll("'", `'"'"'`)}'${versionArgs} "$@"\n`, { mode: 0o755 });
    else copyFileSync(privateNode.node, join(path, "node/bin/node"));
    const npm = join(path, "node/lib/node_modules/npm/bin"); mkdirSync(npm, { recursive: true });
    // npm is the external boundary here. The real pinned npm/SDK closure is exercised by the opt-in integration below.
    writeFileSync(join(npm, "npm-cli.js"), `const fs=require('node:fs'); const p=require('node:path'); if (!process.argv.includes('--ignore-scripts')) throw Error('scripts allowed'); fs.appendFileSync(${JSON.stringify(trace)}, 'install\\n'); const d=p.join(process.cwd(),'node_modules/@earendil-works/pi-coding-agent');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'1.2.0',type:'module',main:'index.js'}));fs.writeFileSync(p.join(d,'index.js'),"export const VERSION='1.2.0';");`);
    writeFileSync(join(path, "artifact.gz"), artifact.bytes);
    for (const name of ["installer.ts", "format.ts"]) copyFileSync(join(pkg, "scripts/private-runtime", name), join(path, name));
    return path;
  }
  const install = (path: string, onStderr?: (text: string) => void, mode = "online") => execute(join(path, "node/bin/node"), [join(path, "installer.ts"), path, root, artifact.sha256, mode, artifact.build.contentId], { HOME: home, PATH: process.env.PATH, EXTERNAL_SECRET: "must-be-cleared" }, undefined, onStderr);
  return { home, root, artifact, trace, work, install };
}

async function cachedFixture(t: any) {
  const setup = fixture(t);
  const installed = await setup.install(setup.work("seed"));
  assert.equal(installed.exitCode, 0, installed.stderr);
  const runtime = JSON.parse(installed.stdout);
  const bin = join(setup.home, "tools"); mkdirSync(bin);
  for (const tool of ["cat", "cp", "cut", "dirname", "env", "mkdir", "rm", "touch", "uname", "wc", "sha256sum", "shasum", "perl"]) {
    const path = execFileSync("/bin/sh", ["-c", 'command -v "$1" || :', "sh", tool], { encoding: "utf8" }).trim();
    if (path) symlinkSync(path, join(bin, tool));
    else assert.ok(["sha256sum", "shasum", "perl"].includes(tool), `missing fixture tool: ${tool}`);
  }
  assert.ok(existsSync(join(bin, "sha256sum")) || existsSync(join(bin, "shasum")), "the fixture needs a real SHA-256 utility");
  const networkTrace = join(setup.home, "network-attempts");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf 'curl\\n' >> '${networkTrace}'\nexit 99\n`, { mode: 0o755 });
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("network forbidden during cached staging"); });
  const env = { HOME: setup.home, PATH: bin, EXTERNAL_SECRET: "must-be-cleared", NODE_OPTIONS: "--this-must-not-reach-private-node" };
  const tools = await execute("/bin/sh", ["-c", "command -v node || command -v npm"], env);
  assert.notEqual(tools.exitCode, 0, "the remote PATH must have neither Node nor npm");
  assert.equal(tools.stdout, "");
  const run = (onStderr?: (text: string) => void): RunRemote => (command, input) => execute("/bin/sh", ["-c", command], env, input, onStderr);
  function assertClean() {
    assert.equal(fetches, 0, "cached staging must not use client fetch");
    assert.equal(existsSync(networkTrace), false, "cached staging must not use remote curl");
    assert.equal(readFileSync(setup.trace, "utf8"), "install\n", "reuse must not run npm");
    assert.deepEqual(readdirSync(setup.root).filter(name => name.startsWith(".stage-")), []);
  }
  return { ...setup, runtime, run, assertClean };
}

function resealEntry(runtime: { root: string }, path: string) {
  const integrityPath = join(runtime.root, "integrity.json");
  chmodSync(integrityPath, 0o600);
  const integrity = JSON.parse(readFileSync(integrityPath, "utf8"));
  integrity[path] = `${path === "node/bin/node" ? 0o111 : 0}:${digest(readFileSync(join(runtime.root, path)))}`;
  writeFileSync(integrityPath, JSON.stringify(integrity));
}

test("cached stageRuntime validates and reuses a release without network or PATH Node/npm", async t => {
  const setup = await cachedFixture(t);
  const phases: string[] = [];
  const transport = setup.run();
  const noArchiveUpload: RunRemote = (command, input, timeoutMs) => {
    assert.equal(command.startsWith("cat > ") && command.endsWith("/artifact.gz'"), false, "repeat staging must reuse the authenticated source archive");
    return transport(command, input, timeoutMs);
  };
  assert.deepEqual(await stageRuntime({ run: noArchiveUpload, artifact: setup.artifact, installRoot: setup.root, onProgress: phase => phases.push(phase) }), setup.runtime);
  assert.deepEqual(readStagedRuntime(setup.runtime.manifestPath), setup.runtime);
  assert.equal(phases.includes("node-download"), false);
  assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
  setup.assertClean();
});

test("cached staging rejects an oversized archive before copying it into scratch", async t => {
  const setup = await cachedFixture(t);
  const archive = join(setup.runtime.root, "artifact.gz");
  chmodSync(archive, 0o600);
  truncateSync(archive, 32 * 1024 * 1024 + 1);
  await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /artifact size limit/);
  setup.assertClean();
});

test("cached staging reuses semantically identical archives from different compression implementations", async t => {
  const setup = await cachedFixture(t);
  const archive = join(setup.runtime.root, "artifact.gz");
  const alternate = gzipSync(gunzipSync(setup.artifact.bytes), { level: 1 });
  assert.notEqual(digest(alternate), setup.artifact.sha256);
  chmodSync(archive, 0o600);
  writeFileSync(archive, alternate);
  resealEntry(setup.runtime, "artifact.gz");
  const transport = setup.run();
  const run: RunRemote = (command, input, timeoutMs) => {
    assert.equal(command.startsWith("cat > ") && command.endsWith("/artifact.gz'"), false, "different gzip bytes must not cause another archive upload");
    return transport(command, input, timeoutMs);
  };
  assert.deepEqual(await stageRuntime({ run, artifact: setup.artifact, installRoot: setup.root }), setup.runtime);
  assert.deepEqual(readFileSync(archive), alternate);
  setup.assertClean();
});

test("cached staging authenticates the source archive independently of its closure inventory", async t => {
  const setup = await cachedFixture(t);
  const archive = join(setup.runtime.root, "artifact.gz");
  chmodSync(archive, 0o600);
  const alternateSource = join(setup.home, "source");
  writeFileSync(join(alternateSource, "src/cli.ts"), "throw new Error('different source build');");
  const alternate = createServerArtifact({ platform: setup.artifact.build.platform, packageDir: alternateSource });
  assert.notEqual(alternate.build.contentId, setup.artifact.build.contentId);
  writeFileSync(archive, alternate.bytes);
  resealEntry(setup.runtime, "artifact.gz");
  await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /cached artifact build identity mismatch/);
  assert.deepEqual(readFileSync(archive), alternate.bytes);
  setup.assertClean();
});

for (const kind of ["symlink", "directory"] as const) {
  test(`cached staging rejects a source archive ${kind} without replacing it`, async t => {
    const setup = await cachedFixture(t);
    unseal(setup.runtime.root);
    const archive = join(setup.runtime.root, "artifact.gz");
    rmSync(archive);
    if (kind === "symlink") symlinkSync(join(setup.home, "missing-archive"), archive);
    else mkdirSync(archive);
    await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /artifact symlink|expected regular artifact/);
    setup.assertClean();
  });
}

test("cached staging supports an immutable older release without a retained source archive", async t => {
  const setup = await cachedFixture(t);
  unseal(setup.runtime.root);
  rmSync(join(setup.runtime.root, "artifact.gz"));
  const inventoryPath = join(setup.runtime.root, "integrity.json");
  chmodSync(inventoryPath, 0o600);
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  delete inventory["artifact.gz"];
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  const executeRemote = setup.run();
  let uploaded = false;
  const run: RunRemote = (command, input, timeoutMs) => {
    if (command.startsWith("cat > ") && command.endsWith("/artifact.gz'")) {
      assert.deepEqual(input, setup.artifact.bytes);
      uploaded = true;
    }
    return executeRemote(command, input, timeoutMs);
  };
  assert.deepEqual(await stageRuntime({ run, artifact: setup.artifact, installRoot: setup.root }), setup.runtime);
  assert.equal(uploaded, true);
  assert.equal(existsSync(join(setup.runtime.root, "artifact.gz")), false, "old published releases must stay untouched");
  setup.assertClean();
});

test("cached staging rejects a release that disappears after archive authentication without cold-installing", async t => {
  const setup = await cachedFixture(t);
  const executeRemote = setup.run();
  const moved = join(setup.home, "removed-after-archive");
  const run: RunRemote = async (command, input, timeoutMs) => {
    const result = await executeRemote(command, input, timeoutMs);
    if (command.includes("reuse:%s") && result.stdout.trim().startsWith("reuse:")) {
      chmodSync(setup.runtime.root, 0o700);
      renameSync(setup.runtime.root, moved);
    }
    return result;
  };
  await assert.rejects(stageRuntime({ run, artifact: setup.artifact, installRoot: setup.root }), /cached release disappeared/);
  assert.equal(existsSync(setup.runtime.root), false);
  assert.equal(existsSync(join(moved, "runtime.json")), true);
  setup.assertClean();
});

test("cached staging rejects a deleted archive still required by the closure inventory", async t => {
  const setup = await cachedFixture(t);
  unseal(setup.runtime.root);
  rmSync(join(setup.runtime.root, "artifact.gz"));
  await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /runtime closure integrity mismatch/);
  assert.equal(existsSync(join(setup.runtime.root, "artifact.gz")), false);
  setup.assertClean();
});

test("cached stageRuntime refuses a release removed after authenticated copy without cold-installing", async t => {
  const setup = await cachedFixture(t);
  const transport = { run: setup.run() };
  const executeRemote = transport.run;
  const phases: string[] = [];
  const moved = join(setup.home, "removed-release");
  let work: string | undefined;
  let installerRan = false;
  t.mock.method(transport, "run", async (command: string, input?: Buffer, timeoutMs?: number) => {
    const result = await executeRemote(command, input, timeoutMs);
    if (result.exitCode === 0 && result.stdout.trim() === "reuse" && command.includes("Node executable integrity mismatch")) {
      const scratch = readdirSync(setup.root).filter(name => name.startsWith(".stage-"));
      assert.equal(scratch.length, 1);
      work = join(setup.root, scratch[0]!);
      assert.equal(digest(readFileSync(join(work, "node/bin/node"))), digest(readFileSync(setup.runtime.node)));
      chmodSync(setup.runtime.root, 0o700);
      renameSync(setup.runtime.root, moved);
      chmodSync(moved, 0o500);
    }
    if (command.startsWith("env -i ")) {
      installerRan = true;
      assert.ok(command.includes(" reuse-only "));
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /reuse-only: release absent/);
      assert.ok(work, "the authenticated copy must precede the installer");
      assert.equal(existsSync(join(work, "release")), false);
      assert.equal(existsSync(join(work, "dependencies")), false);
    }
    return result;
  });
  await assert.rejects(stageRuntime({ run: transport.run, artifact: setup.artifact, installRoot: setup.root, onProgress: phase => phases.push(phase) }), /reuse-only: release absent/);
  assert.equal(installerRan, true, "the real installer must reject the disappeared release");
  assert.equal(existsSync(setup.runtime.root), false, "reuse must not republish the release");
  assert.equal(existsSync(join(moved, "runtime.json")), true);
  assert.equal(phases.includes("node-download"), false);
  assert.equal(phases.includes("dependencies-upload"), false);
  assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
  setup.assertClean();
});

for (const fault of ["authentication-timeout", "installer-timeout", "reuse-exit75"] as const) {
  test(`cached stageRuntime rejects ${fault} without fallback and cleans its scratch directory`, async t => {
    const setup = await cachedFixture(t);
    const transport = { run: setup.run() };
    const executeRemote = transport.run;
    const integrity = readFileSync(join(setup.runtime.root, "integrity.json"));
    const phases: string[] = [];
    const installerModes: string[] = [];
    const diagnostic = `injected cached transport ${fault}`;
    let injected = false;
    t.mock.method(transport, "run", async (command: string, input?: Buffer, timeoutMs?: number) => {
      const result = await executeRemote(command, input, timeoutMs);
      const installer = command.startsWith("env -i ");
      if (installer) installerModes.push(command.includes(" reuse-only ") ? "reuse-only" : "unexpected");
      if (fault === "authentication-timeout" ? result.stdout.trim() === "reuse" : installer) {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(injected, false, "the failed cached command must not be retried");
        injected = true;
        return { ...result, stderr: diagnostic, ...(fault === "reuse-exit75" ? { exitCode: 75 } : { timedOut: true }) };
      }
      return result;
    });
    await assert.rejects(stageRuntime({ run: transport.run, artifact: setup.artifact, installRoot: setup.root, onProgress: phase => phases.push(phase) }), error => error instanceof Error && error.message.includes(diagnostic));
    assert.equal(injected, true, "the real shell must reach the failing transport boundary");
    assert.deepEqual(installerModes, fault === "authentication-timeout" ? [] : ["reuse-only"]);
    assert.deepEqual(readStagedRuntime(setup.runtime.manifestPath), setup.runtime);
    assert.deepEqual(readFileSync(join(setup.runtime.root, "integrity.json")), integrity);
    assert.equal(phases.includes("node-download"), false);
    assert.equal(phases.includes("dependencies-upload"), false);
    assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
    setup.assertClean();
  });
}

test("cached stageRuntime authenticates Node before executing even a self-consistent tampered closure", async t => {
  const setup = await cachedFixture(t);
  const marker = join(setup.home, "untrusted-node-executed");
  chmodSync(setup.runtime.node, 0o700);
  writeFileSync(setup.runtime.node, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  resealEntry(setup.runtime, "node/bin/node");
  await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /Node executable integrity mismatch/);
  assert.equal(existsSync(marker), false, "untrusted Node must never run, including for a version probe");
  setup.assertClean();
});

for (const kind of ["closure", "source", "manifest"] as const) {
  test(`cached stageRuntime rejects ${kind} corruption without downloading or replacing the release`, async t => {
    const setup = await cachedFixture(t);
    const path = kind === "closure" ? "node_modules/@earendil-works/pi-coding-agent/index.js" : kind === "source" ? "src/server.ts" : "runtime.json";
    const file = join(setup.runtime.root, path);
    chmodSync(file, 0o600);
    const corrupt = kind === "manifest" ? JSON.stringify({ ...setup.runtime, unexpected: true }) : "corrupt cached content";
    writeFileSync(file, corrupt);
    if (kind !== "closure") resealEntry(setup.runtime, path);
    await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), kind === "closure" ? /corrupt cache.*integrity/ : kind === "source" ? /corrupt cache.*source mismatch/ : /corrupt cache.*manifest mismatch/);
    assert.equal(readFileSync(file, "utf8"), corrupt);
    assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
    setup.assertClean();
  });
}

for (const component of ["releases", "dangling-releases", "release", "dangling-release", "node", "bin", "executable", "dangling-executable"] as const) {
  test(`cached stageRuntime rejects a symlink at ${component} without running or downloading Node`, async t => {
    const setup = await cachedFixture(t);
    unseal(setup.runtime.root);
    const kind = component.replace("dangling-", "");
    const path = kind === "releases" ? join(setup.root, "releases") : kind === "release" ? setup.runtime.root : kind === "node" ? join(setup.runtime.root, "node") : kind === "bin" ? join(setup.runtime.root, "node/bin") : setup.runtime.node;
    const foreign = join(setup.home, "foreign");
    renameSync(path, foreign);
    symlinkSync(component.startsWith("dangling-") ? `${foreign}-missing` : foreign, path);
    await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /symlink/);
    assert.equal(existsSync(foreign), true);
    setup.assertClean();
  });
}

for (const state of ["missing", "directory", "not-executable"] as const) {
  test(`cached stageRuntime refuses a ${state} Node without downloading or replacing the release`, async t => {
    const setup = await cachedFixture(t);
    unseal(setup.runtime.root);
    if (state === "not-executable") chmodSync(setup.runtime.node, 0o400);
    else {
      rmSync(setup.runtime.node);
      if (state === "directory") mkdirSync(setup.runtime.node);
    }
    await assert.rejects(stageRuntime({ run: setup.run(), artifact: setup.artifact, installRoot: setup.root }), /corrupt cache.*expected regular Node executable/);
    assert.deepEqual(readStagedRuntime(setup.runtime.manifestPath), setup.runtime);
    setup.assertClean();
  });
}

test("cached stageRuntime waits on the existing build lock and cancellation keeps its owner intact", { timeout: 15_000 }, async t => {
  const setup = await cachedFixture(t);
  const lock = join(setup.root, "locks", setup.artifact.build.contentId); mkdirSync(lock);
  const owner = JSON.stringify({ pid: process.pid, work: "another connector" });
  writeFileSync(join(lock, "owner.json"), owner);
  utimesSync(lock, new Date(0), new Date(0));
  const controller = new AbortController();
  const run = setup.run(text => { if (text.includes("Waiting for runtime build owner")) controller.abort(); });
  await assert.rejects(stageRuntime({ run, artifact: setup.artifact, installRoot: setup.root, signal: controller.signal }), { name: "AbortError" });
  assert.equal(readFileSync(join(lock, "owner.json"), "utf8"), owner);
  assert.deepEqual(readStagedRuntime(setup.runtime.manifestPath), setup.runtime);
  setup.assertClean();
});

for (const state of ["absent", "dangling-symlink"] as const) {
  test(`installer reuse-only refuses a release that is ${state} without constructing a candidate`, async t => {
    const setup = fixture(t);
    const releases = join(setup.root, "releases"); mkdirSync(releases);
    if (state === "dangling-symlink") symlinkSync(join(setup.home, "missing"), join(releases, setup.artifact.build.contentId));
    const work = setup.work("reuse");
    const result = await setup.install(work, undefined, "reuse-only");
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, state === "absent" ? /reuse.*absent/ : /corrupt cache.*release symlink/);
    assert.equal(existsSync(join(work, "release")), false);
    assert.equal(existsSync(join(work, "dependencies")), false);
    assert.equal(existsSync(setup.trace), false);
    assert.deepEqual(readdirSync(join(setup.root, "locks")), []);
  });
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
    if (/ online '[a-f0-9]{64}'$/.test(command)) return Promise.resolve({ exitCode: 75, stdout: "", stderr: "forced remote registry download failure" });
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
