import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../lib/prompt-tools.mjs";
import { manageInstructions, currentInstructions } from "../lib/instructions.mjs";
import { activeRevision, begin, end } from "../lib/prompt-revisions.mjs";
import { replayTurn } from "../lib/prompt-turn.mjs";
import { startPromptWeb } from "../lib/prompt-web.mjs";

const text = content => ({ role: "assistant", content });
const user = content => ({ role: "user", content });
const action = (name, args) => ({ id: "fixture-" + name, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolReply = (call, content) => ({ role: "tool", tool_call_id: call.id, content });
const edited = "Answer narrow status questions directly. Keep material qualifications.";

async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "prompt-experiment-"));
  const dir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { force: true, recursive: true });
  });
  manageInstructions("enable", dir);
  const active = activeRevision(dir).id;
  const system = { role: "system", content: [begin, currentInstructions(dir), end].join("\n") };
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    const answer = respond(body);
    const choice = typeof answer === "string" ? { delta: { content: answer }, finish_reason: "stop" }
      : { delta: { tool_calls: [{ index: 0, ...answer }] }, finish_reason: "tool_calls" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const model = { api: "openai-completions", id: "local", provider: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const ctx = { cwd, hasUI: true, model, ui: { confirm: async () => true, notify() {} },
    getSystemPrompt: () => system.content, modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) } };
  const tools = new Map(), commands = new Map(), events = new Map();
  const open = () => register({ registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, cmd) => commands.set(name, cmd),
    on: (name, handler) => events.set(name, handler) });
  open();
  const call = async (name, args, signal) => (await tools.get("prompt_" + name).execute("id", args, signal, undefined, ctx)).details;
  const command = (name, arg = "") => commands.get("prompt-" + name).handler(arg, ctx);
  const event = (name, data) => events.get(name)(data, ctx);
  const request = messages => event("before_provider_request", { payload: { stream: true, model: "local", messages: [system, ...messages] } });
  const reference = () => event("message_end", { message: { ...text([{ type: "text", text: "Original answer" }]), stopReason: "stop" } });
  const { id: candidate } = await call("edit", { base: active, module: "communication", text: edited });
  return { dir, cwd, calls, ctx, active, candidate, open, event, call, command, request, reference };
}

test("paired tool and task replay retain traces, restore dirty input and run independent checks", async t => {
  const read = action("read", { path: "notes.txt" });
  const write = value => action("write", { path: "notes.txt", content: value });
  let outside = false;
  let varyWrite = false;
  const f = await fixture(t, body => {
    const last = body.messages.at(-1);
    if (last.content === "Verify.") return "Done.";
    if (last.role === "user") return outside ? action("bash", { command: "external operation" }) : read;
    if (last.tool_call_id === read.id) return write(varyWrite && body.messages[0].content.includes(edited) ? "candidate" : "baseline");
    return "Finished.";
  });
  const git = (...args) => execFileSync("git", ["-C", f.cwd, ...args], { stdio: "pipe" });
  git("init");
  await writeFile(join(f.cwd, "notes.txt"), "committed");
  git("add", "notes.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
  await writeFile(join(f.cwd, "notes.txt"), "uncommitted");
  const spec = { turns: 2, required: ["notes.txt"], checks: [{ path: "notes.txt", equals: "candidate" }] };
  await writeFile(join(f.cwd, "task.json"), JSON.stringify({ ...spec, required: ["missing"] }));
  await assert.rejects(f.command("task-capture", "task.json"), /Missing required regular file: missing/);
  await writeFile(join(f.cwd, "task.json"), JSON.stringify(spec));
  await f.command("task-capture", "task.json");
  const messages = [user("Update notes.")];
  f.request(messages);
  f.reference();
  messages.push({ role: "assistant", tool_calls: [read] }, toolReply(read, "uncommitted"));
  f.request(messages);
  messages.push({ role: "assistant", tool_calls: [write("baseline")] }, toolReply(write("baseline"), "Wrote notes."));
  f.request(messages);
  f.event("agent_end", {});
  messages.push(text("Finished."), user("Verify."));
  f.request(messages);
  f.event("agent_end", {});
  const args = { caseId: (await f.call("list", {})).captured, candidate: f.candidate, budget: 6 };
  const turn = await f.call("turn_replay", args);
  assert.equal(turn.baselineOutput.status, "completed");
  assert.deepEqual(turn.candidateOutput, turn.baselineOutput);
  assert.deepEqual(turn.baselineOutput.trace.filter(e => e.name).map(e => [e.name, e.content]), [["read", "uncommitted"], ["write", "Wrote notes."]]);
  varyWrite = true;
  const divergent = await f.call("turn_replay", args);
  assert.equal(divergent.candidateOutput.status, "diverged");
  assert.deepEqual(divergent.candidateOutput.trace.at(-1).expected.args, { path: "notes.txt", content: "baseline" });
  assert.equal((await f.call("turn_replay", { ...args, budget: 1 })).baselineOutput.status, "budget");
  const task = await f.call("task_replay", args);
  assert.equal(task.restored.head, git("rev-parse", "HEAD").toString().trim());
  for (const [arm, value] of [[task.baselineOutput, "baseline"], [task.candidateOutput, "candidate"]]) {
    assert.equal(arm.turns.length, 2);
    assert.equal(arm.head, task.restored.head);
    assert.equal(arm.status, "completed");
    assert.deepEqual(arm.diff, [{ path: "notes.txt", before: "uncommitted", after: value }]);
    assert.equal(arm.checks[0].passed, value === "candidate");
    assert.equal(arm.budget, 6);
  }
  outside = true;
  assert.equal((await f.call("task_replay", args)).baselineOutput.turns[0].trace.at(-1).reason, "Unsupported tool in isolated task");
  assert.equal((await f.call("task_replay", args, AbortSignal.abort())).baselineOutput.status, "cancelled");
  assert.equal(await readFile(join(f.cwd, "notes.txt"), "utf8"), "uncommitted");
  assert.equal(activeRevision(f.dir).id, f.active);
  f.event("session_shutdown", {});
});

test("cancellation preserves the partial tool trace", async () => {
  const control = new AbortController();
  const call = action("write", { path: "file", content: "test" });
  const result = await replayTurn({ messages: [] }, { budget: 4, signal: control.signal,
    generate: () => ({ text: "", finish: "tool_calls", calls: [call] }),
    dispatch: () => { control.abort(); return { content: "recorded result" }; } });
  assert.equal(result.status, "cancelled");
  assert.equal(result.trace.at(-1).content, "recorded result");
});

test("browser replays a named session capture and TUI evaluates the selected revision; evidence survives restart", async t => {
  const f = await fixture(t, body => body.messages[0].content.includes(edited) ? "Passed." : "Passed. Deployment pending.");
  const web = await startPromptWeb(f.dir);
  t.after(() => web.close());
  const url = new URL(web.url);
  const api = async args => {
    const res = await fetch(url.origin + "/api", { method:"POST", headers:{ origin:url.origin, "content-type":"application/json",
      authorization:"Bearer " + url.hash.slice(1) }, body:JSON.stringify(args) });
    const response = await res.json();
    if (!res.ok) throw Error(response.error);
    return response.result;
  };
  const notifications = [];
  const displays = [];
  let queue = [];
  f.ctx.ui.notify = (msg, level) => { if (level === "error") notifications.push(msg); };
  f.ctx.ui.select = async (title, choices) => {
    const next = queue.shift();
    if (next === "candidate") return choices.find(v => v.includes(f.candidate.slice(0,10)));
    if (next === "first") return choices[0];
    return next;
  };
  f.ctx.ui.input = async () => "1";
  f.ctx.ui.editor = async (_, value) => { displays.push(value); };
  queue = ["Connect browser", "Close"];
  await f.command("manager");
  const session = (await api({ action:"state" })).connections[0].id;
  const pair = {session,base:f.active,candidate:f.candidate};
  await assert.rejects(api({action:"replay", ...pair}), /Missing pre-answer/);
  await f.command("capture");
  f.request([user("Did tests pass?")]);
  f.reference(); f.event("agent_end",{});
  const connected = await api({action:"state", ...pair});
  assert.equal(connected.session.name, f.cwd);
  const [{id:caseId,label}] = connected.session.captures;
  assert.equal(label,"Did tests pass?");
  const replay = await api({action:"replay", ...pair, caseId});
  assert.equal(replay.active,f.active); assert.equal(replay.candidate,f.candidate);
  assert.notEqual(replay.baselineOutput.text,replay.candidateOutput.text);
  await api({action:"judge", ...pair, evidence:replay.evidenceId, judgment:"Direct answer."});
  queue = ["Choose revision","candidate","Evaluate a case suite","first","first","Close"];
  await f.command("manager");
  assert.deepEqual(notifications,[]);
  assert.ok(displays.at(-1).includes("Samples per case: 1"));
  const suite = (await api({action:"state", ...pair})).evidence.find(e => e.results);
  assert.equal(suite.results.length,3); assert.equal(suite.model,"fixture/local");
  assert.equal(suite.active,f.active); assert.equal(suite.candidate,f.candidate);
  f.event("session_shutdown",{}); f.open();
  await assert.rejects(api({action:"replay", ...pair, caseId}), /disconnected/);
  const state = await api({action:"state", ...pair});
  assert.equal(state.active,f.active); assert.match(state.problem,/disconnected/);
  assert.ok(state.evidence.some(e => e.judgment === "Direct answer."));
  queue = ["Choose revision","candidate","Evidence","first",undefined,"Close"];
  await f.command("manager");
  assert.ok(displays.at(-1).includes(f.candidate));
  f.ctx.model.api = "unsupported";
  queue = ["Choose revision","candidate","Evaluate a case suite","Close"];
  await f.command("manager");
  assert.match(notifications.at(-1),/No supported/);
});

test("reviewed case export, portable evaluation, repeated failures and explicit proposal promotion", async t => {
  const f = await fixture(t, body => {
    if (body.messages.at(-1).content.includes("close delivery")) return body.messages[0].content.includes("Drop every qualification.") ? "Close delivery." : "Deployment is pending.";
    return body.messages[0].content.includes(edited) ? "Passed." : "Passed. Deployment is pending.";
  });
  await f.command("capture");
  f.request([user("Did the unit tests pass?")]);
  f.reference();
  f.event("agent_end", {});
  assert.equal(f.calls.length, 0);
  const { captured } = await f.call("list", {});
  await f.call("replay", { caseId: captured, candidate: f.candidate });
  f.ctx.ui.editor = async (_, draft) => {
    const suite = JSON.parse(draft);
    Object.assign(suite.cases[0], { expected: "Passed", counterexample: "Discuss deployment", failure: "irrelevant qualification",
      rubric: { required: ["pass"], forbidden: ["deploy"] } });
    return JSON.stringify(suite);
  };
  await f.command("export", "reviewed.json");
  f.event("session_shutdown", {});
  f.open();
  await f.command("import", "reviewed.json");
  const exported = await f.call("evaluate", { candidate: f.candidate, samples: 2 });
  assert.equal(exported.results[0].samples.length, 2);
  assert.deepEqual(exported.results[0].samples.map(s => [s.baseline.status, s.candidate.status]), [["fail", "pass"], ["fail", "pass"]]);
  assert.equal(exported.results[0].config.provider, "fixture");
  const suite = JSON.parse(await readFile(join(f.cwd, "reviewed.json")));
  suite.cases.push({ ...suite.cases[0], id: "missing", payload: {} }, { ...suite.cases[0], id: "unsupported", level: "task" });
  await writeFile(join(f.cwd, "mixed.json"), JSON.stringify(suite));
  await f.command("import", "mixed.json");
  assert.deepEqual((await f.call("evaluate", { samples: 1 })).results.map(c => c.status), ["scored", "missing_input", "unsupported"]);
  await f.command("import");
  await f.call("evaluate", { samples: 1 });
  const propose = { failures: ["unit-status", "format-status"], counterexample: "delivery-status", module: "communication", text: edited };
  await assert.rejects(f.call("propose", propose), /Enable/);
  await f.command("learning", "on");
  const regressing = await f.call("propose", { ...propose, text: edited + " Drop every qualification." });
  assert.deepEqual(regressing.after.results.map(r => r.samples[0].candidate.status), ["pass", "pass", "fail"]);
  const proposal = await f.call("propose", propose);
  assert.deepEqual(proposal.after.results.map(r => r.samples[0].candidate.status), ["pass", "pass", "pass"]);
  assert.equal(proposal.id, f.candidate);
  const judgment = { candidate: proposal.id, judgment: "Narrow answers improved and the qualification survived." };
  await f.command("learning", "discard");
  await assert.rejects(f.call("judge_proposal", judgment), /discarded/);
  assert.equal((await f.call("propose", propose)).id, proposal.id);
  assert.equal(activeRevision(f.dir).id, f.active);
  const { evaluation } = await f.call("judge_proposal", judgment);
  await f.call("promote", { from: f.active, to: proposal.id, evidence: evaluation });
  assert.equal(activeRevision(f.dir).id, proposal.id);
});
