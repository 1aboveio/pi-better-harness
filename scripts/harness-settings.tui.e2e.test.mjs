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
const toolOutputExtension = installed ? join(installed, "extensions/minimal-output/index.ts") : join(root, "packages/pi-better-harness/extensions/minimal-output/index.ts");
const goalExtension = installed ? join(installed, "extensions/goal/index.ts") : join(root, "packages/pi-better-goal/src/index.ts");
const piCli = process.env.PI_HARNESS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
const q = text => `'${text.replaceAll("'", "'\\''")}'`;

test("real TUI hub autosaves callback mode, saves defaults on ctrl+s, and routes packages without model requests", { skip: spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-settings-"));
  const socket = `harness-settings-${process.pid}`;
  const log = join(dir, "calls.jsonl");
  const ready = join(dir, "ready");
  const fixture = join(dir, "fixture.mjs");
  const agent = join(dir, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  writeFileSync(fixture, `import { appendFileSync, writeFileSync } from 'node:fs';
function streamSimple(){
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({unexpectedModelRequest:true})+'\\n');
  throw new Error('Settings must not invoke the model');
}
export default function(pi){
  pi.registerProvider('harness-test',{api:'harness-test-api',apiKey:'fake',baseUrl:'http://localhost:0',streamSimple,
    models:[{id:'local',name:'Local test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]});
  pi.on('session_start',async(_e,ctx)=>{
    await pi.setModel(ctx.modelRegistry.find('harness-test','local'));
    if (!ctx.sessionManager.getBranch().some(entry=>entry.type==='message' && entry.message.role==='assistant')) {
      ctx.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'Settings journey fixture'},
        {type:'toolCall',id:'fixture-first',name:'read',arguments:{path:'fixture-first.txt'}},
        {type:'toolCall',id:'fixture-second',name:'read',arguments:{path:'fixture-second.txt'}}],
        api:'harness-test-api',provider:'harness-test',model:'local',stopReason:'toolUse',timestamp:0,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      for (const id of ['fixture-first','fixture-second']) ctx.sessionManager.appendMessage({
        role:'toolResult',toolCallId:id,toolName:'read',content:[{type:'text',text:'TOOL_DETAIL_SENTINEL '+id}],isError:false,timestamp:0});
      ctx.sessionManager.appendMessage({role:'assistant',content:[{type:'text',text:'Settings journey answer'}],
        api:'harness-test-api',provider:'harness-test',model:'local',stopReason:'stop',timestamp:0,
        usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    }
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({sessionFile:ctx.sessionManager.getSessionFile()}));
  });
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
      "-e", q(settingsExtension), "-e", q(toolOutputExtension), "-e", q(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "100", "-y", "32", command);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    const originalSessionFile = JSON.parse(readFileSync(ready, "utf8")).sessionFile;
    assert.equal(typeof originalSessionFile, "string");
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings") && pane.includes("/goal settings"));
    wait(pane => pane.includes("Completions while busy") && pane.includes("Wait until idle") && pane.includes("Ctrl+S saves the default for future sessions"));
    key("Enter");
    wait(pane => pane.includes("Steer active run") && pane.includes("Session setting saved"));
    const preferences = join(agent, "extensions", "pi-better-callback-preferences.json");
    assert.equal(existsSync(preferences), false, "changing the session must not save a global default");
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings") && pane.includes("Steer active run"));
    key("C-s");
    wait(pane => pane.includes("Callback default saved"));
    assert.equal(existsSync(preferences), true);
    key("Down");
    wait(pane => pane.includes("Tool output") && pane.includes("Normal"));
    key("Space");
    wait(pane => /Tool output\s+Minimal/.test(pane) && pane.includes("Session setting saved"));
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    const folded = wait(pane => pane.includes("2 tool calls") && pane.includes("Settings journey answer"));
    assert.equal(folded.includes("TOOL_DETAIL_SENTINEL"), false);
    assert.match(folded, /^ {3}\u25b8 2 tool calls/m);
    key("C-o");
    wait(pane => pane.includes("TOOL_DETAIL_SENTINEL fixture-first") && pane.includes("TOOL_DETAIL_SENTINEL fixture-second"));
    key("C-o");
    wait(pane => pane.includes("2 tool calls") && !pane.includes("TOOL_DETAIL_SENTINEL"));
    rmSync(ready);
    send("/reload"); key("Enter");
    wait(pane => existsSync(ready) && pane.includes("Reloaded keybindings"));
    send("/harness-settings"); key("Enter");
    const reloaded = wait(pane => /Tool output\s+Minimal/.test(pane) && pane.includes("Steer active run"));
    assert.equal((reloaded.match(/Tool output/g) ?? []).length, 1, "reload must not duplicate the tool-output contribution");
    key("Down");
    key("Down");
    key("Enter");
    wait(pane => pane.includes("Goal settings") && pane.includes("Automatic continuation"));
    key("Escape");
    wait(pane => pane.includes("Harness settings"));
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    send("/goal settings"); key("Escape"); key("Enter");
    wait(pane => pane.includes("Goal settings") && pane.includes("Automatic continuation"));
    key("Escape");
    wait(pane => !pane.includes("Goal settings"));
    rmSync(ready);
    tmux("new-window", "-t", "test", "-n", "fresh-session", command);
    wait(() => existsSync(ready));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings") && pane.includes("Steer active run") && pane.includes("User default") && /Tool output\s+Normal/.test(pane));
    key("Enter");
    wait(pane => pane.includes("Wait until idle") && pane.includes("Session setting saved"));
    key("Escape");
    rmSync(ready);
    tmux("new-window", "-t", "test", "-n", "resumed-session", `${command} --session ${q(originalSessionFile)}`);
    wait(() => existsSync(ready));
    send("/harness-settings"); key("Enter");
    wait(pane => /Tool output\s+Minimal/.test(pane) && pane.includes("Steer active run") && pane.includes("Session setting"));
    key("Escape");
    wait(pane => pane.includes("2 tool calls") && pane.includes("Settings journey answer") && !pane.includes("TOOL_DETAIL_SENTINEL"));
    assert.deepEqual(calls(), [], "opening settings never invokes the model");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});