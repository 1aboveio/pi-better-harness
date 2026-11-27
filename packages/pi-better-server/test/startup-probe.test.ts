import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { probeRemoteRuntime, remoteRuntimeScript, shellQuote } from "../src/startup/runtime.ts";
import type { RunRemote } from "../src/startup/managed-types.ts";

export function localRun(home: string, extraEnv: Record<string, string> = {}): RunRemote {
  return (command, input, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { HOME: home, PATH: process.env.PATH, ...extraEnv }, stdio: "pipe" });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", () => undefined);
    child.on("close", (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }); });
    child.stdin.end(input);
  });
}
function home(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-probe-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("managed probe reports an empty home without changing it; manual discovery still fails", async (t) => {
  const root = home(t);
  const run = localRun(root);
  const found = await probeRemoteRuntime(run);
  assert.equal(found.home, root);
  assert.equal(found.platform, `${process.platform}-${process.arch}`);
  assert.equal(found.runtime, undefined);
  assert.deepEqual(readdirSync(root), []);
  assert.notEqual((await run(remoteRuntimeScript())).exitCode, 0);
});
test("probe rejects malformed and empty registrations without rewriting them", async (t) => {
  const root = home(t);
  mkdirSync(join(root, ".pi"));
  const path = join(root, ".pi/remote-server.json");
  for (const text of ["", "not json", '{"version":1,"agent":"pi","launcher":"relative"}']) {
    writeFileSync(path, text);
    await assert.rejects(probeRemoteRuntime(localRun(root)), /registration|JSON|Unexpected|absolute path/);
    assert.equal(readFileSync(path, "utf8"), text);
  }
});
test("explicit command is authoritative; platform-only staging probe never executes it", async (t) => {
  const root = home(t);
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi/remote-server.json"), "invalid registration must not override command");
  const launcher = join(root, "explicit ' launcher");
  const runtime = { version: 1, agent: "pi", launcher, agentDir: join(root, "selected-agent"), defaultServerDir: join(root, "selected-server") };
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s' ${shellQuote(JSON.stringify(runtime))}\nprintf called > ${shellQuote(join(root, "called"))}\n`, { mode: 0o700 });
  const run = localRun(root, { PI_SERVER_COMMAND: launcher });
  const metadata = await probeRemoteRuntime(run, { registration: false });
  assert.equal(readdirSync(root).includes("called"), false);
  assert.equal(metadata.explicitCommand, launcher);
  assert.deepEqual((await probeRemoteRuntime(run)).runtime, runtime);
  assert.equal(readFileSync(join(root, "called"), "utf8"), "called");
});
test("probe rejects unsupported platforms and transport timeouts", async () => {
  await assert.rejects(probeRemoteRuntime(async () => ({ exitCode: 0, stdout: "/tmp\nFreeBSD\nx86_64\n\nabsent\n", stderr: "" })), /unsupported platform/);
  await assert.rejects(probeRemoteRuntime(async () => ({ exitCode: null, stdout: "", stderr: "timed out", timedOut: true })), /Runtime probe.*timed out/);
});
