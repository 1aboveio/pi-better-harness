import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installed = process.env.PI_HARNESS_SETTINGS_PACKAGE_DIR;
const settingsExtension = installed ? join(installed, "extensions/settings/index.ts") : join(root, "packages/pi-better-harness/extensions/settings/index.ts");
const goalExtension = installed ? join(installed, "extensions/goal/index.ts") : join(root, "packages/pi-better-goal/src/index.ts");
const piCli = process.env.PI_HARNESS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
const q = text => `'${text.replaceAll("'", "'\\''")}'`;

test("real TUI settings hub routes package settings and suggestions require acceptance", { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-settings-"));
  const socket = `harness-settings-${process.pid}`;
  const log = join(dir, "calls.jsonl");
  const ready = join(dir, "ready");
  const fixture = join(dir, "fixture.mjs");
  const agent = join(dir, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  writeFileSync(fixture, `import { appendFileSync, writeFileSync } from 'node:fs';
import { createFauxCore, fauxAssistantMessage } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))};
const core = createFauxCore({api:'harness-test-api',provider:'harness-test',models:[{id:'local'}],tokensPerSecond:2000});
core.setResponses(Array.from({length:30},()=>context=>{
  const suggestion = !context.tools?.length && JSON.stringify(context).toLowerCase().includes('suggest');
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({suggestion,tools:context.tools?.length??0})+'\\n');
  return fauxAssistantMessage(suggestion ? 'Run the focused tests' : 'The focused change is ready for testing.');
}));
export default function(pi){
  pi.registerProvider('harness-test',{api:'harness-test-api',apiKey:'fake',baseUrl:'http://localhost:0',streamSimple:core.streamSimple,
    models:[{id:'local',name:'Local test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]});
  pi.on('session_start',async(_e,ctx)=>{await pi.setModel(ctx.modelRegistry.find('harness-test','local'));writeFileSync(${JSON.stringify(ready)},'ready');});
}`);
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const screen = () => tmux("capture-pane", "-t", "test", "-p");
  const send = text => tmux("send-keys", "-t", "test", "-l", text);
  const key = name => tmux("send-keys", "-t", "test", name);
  const wait = predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const pane = screen();
      if (predicate(pane)) return pane;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    throw new Error(`TUI condition timed out:\n${screen()}\n${existsSync(log) ? readFileSync(log, "utf8") : "no calls"}`);
  };
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const command = ["exec env", `PI_CODING_AGENT_DIR=${q(agent)}`, "PI_OFFLINE=1", q(piCli),
      "--approve --no-skills --no-context-files", "-e", q(goalExtension),
      "-e", q(settingsExtension), "-e", q(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "100", "-y", "32", command);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    send("A baseline change"); key("Enter");
    wait(pane => pane.includes("The focused change is ready for testing."));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings") && pane.includes("/goal settings"));
    assert.equal(calls().length, 1, "default-off made no auxiliary model call");
    key("Down"); key("Down"); key("Enter");
    wait(pane => pane.includes("Goal settings") && pane.includes("Automatic continuation"));
    key("Escape");
    wait(pane => pane.includes("Harness settings"));
    key("Up"); key("Up"); key("Enter");
    wait(pane => pane.includes("Enable prompt suggestions?"));
    key("Enter");
    wait(pane => pane.includes("Harness settings") && /Prompt suggestions\s+on\s*\n/.test(pane) && !pane.includes("Enable prompt suggestions?"));
    key("Escape");
    wait(pane => !pane.includes("Harness settings") && !pane.includes("Enable prompt suggestions?"));
    send("Implement the focused change"); key("Enter");
    wait(pane => pane.includes("Run the focused tests"));
    assert.equal(calls().filter(call => call.suggestion).length, 1);
    assert.equal(calls().find(call => call.suggestion).tools, 0);
    key("Enter");
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings"));
    assert.equal(calls().filter(call => !call.suggestion).length, 2, "ghost Enter made no agent request");
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    send("A second focused change"); key("Enter");
    wait(pane => pane.includes("Run the focused tests") && calls().filter(call => call.suggestion).length === 2);
    key("Tab"); key("Enter");
    wait(() => calls().filter(call => !call.suggestion).length === 4);
    assert.equal(calls().filter(call => !call.suggestion).length, 4);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});