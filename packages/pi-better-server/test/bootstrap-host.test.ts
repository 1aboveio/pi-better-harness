import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bootstrap = fileURLToPath(new URL("../scripts/bootstrap-host.sh", import.meta.url));

// npm and Pi are external commands; exercise the real bootstrap without network installs.
function runBootstrap(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pbs-bootstrap-"));
  const prefix = join(root, "runtime with spaces");
  const agentDir = join(root, "agent");
  const log = join(root, "commands.jsonl");
  const dist = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const bin = join(prefix, `node-v24.14.1-${dist}-${arch}`, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify({ command: "npm", args: process.argv.slice(2) }) + "\\n");
const bin = path.join(process.cwd(), "node_modules", ".bin");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "pi"), ${JSON.stringify(`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.BOOTSTRAP_TEST_LOG, JSON.stringify({ command: "pi", args: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR }) + "\\n");
process.exit(Number(process.env.BOOTSTRAP_TEST_PI_EXIT || 0));
`)}, { mode: 0o755 });
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), NODE_VERSION: "24.14.1", PI_VERSION: "1.2.0", PI_CODING_AGENT_DIR: agentDir, BOOTSTRAP_TEST_LOG: log, ...overrides };
  for (const name of ["HARNESS_VERSION", "MINIMAL_TOOLS_VERSION", "ASK_USER_QUESTION_VERSION", "WEB_TOOLS_VERSION"]) {
    delete env[name];
    if (overrides[name]) env[name] = overrides[name];
  }
  const result = spawnSync("bash", [bootstrap, prefix], { env, encoding: "utf8" });
  const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, prefix, agentDir, commands, result };
}

test("host bootstrap invokes Pi installation for all four pinned defaults in the selected agent directory", () => {
  const run = runBootstrap();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    const installs = run.commands.filter((entry) => entry.command === "pi");
    assert.equal(installs.length, 4);
    for (const install of installs) {
      assert.equal(install.args[0], "install");
      assert.match(install.args[1], /@\d+\.\d+\.\d+$/);
      assert.equal(install.agentDir, run.agentDir);
    }
    assert.deepEqual(installs.map((entry) => entry.args[1].replace(/@\d+\.\d+\.\d+$/, "")), [
      "npm:@vanillagreen/pi-codex-minimal-tools",
      "npm:@juicesharp/rpiv-ask-user-question",
      "npm:@juicesharp/rpiv-web-tools",
      "npm:pi-better-harness",
    ]);

  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("host bootstrap accepts explicit versions for every default package", () => {
  const run = runBootstrap({ HARNESS_VERSION: "0.25.0", MINIMAL_TOOLS_VERSION: "2.0.0", ASK_USER_QUESTION_VERSION: "2.10.0", WEB_TOOLS_VERSION: "2.11.0" });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.deepEqual(run.commands.filter((entry) => entry.command === "pi").map((entry) => entry.args), [
      ["install", "npm:@vanillagreen/pi-codex-minimal-tools@2.0.0"],
      ["install", "npm:@juicesharp/rpiv-ask-user-question@2.10.0"],
      ["install", "npm:@juicesharp/rpiv-web-tools@2.11.0"],
      ["install", "npm:pi-better-harness@0.25.0"],
    ]);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

test("host bootstrap fails when a default extension installation fails", () => {
  const run = runBootstrap({ BOOTSTRAP_TEST_PI_EXIT: "42" });
  try {
    assert.equal(run.result.status, 42);
    assert.doesNotMatch(run.result.stdout, /installed:/);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});