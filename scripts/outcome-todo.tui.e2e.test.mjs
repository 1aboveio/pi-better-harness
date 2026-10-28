import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.PI_OUTCOME_TODO_TUI_CLI ?? process.env.PI_HARNESS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
const runtime = join(root, "packages/pi-better-harness/extensions/task-context/index.ts");
const settings = join(root, "packages/pi-better-harness/extensions/settings/index.ts");
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = !tmuxAvailable ? "tmux is unavailable" : !existsSync(cli) ? "Pi CLI is unavailable" : false;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// @level e2e
// This starts the actual settings hub and task-context extension. Only the model is synthetic.
test("Outcome & Todo is opt-in, navigable and preserved across native settings changes", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-todo-tui-"));
  const agent = join(dir, "agent");
  const fixture = join(dir, "fixture.mjs");
  const ready = join(dir, "ready");
  const probe = join(dir, "tools.json");
  const callsPath = join(dir, "calls.jsonl");
  const socket = `outcome-todo-${process.pid}`;
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  const todo = Array.from({ length: 9 }, (_, i) => ({
    id: `step_${i + 1}`,
    step: i === 1 ? "中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN" : `Journey task ${i + 1}`,
    status: i === 0 ? "in_progress" : "pending",
    ...(i === 1 ? { dependsOn: ["step_1"] } : {}),
  }));
  writeFileSync(fixture, `import { appendFileSync, writeFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
function streamSimple(model, context) {
  const last = context.messages.findLast(message => message.role === 'toolResult' || (message.role === 'user' && /SEED_OUTCOME|OFF_PROBE/.test(JSON.stringify(message))));
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({tools: context.tools?.map(t => t.name), messages: context.messages})+'\\n');
  const seed = last?.role === 'user' && JSON.stringify(last).includes('SEED_OUTCOME_TODO');
  const outcomeOnly = last?.role === 'user' && JSON.stringify(last).includes('SEED_OUTCOME_ONLY');
  const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,
    content: seed || outcomeOnly ? [{type:'toolCall',id:outcomeOnly?'seed-outcome':'seed-todo',name:'update_todo',arguments:{outcome:{objective:'Deliver the terminal journey',doneWhen:['Evidence is visible']},...(seed?{todo:${JSON.stringify(todo)}}:{})}}]
      : [{type:'text',text: last?.role === 'toolResult' ? 'Seed complete' : 'Probe complete'}],
    stopReason:seed||outcomeOnly?'toolUse':'stop',timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream = createAssistantMessageEventStream();
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});
  return stream;
}
export default function(pi){
  pi.registerProvider('outcome-todo-test',{api:'outcome-todo-test-api',apiKey:'fake',baseUrl:'http://localhost:0',streamSimple,
    models:[{id:'local',name:'Local test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]});
  pi.on('session_start',async(_event,ctx)=>{await pi.setModel(ctx.modelRegistry.find('outcome-todo-test','local'));writeFileSync(${JSON.stringify(ready)},'ready');});
  pi.registerCommand('probe-todo-tools',{description:'Record active tools without starting a turn',handler:async()=>{writeFileSync(${JSON.stringify(probe)},JSON.stringify(pi.getActiveTools()));}});
}`);
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const screen = () => tmux("capture-pane", "-t", "test", "-p");
  const send = text => tmux("send-keys", "-t", "test", "-l", text);
  const key = name => tmux("send-keys", "-t", "test", name);
  const command = text => { send(`\x1b[200~${text}\x1b[201~`); key("Enter"); };
  const wait = predicate => {
    const deadline = Date.now() + 15000;
    let frame = "";
    while (Date.now() < deadline) {
      frame = screen();
      if (predicate(frame)) return frame;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    throw new Error(`TUI condition timed out:\n${frame}\nProvider calls: ${existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "none"}`);
  };
  const calls = () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const activeTools = () => {
    rmSync(probe, { force: true });
    command("/probe-todo-tools");
    wait(() => existsSync(probe));
    return JSON.parse(readFileSync(probe, "utf8"));
  };
  const setEnabled = enabled => {
    command("/harness-settings");
    wait(frame => /Outcome & Todo\s+(?:Off|On)/.test(frame));
    // This isolated hub loads only the callback control and Outcome & Todo.
    key("Down"); key("Space");
    wait(frame => new RegExp(`Outcome & Todo\\s+${enabled ? "On" : "Off"}`).test(frame) && frame.includes("Setting saved"));
    assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).piBetterHarness.outcomeTodo, { version: 1, enabled });
    key("Escape");
    wait(frame => !frame.includes("Harness settings"));
  };
  try {
    assert.ok(existsSync(runtime), `Outcome & Todo runtime is missing: ${runtime}`);
    const launch = [`cd ${quote(dir)} && exec env`, `PI_CODING_AGENT_DIR=${quote(agent)}`, "PI_OFFLINE=1", quote(cli),
      "--approve --no-skills --no-context-files", "-e", quote(settings), "-e", quote(runtime), "-e", quote(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "80", "-y", "40", launch);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    assert.ok(!activeTools().some(name => ["update_todo", "get_todo"].includes(name)), "fresh default must not expose todo tools");
    assert.doesNotMatch(screen(), /^\s*[▸▾]?\s*todo\s+\d+\/\d+/im);
    command("OFF_PROBE");
    wait(frame => frame.includes("Probe complete"));
    assert.equal(calls().length, 1);
    assert.ok(!calls()[0].tools?.some(name => ["update_todo", "get_todo"].includes(name)), "disabled tools must not be sent to the provider");
    setEnabled(true);
    assert.ok(["update_todo", "get_todo"].every(name => activeTools().includes(name)));
    command("SEED_OUTCOME_ONLY");
    wait(frame => frame.includes("Seed complete") && calls().length === 3);
    assert.equal(calls()[2].messages.findLast(message => message.role === "toolResult")?.isError, false, "an outcome alone must be accepted without a checklist");
    command("SEED_OUTCOME_TODO");
    const compact = wait(frame => /todo\s+0\/9 complete/i.test(frame) && frame.includes("Seed complete"));
    assert.doesNotMatch(compact, /^\s*[▸▾]?\s*plan\s+\d+\/\d+/im);
    assert.equal(calls().length, 5, "each explicit seed turn makes one tool call and one follow-up");
    assert.equal(calls()[4].messages.findLast(message => message.role === "toolResult")?.isError, false, "todo update must succeed");
    command("/todo expand");
    wait(frame => /Journey task 9/.test(frame));
    command("/todo collapse");
    wait(frame => /todo\s+0\/9 complete/i.test(frame) && !frame.includes("Journey task 9"));
    command("/todo");
    let full = wait(frame => /^›.*step_1/m.test(frame) && frame.includes("中文任务"));
    assert.ok(full.replace(/\s/g, "").includes("中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN"), `long CJK label must wrap without losing content:\n${full}`);
    key("Down");
    full = wait(frame => /^›.*step_2/m.test(frame));
    assert.match(full, /step_1/, "dependent row must show its prerequisite");
    key("Escape");
    wait(frame => /todo\s+0\/9 complete/i.test(frame) && !/^› /m.test(frame));
    send("EDITOR_BOUNDARY_SENTINEL");
    const withEditor = wait(frame => frame.includes("EDITOR_BOUNDARY_SENTINEL") && /todo\s+0\/9 complete/i.test(frame));
    assert.ok(!withEditor.split("\n").some(line => line.includes("EDITOR_BOUNDARY_SENTINEL") && /todo\s+0\/9 complete/i.test(line)), "widget and editor must occupy separate rows at 80 columns");
    key("C-u");
    setEnabled(false);
    assert.ok(!activeTools().some(name => ["update_todo", "get_todo"].includes(name)));
    assert.doesNotMatch(screen(), /^\s*[▸▾]?\s*todo\s+\d+\/\d+/im);
    setEnabled(true);
    wait(frame => /todo\s+0\/9 complete/i.test(frame) && frame.includes("Journey task 1"));
    assert.ok(["update_todo", "get_todo"].every(name => activeTools().includes(name)));
    assert.equal(calls().length, 5, "settings, navigation and toggles must not start agent turns");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});
