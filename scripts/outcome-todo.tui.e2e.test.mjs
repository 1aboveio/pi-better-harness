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
const goal = join(root, "packages/pi-better-goal/src/index.ts");
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = !tmuxAvailable ? "tmux is unavailable" : !existsSync(cli) ? "Pi CLI is unavailable" : false;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const objective = "Deliver the terminal journey with a compact Todo header that keeps every accepted outcome visible across narrow terminals";
const doneWhen = ["Evidence is visible", "Narrow widths stay readable"];
const boundaries = ["Do not edit the legacy Plan package"];

// @level e2e
// This starts the actual settings hub and task-context extension. Only the model is synthetic.
for (const legacyFirst of [true, false]) {
test(`Outcome & Todo masks legacy Plan loaded ${legacyFirst ? "before" : "after"} Harness and preserves native settings`, { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-todo-tui-"));
  const agent = join(dir, "agent");
  const fixture = join(dir, "fixture.mjs");
  const ready = join(dir, "ready");
  const boundReady = join(dir, "bound-ready");
  const probe = join(dir, "tools.json");
  const callsPath = join(dir, "calls.jsonl");
  const legacy = join(dir, "legacy-plan");
  const legacyEffects = join(dir, "legacy-effects.jsonl");
  const socket = `outcome-todo-${process.pid}-${legacyFirst}`;
  mkdirSync(agent);
  mkdirSync(legacy);
  writeFileSync(join(legacy, "package.json"), JSON.stringify({ name: "pi-better-plan", version: "0.9.1", type: "module", pi: { extensions: ["index.ts"] } }));
  writeFileSync(join(legacy, "index.ts"), `import { appendFileSync } from 'node:fs';
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
export default function(pi) {
  const record = effect => appendFileSync(${JSON.stringify(legacyEffects)}, JSON.stringify(effect)+'\\n');
  record('factory');
  const stop = pi.events.on('legacy-plan:probe', () => record('listener'));
  for (const name of ['update_plan', 'get_plan']) pi.registerTool({name,label:name,description:'Legacy Plan',parameters:Type.Object({}),execute:async()=>{record('tool');return {content:[{type:'text',text:'legacy'}]};}});
  pi.registerCommand('plan',{description:'Legacy Plan',handler:async()=>record('command')});
  pi.on('session_start',(_event,ctx)=>{record('startup');ctx.ui.setWidget('pi-better-plan',['LEGACY_PLAN_WIDGET']);});
  pi.on('before_agent_start',()=>{record('prompt');return {systemPrompt:'LEGACY_PLAN_PROMPT'};});
  pi.on('session_shutdown',(_event,ctx)=>{stop();record('shutdown');ctx.ui.setWidget('pi-better-plan',undefined);});
}`);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", packages: [], quietStartup: true }));
  const todo = Array.from({ length: 9 }, (_, i) => ({
    id: `step_${i + 1}`,
    step: i === 1 ? "中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN" : `Journey task ${i + 1}`,
    status: i === 0 ? "in_progress" : "pending",
    ...(i === 1 ? { dependsOn: ["step_1"] } : {}),
  }));
  writeFileSync(fixture, `import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
function streamSimple(model, context) {
  const last = context.messages.findLast(message => message.role === 'toolResult' || (message.role === 'user' && /SEED_OUTCOME|OFF_PROBE/.test(JSON.stringify(message))));
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({tools: context.tools?.map(t => t.name), systemPrompt:context.systemPrompt, messages: context.messages})+'\\n');
  const seed = last?.role === 'user' && JSON.stringify(last).includes('SEED_OUTCOME_TODO');
  const outcomeOnly = last?.role === 'user' && JSON.stringify(last).includes('SEED_OUTCOME_ONLY');
  const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,
    content: seed || outcomeOnly ? [{type:'toolCall',id:outcomeOnly?'seed-outcome':'seed-todo',name:'update_todo',arguments:{outcome:{objective:${JSON.stringify(objective)},doneWhen:${JSON.stringify(doneWhen)},boundaries:${JSON.stringify(boundaries)}},...(seed?{todo:${JSON.stringify(todo)}}:{})}}]
      : [{type:'text',text: last?.role === 'toolResult' ? 'Seed complete' : 'Probe complete'}],
    stopReason:seed||outcomeOnly?'toolUse':'stop',timestamp:Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream = createAssistantMessageEventStream();
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});
  return stream;
}
export default function(pi){
  const controls = new Map();
  pi.events.on('harness-settings:register', control => {
    if (control && typeof control.id === 'string') controls.set(control.id, {id:control.id,label:control.label,value:typeof control.get === 'function' ? control.get() : undefined});
  });
  pi.registerProvider('outcome-todo-test',{api:'outcome-todo-test-api',apiKey:'fake',baseUrl:'http://localhost:0',streamSimple,
    models:[{id:'local',name:'Local test',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]});
  pi.on('session_start',async(_event,ctx)=>{await pi.setModel(ctx.modelRegistry.find('outcome-todo-test','local'));writeFileSync(${JSON.stringify(ready)}+'.tmp',JSON.stringify({themeMuted:ctx.ui.theme.fg('muted','X')}));renameSync(${JSON.stringify(ready)}+'.tmp',${JSON.stringify(ready)});});
  pi.registerCommand('probe-todo-tools',{description:'Record active tools and registered settings without starting a turn',handler:async()=>{pi.events.emit('legacy-plan:probe',{});pi.events.emit('harness-settings:request',{});writeFileSync(${JSON.stringify(probe)}+'.tmp',JSON.stringify({active:pi.getActiveTools(),all:pi.getAllTools().map(t=>t.name),commands:pi.getCommands().map(c=>c.name),settings:[...controls.values()]}));renameSync(${JSON.stringify(probe)}+'.tmp',${JSON.stringify(probe)});}});
  pi.registerCommand('emit-goal-start',{description:'Offer a Goal start to Harness without a model turn',handler:async()=>{pi.events.emit('pi-better-harness:task-context',{action:'start',goalId:'goal_ignored',objective:'IGNORED_GOAL_OBJECTIVE'});}});
  pi.registerCommand('seed-bound-goal',{description:'Seed an active Goal bound to the accepted outcome',handler:async(_args,ctx)=>{
    const now = Math.floor(Date.now()/1000);
    pi.appendEntry('pi-better-goal',{version:1,kind:'set',source:'command',at:now,goal:{
      goalId:'goal_e2e_bound',objective:${JSON.stringify(objective)},status:'active',tokenBudget:null,
      usage:{tokensUsed:0,activeSeconds:134},createdAt:now-200,updatedAt:now,activeStartedAt:now-2,completedAt:null}});
    pi.appendEntry('pi-better-harness:outcome',{version:1,outcome:{objective:${JSON.stringify(objective)},doneWhen:${JSON.stringify(doneWhen)},boundaries:${JSON.stringify(boundaries)},status:'active',goalId:'goal_e2e_bound'}});
    await ctx.reload();
    writeFileSync(${JSON.stringify(boundReady)},'ready');
  }});
}`);
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const screen = () => tmux("capture-pane", "-t", "test", "-p");
  const ansiScreen = () => tmux("capture-pane", "-t", "test", "-p", "-e");
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
  const preferences = () => JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).piBetterHarness.outcomeTodo;
  const selectedSetting = frame => frame.split("\n").find(line => /^\s*>/.test(line));
  const selectSetting = label => {
    let current = selectedSetting(screen()) ?? "";
    for (let step = 0; step < 8; step++) {
      if (current.includes(label)) return;
      key("Down");
      const previous = current;
      current = selectedSetting(wait(frame => {
        const selected = selectedSetting(frame);
        return selected !== undefined && selected !== previous;
      })) ?? "";
    }
    throw new Error(`setting ${label} is not reachable:\n${screen()}`);
  };
  const setSetting = (label, enabled) => {
    command("/harness-settings");
    wait(frame => /Outcome & Todo display\s+(?:On|Off)/.test(frame) && /Outcome & Todo hooks\s+(?:On|Off)/.test(frame));
    selectSetting(label);
    const expected = enabled ? "On" : "Off";
    const current = new RegExp(`${label}\\s+(On|Off)`).exec(screen())?.[1];
    if (current !== expected) {
      key("Space");
      wait(frame => new RegExp(`${label}\\s+${expected}`).test(frame) && frame.includes("Setting saved"));
    }
    key("Escape");
    wait(frame => !frame.includes("Harness settings"));
  };
  const setHooks = enabled => setSetting("Outcome & Todo hooks", enabled);
  const setDisplay = enabled => setSetting("Outcome & Todo display", enabled);
  const probeState = () => {
    rmSync(probe, { force: true });
    command("/probe-todo-tools");
    wait(() => existsSync(probe));
    const result = JSON.parse(readFileSync(probe, "utf8"));
    assert.ok(!result.all.some(name => ["update_plan", "get_plan"].includes(name)), "legacy tools must be unregistered, not just inactive");
    assert.ok(!result.commands.includes("plan"), "legacy /plan must be absent");
    return result;
  };
  const headerLine = frame => frame.split("\n").find(line => /^todo(?:\s|$)/.test(line));
  const assertNoHeader = frame => assert.equal(headerLine(frame), undefined, `Todo display must be off:\n${frame}`);
  const assertNoStandaloneGoal = frame => assert.doesNotMatch(frame, /^goal (?:active|paused|complete|budgetLimited)\b/m, `Goal must be owned by the combined header:\n${frame}`);
  const assertCompactOutcome = (frame, { bound = false, mutedPrefix } = {}) => {
    const rows = frame.split("\n");
    const index = rows.findIndex(line => /^todo(?:\s|$)/.test(line));
    assert.ok(index > 0, `compact Todo header must be visible:\n${frame}`);
    const header = rows[index];
    assert.match(header, /^todo\s+[▸▾]\s{2}0\/9 complete\b/, `Todo keeps the caret after its title and n/total on the left:\n${frame}`);
    if (bound) assert.match(header, /active\s+\d+:\d{2}\s*$/, `bound Goal status and active clock stay on the right:\n${frame}`);
    else assert.doesNotMatch(header, /\d+:\d{2}/, "no Goal active-time clock may appear without a bound Goal");
    const subtitle = rows[index + 1] ?? "";
    assert.ok(subtitle.trimStart().startsWith(objective.slice(0, 24)), `accepted Outcome is the subtitle:\n${frame}`);
    assert.ok(subtitle.trimEnd().endsWith("..."), `the Outcome subtitle must truncate instead of wrap:\n${frame}`);
    assert.equal(rows[index + 2] ?? "", "", `one blank row separates the subtitle from the checklist:\n${frame}`);
    assert.ok(rows.slice(index + 3).some(line => /Journey task 1|step_1/.test(line)), "the checklist follows the blank row");
    assert.equal(rows.filter(line => /^\s*outcome\b/i.test(line)).length, 0, "no separate Outcome line is allowed");
    if (mutedPrefix) {
      const ansiRow = ansiScreen().split("\n")[index + 1] ?? "";
      assert.ok(ansiRow.includes(mutedPrefix), `the Outcome subtitle must use the muted theme color:\n${JSON.stringify(ansiRow)}`);
    }
    return { rows, index, header, subtitle };
  };
  try {
    assert.ok(existsSync(runtime), `Outcome & Todo runtime is missing: ${runtime}`);
    const ordered = legacyFirst ? [join(legacy, "index.ts"), runtime] : [runtime, join(legacy, "index.ts")];
    const launch = [`cd ${quote(dir)} && exec env`, `PI_CODING_AGENT_DIR=${quote(agent)}`, "PI_OFFLINE=1", quote(cli),
      "--approve --no-skills --no-context-files", "-e", quote(settings), "-e", quote(goal), ...ordered.flatMap(path => ["-e", quote(path)]), "-e", quote(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "80", "-y", "40", launch);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    const readyState = JSON.parse(readFileSync(ready, "utf8"));
    const mutedPrefix = readyState.themeMuted.slice(0, readyState.themeMuted.indexOf("X"));

    const fresh = probeState();
    assert.ok(!fresh.active.some(name => ["update_todo", "get_todo"].includes(name)), "fresh default must not expose todo tools");
    assert.deepEqual(fresh.settings.filter(item => item.id.startsWith("outcome-todo")), [
      { id: "outcome-todo-display", label: "Outcome & Todo display", value: "On" },
      { id: "outcome-todo", label: "Outcome & Todo hooks", value: "Off" },
    ], "display defaults On, hooks default Off, and each has its own id and label");
    assert.deepEqual(readFileSync(legacyEffects, "utf8").trim().split("\n").map(JSON.parse), ["factory", "shutdown"], "legacy factory listeners must be cleaned up before startup");
    assert.doesNotMatch(screen(), /LEGACY_PLAN_WIDGET/);
    assertNoHeader(screen());
    assert.doesNotMatch(screen(), /^\s*[▸▾]?\s*todo\s+\d+\/\d+/im);

    command("OFF_PROBE");
    wait(frame => frame.includes("Probe complete"));
    assert.equal(calls().length, 1);
    assert.ok(!calls()[0].tools?.some(name => ["update_todo", "get_todo"].includes(name)), "disabled tools must not be sent to the provider");

    setHooks(true);
    assert.deepEqual(preferences(), { version: 1, enabled: true, display: true });
    const enabledTools = probeState().active;
    assert.ok(["update_todo", "get_todo"].every(name => enabledTools.includes(name)));

    command("SEED_OUTCOME_ONLY");
    wait(frame => frame.includes("Seed complete") && calls().length === 3);
    assert.equal(calls()[2].messages.findLast(message => message.role === "toolResult")?.isError, false, "an outcome alone must be accepted without a checklist");
    const outcomeOnly = wait(frame => frame.split("\n").some(line => /^todo(?:\s|$)/.test(line)) && frame.split("\n")[frame.split("\n").findIndex(line => /^todo(?:\s|$)/.test(line)) + 1]?.includes(objective.slice(0, 24)));
    assert.ok(outcomeOnly.split("\n").slice(outcomeOnly.split("\n").findIndex(line => /^todo(?:\s|$)/.test(line)) + 3).every(line => !/step_1|Journey task/.test(line)), "an outcome without a checklist must not invent one");

    command("SEED_OUTCOME_TODO");
    const compact = wait(frame => /todo\s+[▸▾]\s{2}0\/9 complete/i.test(frame) && frame.includes("Seed complete"));
    assert.doesNotMatch(compact, /^\s*[▸▾]?\s*plan\s+\d+\/\d+/im);
    assert.equal(calls().length, 5, "each explicit seed turn makes one tool call and one follow-up");
    assert.equal(calls()[4].messages.findLast(message => message.role === "toolResult")?.isError, false, "todo update must succeed");
    assertCompactOutcome(compact, { mutedPrefix });

    execFileSync("tmux", ["-L", socket, "resize-window", "-t", "test", "-x", "40", "-y", "40"]);
    const narrow = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && frame.split("\n").some(line => /^\s{2}\S/.test(line) && line.trimEnd().endsWith("...")));
    const narrowRows = narrow.split("\n");
    const narrowIndex = narrowRows.findIndex(line => /^todo(?:\s|$)/.test(line));
    assert.ok(narrowIndex > 0, "the header survives 40 columns");
    assert.ok(narrowRows[narrowIndex].length <= 40, "the header fits 40 columns");
    assert.ok(narrowRows[narrowIndex + 1].length <= 40, "the subtitle fits 40 columns");
    assert.ok(narrowRows[narrowIndex + 1].trimEnd().endsWith("..."), "the subtitle truncates at 40 columns");
    assert.equal(narrowRows[narrowIndex + 2], "", "the narrow subtitle keeps one blank row before the checklist");
    send("EDITOR_BOUNDARY_SENTINEL");
    const withEditor = wait(frame => frame.includes("EDITOR_BOUNDARY_SENTINEL") && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame));
    assert.equal(withEditor.split("\n").filter(line => /^todo(?:\s|$)/.test(line)).length, 1, "the header never wraps into a second Todo row");
    assert.ok(!withEditor.split("\n").some(line => line.includes("EDITOR_BOUNDARY_SENTINEL") && /todo/.test(line)), "widget and editor must occupy separate rows at 40 columns");
    key("C-u");
    execFileSync("tmux", ["-L", socket, "resize-window", "-t", "test", "-x", "80", "-y", "40"]);
    // The header is right-aligned to the real terminal width, so a >40-column
    // row proves Pi has repainted after the grow before the next assertion.
    wait(frame => {
      const header = headerLine(frame);
      return header !== undefined && header.length > 40 && !frame.includes("EDITOR_BOUNDARY_SENTINEL");
    });

    command("/todo expand");
    wait(frame => /Journey task 9/.test(frame) && /^todo\s+▾\s{2}0\/9 complete/m.test(frame));
    command("/todo collapse");
    wait(frame => /^todo\s+▸\s{2}0\/9 complete/im.test(frame) && !frame.includes("Journey task 9"));
    command("/todo");
    let full = wait(frame => /^›.*step_1/m.test(frame) && frame.includes("中文任务"));
    assert.ok(full.replace(/\s/g, "").includes("中文任务验证长标签不会重叠并保持完整内容ABCDEFGHIJKLMN"), `long CJK label must wrap without losing content:\n${full}`);
    assert.match(full, /Outcome \(active\): Deliver the terminal journey/);
    assert.match(full, /Done when: Evidence is visible; Narrow widths stay readable/);
    assert.match(full, /Boundaries: Do not edit the legacy Plan package/);
    key("Down");
    full = wait(frame => /^›.*step_2/m.test(frame));
    assert.match(full, /step_1/, "dependent row must show its prerequisite");
    key("Escape");
    wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/im.test(frame) && !/^› /m.test(frame));

    setHooks(false);
    assert.deepEqual(preferences(), { version: 1, enabled: false, display: true });
    assert.ok(!probeState().active.some(name => ["update_todo", "get_todo"].includes(name)));
    const hooksOff = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/im.test(frame) && frame.includes("Journey task 1"));
    assertCompactOutcome(hooksOff, { mutedPrefix });
    command("/emit-goal-start");
    const ignored = wait(frame => frame.includes("Journey task 1") && !frame.includes("IGNORED_GOAL_OBJECTIVE"));
    assert.ok(!ignored.includes("IGNORED_GOAL_OBJECTIVE"), "hooks off must not write a Goal-bridged outcome");
    assert.equal(calls().length, 5, "the ignored Goal offer must not start a turn");
    command("OFF_PROBE_AGAIN");
    wait(frame => frame.includes("Probe complete") && calls().length === 6);
    const hooksOffCall = calls()[5];
    assert.ok(!hooksOffCall.messages.some(message => message.role === "custom" && String(message.customType ?? "").includes("outcome-reminder")),
      "hooks off must not inject an outcome reminder into the model context");
    assert.doesNotMatch(JSON.stringify(hooksOffCall.messages), /Choose work that advances this outcome/, "no reminder text may reach the model with hooks off");

    command("/todo expand");
    wait(frame => /Journey task 9/.test(frame));
    command("/todo collapse");
    wait(frame => /^todo\s+▸\s{2}0\/9 complete/im.test(frame) && !frame.includes("Journey task 9"));
    command("/todo");
    full = wait(frame => /^›.*step_1/m.test(frame) && frame.includes("中文任务"));
    assert.match(full, /Outcome \(active\): Deliver the terminal journey/);
    assert.match(full, /Done when: Evidence is visible; Narrow widths stay readable/);
    assert.match(full, /Boundaries: Do not edit the legacy Plan package/);
    key("Escape");
    wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/im.test(frame) && !/^› /m.test(frame));
    command("/todo hide");
    wait(frame => !headerLine(frame));
    command("/todo show");
    wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/im.test(frame));

    setDisplay(false);
    assert.deepEqual(preferences(), { version: 1, enabled: false, display: false });
    assertNoHeader(screen());
    setHooks(true);
    assert.deepEqual(preferences(), { version: 1, enabled: true, display: false });
    assert.ok(["update_todo", "get_todo"].every(name => probeState().active.includes(name)), "display off must not disable hooks");
    assertNoHeader(screen());
    setDisplay(true);
    wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/im.test(frame));

    command("/seed-bound-goal");
    wait(() => existsSync(boundReady));
    const bound = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame) && frame.includes("Reloaded keybindings"));
    assertCompactOutcome(bound, { bound: true, mutedPrefix });
    assertNoStandaloneGoal(bound);
    assert.equal(bound.split("\n").filter(line => /^todo(?:\s|$)/.test(line)).length, 1, "one compact header owns the bound Goal");

    setDisplay(false);
    const standalone = wait(frame => /^goal active \d+:\d{2}\b/m.test(frame) && !headerLine(frame));
    assert.match(standalone, new RegExp(`^goal active \\d+:\\d{2} ${objective.slice(0, 10)}`, "m"), "display off returns the clock to Goal's standalone line");
    setDisplay(true);
    const combined = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame));
    assertNoStandaloneGoal(combined);

    setHooks(false);
    assert.deepEqual(preferences(), { version: 1, enabled: false, display: true });
    const displayWithoutHooks = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame));
    assertCompactOutcome(displayWithoutHooks, { bound: true, mutedPrefix });
    assertNoStandaloneGoal(displayWithoutHooks);

    setHooks(true);
    assert.deepEqual(preferences(), { version: 1, enabled: true, display: true });
    wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && frame.includes("Journey task 1"));
    assert.equal(calls().length, 6, "settings, navigation, Goal display and toggles must not start agent turns");
    assert.ok(calls().every(call => !String(call.systemPrompt).includes("LEGACY_PLAN_PROMPT")), "legacy prompt hooks must never run");

    rmSync(ready, { force: true });
    command("/reload");
    wait(() => existsSync(ready));
    const reloaded = wait(frame => frame.includes("Reloaded keybindings") && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame));
    assertCompactOutcome(reloaded, { bound: true, mutedPrefix });
    assertNoStandaloneGoal(reloaded);
    const reloadedState = probeState();
    assert.deepEqual(reloadedState.settings.filter(item => item.id.startsWith("outcome-todo")), [
      { id: "outcome-todo-display", label: "Outcome & Todo display", value: "On" },
      { id: "outcome-todo", label: "Outcome & Todo hooks", value: "On" },
    ], "reload keeps exactly one control per id with its saved value");
    assert.ok(["update_todo", "get_todo"].every(name => reloadedState.active.includes(name)), "reload must retain the enabled Todo and its saved history");
    assert.deepEqual(readFileSync(legacyEffects, "utf8").trim().split("\n").map(JSON.parse), ["factory", "shutdown", "factory", "shutdown", "factory", "shutdown"], "each reload must mask Plan again without leaking listeners");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
}
