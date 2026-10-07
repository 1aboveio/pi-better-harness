import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxExtension = process.env.PI_SANDBOX_DIAGNOSTICS_PACKAGE_DIR ? join(process.env.PI_SANDBOX_DIAGNOSTICS_PACKAGE_DIR, "index.ts") : join(root, "packages/pi-better-sandbox/index.ts");
const piCli = process.env.PI_SANDBOX_DIAGNOSTICS_CLI ?? join(root, "node_modules/.bin/pi");
const q = value => `'${value.replaceAll("'", "'\\''")}'`;
test("sandbox diagnostics opt-in collects a real user-bash refusal, exports redacted evidence, and survives reload", {
  skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0,
}, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-diagnostics-tui-")));
  const agent = join(dir, "agent");
  const socket = `sandbox-diagnostics-${process.pid}`;
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const screen = () => tmux("capture-pane", "-t", "test", "-p");
  const key = name => tmux("send-keys", "-t", "test", name);
  const send = text => { tmux("send-keys", "-t", "test", "-l", text); key("Escape"); key("Enter"); };
  const wait = predicate => {
    const deadline = Date.now() + 15000;
    let pane = "";
    while (Date.now() < deadline) {
      pane = screen();
      if (predicate(pane)) return pane;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    assert.fail(`Diagnostics terminal condition timed out:\n${pane}`);
  };
  const journal = join(agent, "diagnostics/sandbox/events.jsonl");
  const records = () => readFileSync(journal, "utf8").trim().split("\n").slice(1).map(line => JSON.parse(line));
  try {
    const command = `cd ${q(dir)} && exec env PI_CODING_AGENT_DIR=${q(agent)} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(piCli)} -e ${q(sandboxExtension)} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    tmux("new-session", "-d", "-s", "test", "-x", "110", "-y", "45", command);
    wait(pane => pane.includes("sandbox"));
    send("/sandbox diagnostics on");
    wait(pane => pane.includes("Sandbox diagnostics enabled"));
    send("/sandbox");
    wait(pane => /Sandbox permissions\s+Main\s+Subagents/.test(pane));
    key("Space");
    wait(pane => /Sandbox\s+On\s+On/.test(pane));
    for (let i = 0; i < 4; i++) key("Down");
    wait(pane => /^> Run commands & applications/m.test(pane));
    key("Space");
    wait(pane => /Run commands & applications\s+Off\s+On/.test(pane));
    key("Escape");
    wait(pane => !pane.includes("Sandbox permissions"));
    send("!printf PRIVATE-COMMAND-CANARY");
    wait(() => existsSync(journal) && records().length === 1);
    wait(pane => pane.includes("Error: Bash command failed: Sandbox: Run commands & applications is Off."));
    assert.equal(records()[0].basis, "policy-refusal");
    assert.equal(records()[0].resource, "command-execution");
    assert.doesNotMatch(readFileSync(journal, "utf8"), /PRIVATE-COMMAND-CANARY/);
    send("/sandbox diagnostics export");
    const path = join(agent, "diagnostics/sandbox/export.json");
    wait(() => existsSync(path));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).records.length, 1);
    assert.doesNotMatch(readFileSync(path, "utf8"), /PRIVATE-COMMAND-CANARY/);
    send("/reload");
    wait(pane => pane.includes("Reloaded"));
    send("/sandbox diagnostics status");
    wait(pane => pane.includes("Sandbox diagnostics: On"));
    assert.equal(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).piBetterHarness.sandboxDiagnostics.enabled, true);
    send("/sandbox diagnostics off");
    wait(pane => pane.includes("Sandbox diagnostics disabled"));
    send("!printf DISABLED-CANARY");
    wait(pane => pane.includes("commands & applications is Off"));
    assert.equal(records().length, 1);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});