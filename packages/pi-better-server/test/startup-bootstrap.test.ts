import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseRuntime, remoteRuntimeScript } from "../src/startup/runtime.ts";

const bootstrap = fileURLToPath(new URL("../scripts/bootstrap-host.sh", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("bootstrap registers a quoted custom runtime shared by launcher, CLI and SSH discovery without changing credentials", () => {
  const home = mkdtempSync("/tmp/pbs-install-");
  try {
    const prefix = join(home, "runtime ' $literal");
    const agentDir = join(home, "agent ' $literal");
    const serverDir = join(home, "state");
    const bin = join(prefix, `node-v24.0.0-${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(agentDir);
    const credentials = '{"provider":{"token":"do-not-overwrite"}}';
    const settings = '{"custom":"retain-agent-settings"}';
    writeFileSync(join(agentDir, "auth.json"), credentials);
    writeFileSync(join(agentDir, "settings.json"), settings);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
fs.mkdirSync("node_modules/.bin", { recursive: true });
fs.writeFileSync("node_modules/.bin/pi", "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
`, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_VERSION: "24.0.0", PI_CODING_AGENT_DIR: agentDir, PI_SERVER_DIR: serverDir };
    delete env.PI_SERVER_LAUNCHER;
    delete env.PI_SERVER_COMMAND;
    const installed = spawnSync("bash", [bootstrap, prefix], { env, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    delete env.PI_CODING_AGENT_DIR;
    delete env.PI_SERVER_DIR;
    const discovery = spawnSync("/bin/sh", ["-c", remoteRuntimeScript()], { env, encoding: "utf8" });
    assert.equal(discovery.status, 0, discovery.stderr);
    const runtime = parseRuntime(discovery.stdout);
    const launched = spawnSync(runtime.launcher, ["runtime"], { env, encoding: "utf8" });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(parseRuntime(launched.stdout), { version: 1, agent: "pi", launcher: join(prefix, "bin", "pi-server"), agentDir, defaultServerDir: serverDir });
    const direct = spawnSync(process.execPath, [cli, "runtime"], { env, encoding: "utf8" });
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(parseRuntime(direct.stdout), runtime);
    assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), credentials);
    assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), settings);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
