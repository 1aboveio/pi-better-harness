import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.PI_OUTCOME_TODO_TUI_CLI ?? process.env.PI_HARNESS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
const installed = process.env.PI_HARNESS_SETTINGS_PACKAGE_DIR;
const harness = installed ?? join(root, "packages/pi-better-harness");
const runtime = join(harness, "extensions/task-context/index.ts");
const settings = join(harness, "extensions/settings/index.ts");
const goal = installed ? join(installed, "extensions/goal/index.ts") : join(root, "packages/pi-better-goal/src/index.ts");
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = !tmuxAvailable ? "tmux is unavailable" : !existsSync(cli) ? "Pi CLI is unavailable" : false;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const objective = "Deliver the terminal journey with a compact Todo header that keeps every accepted outcome visible across narrow terminals";
const doneWhen = ["Evidence is visible", "Narrow widths stay readable"];
const boundaries = ["Do not edit the legacy Plan package"];

// @level e2e
// This starts the actual settings hub and task-context extension. Only the model is synthetic.
for (const legacyFirst of [true, false]) {
test(`Outcome & Todo masks legacy Plan loaded ${legacyFirst ? "before" : "after"} Harness and preserves native settings`, { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "outcome-todo-tui-"));
  const agent = join(dir, "agent");
  const fixture = join(dir, "fixture.mjs");
  const ready = join(dir, "ready");
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
  const system = context.messages.filter(message => message.role === 'system');
  const tools = context.tools ?? system.flatMap(message => message.toolsAdded ?? []);
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({tools: tools.map(t => t.name), systemPrompt:context.systemPrompt ?? system.map(message => message.content), messages: context.messages})+'\\n');
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
    const seen = new Set();
    while (!seen.has(current)) {
      if (current.includes(label)) return;
      seen.add(current);
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
    wait(frame => /Auto-start Goals\s+(?:On|Off)/.test(frame) &&
      /Project work ledger\s+(?:On|Off)/.test(frame));
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
  const setLedger = enabled => setSetting("Project work ledger", enabled);
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
  const startLabel = "[Start Goal · Alt+G]";
  const assertCompactOutcome = (frame, { bound = false, mutedPrefix } = {}) => {
    const rows = frame.split("\n");
    const index = rows.findIndex(line => /^todo(?:\s|$)/.test(line));
    assert.ok(index > 0, `compact Todo header must be visible:\n${frame}`);
    const header = rows[index];
    assert.match(header, /^todo\s+[▸▾]\s{2}0\/9 complete\b/, `Todo keeps the caret after its title and n/total on the left:\n${frame}`);
    if (bound) assert.match(header, /goal active\s+\d+:\d{2}\s*$/, `bound Goal status and active clock stay on the right:\n${frame}`);
    else assert.match(header, /goal saved\s*$/, "the saved Goal is visible before execution starts");
    const subtitle = rows[index + 1] ?? "";
    assert.ok(subtitle.trimStart().startsWith(objective.slice(0, 24)), `accepted Outcome is the subtitle:\n${frame}`);
    assert.ok(subtitle.trimEnd().endsWith("..."), `the Outcome subtitle must truncate instead of wrap:\n${frame}`);
    assert.equal(rows[index + 2]?.trim(), bound ? "" : startLabel);
    assert.ok(rows.slice(index + 3).some(line => /Journey task 1|step_1/.test(line)), "the checklist follows the blank row");
    assert.equal(rows.filter(line => /^\s*outcome\b/i.test(line)).length, 0, "no separate Outcome line is allowed");
    if (mutedPrefix) {
      const ansiRows = ansiScreen().split("\n").filter(row => row.includes(objective.slice(0, 24)));
      assert.ok(ansiRows.some(row => row.includes(mutedPrefix)),
        `the Outcome subtitle must use ${JSON.stringify(mutedPrefix)}: ${JSON.stringify(ansiRows)}`);
    }
    return { rows, index, header, subtitle };
  };
  try {
    assert.ok(existsSync(runtime), `Outcome & Todo runtime is missing: ${runtime}`);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    let ledgerId;
    try {
      const { openWorkLedgerStore } = await import(new URL("../packages/pi-better-harness/extensions/task-context/work-ledger.ts", import.meta.url).href);
      ledgerId = openWorkLedgerStore({ cwd: dir }).create({
        outcome: "Deliver the durable terminal journey",
        items: [
          { id: "api", title: "Ship API", status: "completed", evidence: ["Focused tests passed"] },
          { id: "worker", title: "Ship worker", status: "in_progress", nextStep: "Wire the queue" },
          { id: "integrate", title: "Integrate the journey" },
        ],
      }).id;
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    const ordered = legacyFirst ? [join(legacy, "index.ts"), runtime] : [runtime, join(legacy, "index.ts")];
    const launch = [`cd ${quote(dir)} && exec env`, `PI_CODING_AGENT_DIR=${quote(agent)}`, "PI_OFFLINE=1", quote(cli),
      "--approve --no-skills --no-context-files", "-e", quote(settings), "-e", quote(goal), ...ordered.flatMap(path => ["-e", quote(path)]), "-e", quote(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "80", "-y", "40", launch);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    const readyState = JSON.parse(readFileSync(ready, "utf8"));
    const mutedPrefix = readyState.themeMuted.split("X")[0].match(/\x1b\[[0-9;]*m/g)?.at(-1);

    const fresh = probeState();
    assert.ok(["update_todo", "get_todo"].every(name => fresh.active.includes(name)));
    assert.deepEqual(fresh.settings.filter(item => item.id.startsWith("outcome-todo")), [
      { id: "outcome-todo-ledger", label: "Long-term work ledger", value: "Off" },
    ], "only the independent ledger has a Todo setting");
    assert.ok(!fresh.all.includes("work_ledger"), "the unified interface adds no public work_ledger tool");
    assert.deepEqual(readFileSync(legacyEffects, "utf8").trim().split("\n").map(JSON.parse), ["factory", "shutdown"], "legacy factory listeners must be cleaned up before startup");
    assert.doesNotMatch(screen(), /LEGACY_PLAN_WIDGET/);
    assertNoHeader(screen());
    assert.doesNotMatch(screen(), /^\s*[▸▾]?\s*todo\s+\d+\/\d+/im);

    command("OFF_PROBE");
    wait(frame => frame.includes("Probe complete"));
    assert.equal(calls().length, 1);
    assert.ok(["update_todo", "get_todo"].every(name => calls()[0].tools?.includes(name)), JSON.stringify(calls()[0].tools));

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
    assert.doesNotMatch(compact, /^\s*ledger /m, "a fresh session must not adopt a project ledger automatically");

    setLedger(true);
    assert.deepEqual(preferences(), { version: 1, ledger: true });
    command(`/ledger attach ${ledgerId}`);
    const withLedger = wait(frame => /^\s*ledger 1\/3 complete · 2 open · next: Ship worker/m.test(frame) && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame));
    const ledgerRows = withLedger.split("\n");
    const ledgerIndex = ledgerRows.findIndex(line => /^todo(?:\s|$)/.test(line));
    assert.match(ledgerRows[ledgerIndex + 1], new RegExp(objective.slice(0, 24)), "the Outcome subtitle stays first");
    assert.match(ledgerRows[ledgerIndex + 2], /^\s*ledger 1\/3 complete · 2 open · next: Ship worker/, "the existing Todo surface carries the ledger counts");
    assert.equal(ledgerRows[ledgerIndex + 3].trim(), startLabel);
    assert.equal(ledgerRows.filter(line => /^\s*ledger .*complete/.test(line)).length, 1, "the ledger adds no second widget");
    command("/ledger detach");
    const withoutLedger = wait(frame => !/^\s*ledger .*complete/m.test(frame) && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame));
    assertCompactOutcome(withoutLedger, { mutedPrefix });

    execFileSync("tmux", ["-L", socket, "resize-window", "-t", "test", "-x", "40", "-y", "40"]);
    const narrow = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && frame.split("\n").some(line => /^\s{2}\S/.test(line) && line.trimEnd().endsWith("...")));
    const narrowRows = narrow.split("\n");
    const narrowIndex = narrowRows.findIndex(line => /^todo(?:\s|$)/.test(line));
    assert.ok(narrowIndex > 0, "the header survives 40 columns");
    assert.ok(narrowRows[narrowIndex].length <= 40, "the header fits 40 columns");
    assert.ok(narrowRows[narrowIndex + 1].length <= 40, "the subtitle fits 40 columns");
    assert.ok(narrowRows[narrowIndex + 1].trimEnd().endsWith("..."), "the subtitle truncates at 40 columns");
    assert.equal(narrowRows[narrowIndex + 2].trim(), startLabel);
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
    command("/todo hide");
    wait(frame => !headerLine(frame));
    command("/todo");
    const revealed = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) &&
      frame.includes("Deliver the terminal journey") && !/^› /m.test(frame));
    assert.doesNotMatch(revealed, /Goal \(saved\):|↑↓ navigate/, "/todo must reveal the compact overview, not the removed full view");
    assert.ok(revealed.split("\n").some(line => /Journey task 1|step_1/.test(line)), "the revealed overview keeps its checklist");
    send("TODO_OVERVIEW_EDITOR_SENTINEL");
    const overviewWithEditor = wait(frame => frame.includes("TODO_OVERVIEW_EDITOR_SENTINEL") && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame));
    assert.ok(!overviewWithEditor.split("\n").some(line => line.includes("TODO_OVERVIEW_EDITOR_SENTINEL") && /todo/.test(line)),
      "revealing the overview leaves the editor active");
    key("C-u");

    setSetting("Auto-start Goals", true);
    setSetting("Auto-start Goals", false);
    assert.equal(calls().length, 5, "changing auto-start never starts existing work");

    rmSync(ready);
    command("/reload");
    wait(() => existsSync(ready));
    const savedFrame = wait(frame => frame.includes(startLabel) && frame.includes("Reloaded keybindings"));
    if (process.env.PI_TODO_TUI_MOUSE === "1" && legacyFirst) {
      const rows = savedFrame.split("\n");
      const y = rows.findIndex(row => row.includes(startLabel)) + 1;
      const x = rows[y - 1].indexOf(startLabel) + 2;
      send(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    } else {
      key("M-g");
    }
    const bound = wait(frame => /goal active\s+\d+:\d{2}\s*$/m.test(frame) && calls().length === 6);
    assert.ok(!bound.includes(startLabel), "the started Goal loses its Start button");
    assertCompactOutcome(bound, { bound: true, mutedPrefix });
    assertNoStandaloneGoal(bound);
    assert.equal(bound.split("\n").filter(line => /^todo(?:\s|$)/.test(line)).length, 1, "one compact header owns the bound Goal");

    command("/todo hide");
    const standalone = wait(frame => /^goal active \d+:\d{2}\b/m.test(frame) && !headerLine(frame));
    assert.match(standalone, new RegExp(`^goal active \\d+:\\d{2} ${objective.slice(0, 10)}`, "m"), "display off returns the clock to Goal's standalone line");
    command("/todo show");
    const combined = wait(frame => /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame));
    assertNoStandaloneGoal(combined);

    assert.equal(calls().length, 6, "starting queues one turn and changing display queues none");
    assert.ok(calls().every(call => !String(call.systemPrompt).includes("LEGACY_PLAN_PROMPT")), "legacy prompt hooks must never run");

    rmSync(ready, { force: true });
    command("/reload");
    wait(() => existsSync(ready));
    const reloaded = wait(frame => frame.includes("Reloaded keybindings") && /^todo\s+[▸▾]\s{2}0\/9 complete/m.test(frame) && /active\s+\d+:\d{2}\s*$/m.test(frame));
    assertCompactOutcome(reloaded, { bound: true, mutedPrefix });
    assertNoStandaloneGoal(reloaded);
    const reloadedState = probeState();
    assert.deepEqual(reloadedState.settings.filter(item => item.id.startsWith("outcome-todo")), [
      { id: "outcome-todo-ledger", label: "Long-term work ledger", value: "On" },
    ], "reload keeps exactly one control per id with its saved value");
    assert.ok(!reloadedState.all.includes("work_ledger"), "reload keeps the unified interface free of a public ledger tool");
    assert.ok(["update_todo", "get_todo"].every(name => reloadedState.active.includes(name)), "reload must retain the enabled Todo and its saved history");
    assert.deepEqual(readFileSync(legacyEffects, "utf8").trim().split("\n").map(JSON.parse), ["factory", "shutdown", "factory", "shutdown", "factory", "shutdown"], "each reload must mask Plan again without leaking listeners");
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
}
