import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const mouseRouting = existsSync(join(dirname(createRequire(realpathSync(piCli)).resolve("@earendil-works/pi-tui")), "tui-alt-screen.js"));
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
  const ansiScreen = () => tmux("capture-pane", "-t", "test", "-p", "-e");
  const send = text => tmux("send-keys", "-t", "test", "-l", text);
  const key = name => tmux("send-keys", "-t", "test", name);
  const wait = predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const pane = screen();
      if (predicate(pane)) return pane;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    throw new Error(`TUI condition timed out:\n${screen()}\nANSI: ${JSON.stringify(ansiScreen())}\n${existsSync(log) ? readFileSync(log, "utf8") : "no calls"}`);
  };
  const select = label => {
    // The native list wraps, so this also works after returning from a package page.
    const target = new RegExp("^> " + label + "(?:  |$)", "m");
    for (let step = 0; step < 16; step++) {
      const pane = screen();
      if (target.test(pane)) return;
      const active = pane.split("\n").find(line => line.startsWith("> "));
      assert.ok(active, "a setting has focus");
      key("Down");
      wait(next => !next.split("\n").includes(active));
    }
    assert.fail(`Could not select ${label}`);
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
    wait(pane => pane.includes("Harness settings") && /Goal execution settings\s+Open/.test(pane));
    select("Completion delivery");
    wait(pane => /Completion delivery\s+When idle/.test(pane) && pane.includes("Ctrl+S saves your default"));
    key("Enter");
    wait(pane => /Completion delivery\s+During run/.test(pane) && pane.includes("Session setting saved"));
    const preferences = join(agent, "settings.json");
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness?.callbacks, undefined, "changing the session must not save a global default");
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings") && /Completion delivery\s+During run/.test(pane));
    key("C-s");
    wait(pane => pane.includes("Callback default saved"));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.callbacks.mode, "steer");
    select("Auto-run saved Goals");
    wait(pane => /^> Auto-run saved Goals\s+Off/m.test(pane));
    key("Space");
    wait(pane => /Auto-run saved Goals\s+On/.test(pane) && pane.includes("Setting saved"));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.goal.autoStartFromOutcome, true);
    key("Space");
    wait(pane => /Auto-run saved Goals\s+Off/.test(pane) && pane.includes("Setting saved"));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.goal.autoStartFromOutcome, false);
    select("Pin work panels");
    wait(pane => /^> Pin work panels\s+On/m.test(pane) && pane.includes("Keeps the work panels above the editor"));
    select("Navigator layout");
    wait(pane => /^> Navigator layout\s+Flat list/m.test(pane));
    tmux("resize-window", "-t", "test", "-x", "48", "-y", "28");
    wait(pane => /^> Navigator layout\s+Flat list/m.test(pane) && /Tree nests tasks under their\s+agent/.test(pane));
    tmux("resize-window", "-t", "test", "-x", "100", "-y", "32");
    select("Tool output");
    wait(pane => /^> Tool output\s+Normal/m.test(pane));
    key("Space");
    wait(pane => /Tool output\s+Compact/.test(pane) && pane.includes("Setting saved"));
    select("Tool progress animation");
    wait(pane => /^> Tool progress animation\s+On/m.test(pane));
    key("Space");
    wait(pane => /Tool progress animation\s+Off/.test(pane));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.toolAnimation.enabled, false);
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    const folded = wait(pane => pane.includes("2 tool calls") && pane.includes("Settings journey answer"));
    assert.equal(folded.includes("TOOL_DETAIL_SENTINEL"), false);
    assert.match(folded, /^ {3}\u25b8 2 tool calls/m);
    if (mouseRouting) {
      const background = /\x1b\[(?:48;|4[0-7]m|10[0-7]m|7m)/;
      const summaryY = folded.split("\n").findIndex(line => line.includes("2 tool calls"));
      const answerY = folded.split("\n").findIndex(line => line.includes("Settings journey answer"));
      const move = y => send(`\x1b[<35;5;${y + 1}M`);
      const click = y => { send(`\x1b[<0;5;${y + 1}M`); send(`\x1b[<0;5;${y + 1}m`); };
      assert.doesNotMatch(ansiScreen().split("\n")[summaryY], background);
      move(summaryY);
      wait(() => background.test(ansiScreen().split("\n")[summaryY]));
      move(answerY);
      wait(() => !background.test(ansiScreen().split("\n")[summaryY]));
      click(summaryY);
      const open = wait(pane => pane.includes("fixture-first.txt") && pane.includes("fixture-second.txt"));
      assert.match(open, /^ {6}\u25a4 Read/m, "icons are centered in the three-column gutter");
      const callY = open.split("\n").findIndex(line => line.includes("fixture-first.txt"));
      move(callY);
      wait(() => background.test(ansiScreen().split("\n")[callY]));
      click(callY);
      wait(pane => pane.includes("TOOL_DETAIL_SENTINEL fixture-first"));
      key("C-o");
      wait(pane => pane.includes("TOOL_DETAIL_SENTINEL fixture-second"));
      key("C-o");
      wait(pane => pane.includes("2 tool calls") && !pane.includes("TOOL_DETAIL_SENTINEL"));
    }
    key("C-o");
    wait(pane => pane.includes("TOOL_DETAIL_SENTINEL fixture-first") && pane.includes("TOOL_DETAIL_SENTINEL fixture-second"));
    key("C-o");
    wait(pane => pane.includes("2 tool calls") && !pane.includes("TOOL_DETAIL_SENTINEL"));
    rmSync(ready);
    send("/reload"); key("Enter");
    wait(pane => existsSync(ready) && pane.includes("Reloaded keybindings"));
    send("/harness-settings"); key("Enter");
    const reloaded = wait(pane => /Tool output\s+Compact/.test(pane) && /Completion delivery\s+During run/.test(pane));
    assert.equal((reloaded.match(/Tool output/g) ?? []).length, 1, "reload must not duplicate the tool-output contribution");
    assert.equal((reloaded.match(/Tool progress animation/g) ?? []).length, 1);
    assert.match(reloaded, /Tool progress animation\s+Off/);
    assert.equal((reloaded.match(/Auto-run saved Goals/g) ?? []).length, 1);
    assert.match(reloaded, /Auto-run saved Goals\s+Off/);
    select("Goal execution settings");
    wait(pane => /^> Goal execution settings\s+Open/m.test(pane) && pane.includes("You can also run /goal settings."));
    key("Enter");
    wait(pane => pane.includes("Goal execution settings") && pane.includes("Automatic continuation"));
    key("Escape");
    wait(pane => pane.includes("Harness settings") && /^> Goal execution settings\s+Open/m.test(pane));
    select("Navigator layout");
    wait(pane => /^> Navigator layout\s+Flat list/m.test(pane));
    key("Space");
    wait(pane => /^> Navigator layout\s+Tree/m.test(pane) && pane.includes("Setting saved"));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.navigatorView, "tree");
    key("Escape");
    wait(pane => !pane.includes("Harness settings"));
    send("/goal settings"); key("Escape"); key("Enter");
    wait(pane => pane.includes("Goal execution settings") && pane.includes("Automatic continuation"));
    key("Escape");
    wait(pane => !pane.includes("Goal execution settings"));
    rmSync(ready);
    tmux("new-window", "-t", "test", "-n", "fresh-session", command);
    wait(() => existsSync(ready));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings"));
    select("Completion delivery");
    wait(pane => /Completion delivery\s+During run/.test(pane) && pane.includes("Using the default.") && /Tool output\s+Compact/.test(pane));
    assert.match(screen(), /Navigator layout\s+Tree/);
    key("Enter");
    wait(pane => /Completion delivery\s+When idle/.test(pane) && pane.includes("Session setting saved"));
    select("Tool output"); key("Space");
    wait(pane => /Tool output\s+Normal/.test(pane) && pane.includes("Setting saved"));
    assert.equal(JSON.parse(readFileSync(preferences, "utf8")).piBetterHarness.toolOutput.enabled, false);
    key("Escape");
    rmSync(ready);
    tmux("new-window", "-t", "test", "-n", "resumed-session", `${command} --session ${q(originalSessionFile)}`);
    wait(() => existsSync(ready));
    send("/harness-settings"); key("Enter");
    wait(pane => pane.includes("Harness settings"));
    select("Completion delivery");
    wait(pane => /Tool output\s+Compact/.test(pane) && /Completion delivery\s+During run/.test(pane) && pane.includes("Using this session’s setting."));
    key("Escape");
    wait(pane => pane.includes("2 tool calls") && pane.includes("Settings journey answer") && !pane.includes("TOOL_DETAIL_SENTINEL"));
    assert.deepEqual(calls(), [], "opening settings never invokes the model");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});
