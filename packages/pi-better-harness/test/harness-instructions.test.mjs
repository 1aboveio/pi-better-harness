import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { activatePrompt, currentInstructions, manageInstructions, promptSource } from "../lib/instructions.mjs";
import { activeRevision, bundledRevision, createCandidate, history, readRevision, recordEvaluation, selectRevision } from "../lib/prompt-revisions.mjs";
import { fileURLToPath } from "node:url";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-instructions-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, agentDir, setting: instructionsFile => writeFile(join(agentDir, "settings.json"),
    JSON.stringify({ piBetterHarness: { instructionsFile } })) };
}

test("the opt-in block preserves surrounding bytes and edits made by other tools", async t => {
  const { agentDir, root, setting } = await fixture(t);
  const target = join(root, "dotfile.md");
  const path = join(agentDir, "APPEND_SYSTEM.md");
  const original = "\uFEFF<!-- other plugin -->\r\nUser text without a final newline";
  await writeFile(target, original);
  await symlink(target, path);
  await setting("supplement.md");
  const source = join(agentDir, "supplement.md");
  // Unmanaged dotfiles must be readable even when the adjacent lock is unavailable.
  await mkdir(target + ".lock");
  await chmod(root, 0o555);
  try {
    assert.equal(manageInstructions("sync", agentDir), false);
    assert.equal(manageInstructions("disable", agentDir), false);
    assert.equal(await readFile(path, "utf8"), original);
  } finally {
    await chmod(root, 0o755);
  }
  await rm(target + ".lock", { recursive: true });
  await writeFile(source, "First version");
  assert.equal(manageInstructions("enable", agentDir), true);
  const first = await readFile(path, "utf8");
  assert.ok(first.includes("First version"));
  assert.equal(manageInstructions("enable", agentDir), false);
  await writeFile(path, first.replace("User text", "Edited user text") + "\r\nAnother plugin");
  await writeFile(source, "Second version");
  assert.equal(manageInstructions("sync", agentDir), true);
  assert.ok(!(await readFile(path, "utf8")).includes("First version"));
  assert.equal(manageInstructions("disable", agentDir), true);
  assert.equal(await readFile(path, "utf8"), original.replace("User text", "Edited user text") + "\r\nAnother plugin");
  assert.ok((await lstat(path)).isSymbolicLink());
  assert.equal(manageInstructions("disable", agentDir), false);
});

test("saving an open editor cannot overwrite a newer prompt or re-enable a disabled block", async t => {
  const { agentDir, setting } = await fixture(t);
  await setting("source.md");
  const source = join(agentDir, "source.md");
  await writeFile(source, "First");
  manageInstructions("enable", agentDir);
  const edit = { previous: currentInstructions(agentDir), saveSource: () => assert.fail("Stale edit saved") };
  await writeFile(source, "Second");
  manageInstructions("sync", agentDir);
  assert.throws(() => manageInstructions("sync", agentDir, edit), /changed/);
  assert.equal(currentInstructions(agentDir), "Second");
  manageInstructions("disable", agentDir);
  assert.throws(() => manageInstructions("sync", agentDir, edit), /changed/);
  assert.equal(currentInstructions(agentDir), undefined);
});

test("missing or ambiguous delimiters leave the shared file untouched", async t => {
  const { agentDir } = await fixture(t);
  const path = join(agentDir, "APPEND_SYSTEM.md");
  const begin = "<!-- pi-better-harness:instructions:begin -->";
  const end = "<!-- pi-better-harness:instructions:end -->";
  for (const content of [begin, end, [end, begin].join("\n"), [begin, begin, end].join("\n")]) {
    await writeFile(path, content);
    assert.throws(() => manageInstructions("disable", agentDir), /Ambiguous/);
    assert.equal(await readFile(path, "utf8"), content);
  }
});

test("modular rendering identifies invalid sources and respects saved text, custom files and Off", async t => {
  const { root, agentDir, setting } = await fixture(t);
  assert.equal(promptSource(agentDir), "off");
  manageInstructions("enable", agentDir);
  const installed = currentInstructions(agentDir);
  assert.equal(installed, bundledRevision().rendered);
  await writeFile(join(root, "AGENTS.md"), "{{../outside}}");
  assert.throws(() => bundledRevision(root), /AGENTS.md/);
  assert.equal(currentInstructions(agentDir), installed);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piBetterHarness: { instructionsPrompt: "Saved.", instructionsFile: "missing" } }));
  manageInstructions("sync", agentDir);
  assert.equal(promptSource(agentDir), "saved prompt");
  assert.equal(currentInstructions(agentDir), "Saved.");
  await setting("source.md");
  await writeFile(join(agentDir, "source.md"), "Custom.");
  manageInstructions("sync", agentDir);
  assert.equal(currentInstructions(agentDir), "Custom.");
  await setting(false);
  manageInstructions("sync", agentDir);
  assert.equal(currentInstructions(agentDir), undefined);
});

test("concurrent promotions accept one expected revision and interruption can be retried", async t => {
  const { agentDir } = await fixture(t);
  manageInstructions("enable", agentDir);
  const base = activeRevision(agentDir);
  const change = text => {
    const to = createCandidate(agentDir, base.id, base.id, "communication", text).id;
    const evidence = recordEvaluation(agentDir, { active: base.id, candidate: to, judgment: "Clearer." });
    return { from: base.id, to, evidence, action: "promote" };
  };
  const options = [change("State the result first."), change("Lead with the pending check.")];
  const moduleUrl = new URL("../lib/instructions.mjs", import.meta.url).href;
  const changes = await Promise.allSettled(options.map(option => promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `import {activatePrompt} from ${JSON.stringify(moduleUrl)}; activatePrompt(process.argv[1], JSON.parse(process.argv[2]));`,
    agentDir, JSON.stringify(option)])));
  assert.equal(changes.filter(r => r.status === "fulfilled").length, 1);
  const [winner] = history(agentDir);
  assert.equal(history(agentDir).length, 1);
  assert.equal(currentInstructions(agentDir), readRevision(agentDir, winner.to).rendered);
  assert.throws(() => createCandidate(agentDir, winner.to, base.id, "verification", "stale"), /Stale/);
  const rollback = { from: winner.to, to: base.id, action: "rollback" };
  selectRevision(agentDir, rollback); // Simulate exit after the durable selection, before block replacement.
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), await readFile(join(agentDir, "APPEND_SYSTEM.md"), "utf8") + "Keep my edit.");
  activatePrompt(agentDir, rollback);
  assert.equal(history(agentDir).length, 2);
  assert.equal(currentInstructions(agentDir), base.rendered);
  assert.ok((await readFile(join(agentDir, "APPEND_SYSTEM.md"), "utf8")).endsWith("Keep my edit."));
});

test("Pi gives trusted project and explicit append sources precedence over modular instructions", async t => {
  const { root, agentDir } = await fixture(t);
  manageInstructions("enable", agentDir);
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "APPEND_SYSTEM.md"), "Project appendix");
  const settingsManager = SettingsManager.inMemory({});
  settingsManager.setProjectTrusted(true);
  for (const appendSystemPrompt of [undefined, ["Explicit appendix"]]) {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, appendSystemPrompt, noExtensions: true });
    await loader.reload();
    assert.deepEqual(loader.getAppendSystemPrompt(), appendSystemPrompt ?? ["Project appendix"]);
  }
});

test("Pi replays a captured writing request, promotes the edit on reload and rolls it back", async t => {
  const { root, agentDir } = await fixture(t);
  await writeFile(join(agentDir, "AGENTS.md"), "NATIVE_INSTRUCTIONS");
  assert.equal(manageInstructions("enable", agentDir), true);
  const originalFile = await readFile(join(agentDir, "APPEND_SYSTEM.md"));
  const originalPrompt = currentInstructions(agentDir);
  const replacement = "Name the outstanding check in the first sentence.";
  const requests = [];
  let requestTool = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const content = requests.at(-1).messages[0].content.includes(replacement) ? "Deployment verification is pending." : "Unit checks passed.";
    const choice = requestTool
      ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: "fixture", type: "function", function: { name: "write", arguments: "{}" } }] }, finish_reason: "tool_calls" }
      : { delta: { role: "assistant", content }, finish_reason: "stop" };
    const completion = { id: "test", choices: [{ index: 0, ...choice }] };
    res.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
    apiKey: "test", models: [{ id: "local", name: "Local" }, { id: "second", name: "Second" }],
  } } }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
    modelsPath, modelsStorePath: join(agentDir, "models-store.json") });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 24 } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/harness-instructions/index.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const options = { cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime,
    model: modelRuntime.getModel("fixture", "local") };
  let approved = false;
  async function open() {
    const { session } = await createAgentSession({ ...options, sessionManager: SessionManager.inMemory(root) });
    t.after(() => session.dispose());
    await session.bindExtensions({ uiContext: { notify() {}, confirm: async () => approved } });
    return session;
  }
  const session = await open();
  assert.equal(requests.length, 0);
  const call = async (tool, args) => {
    const runner = session.extensionRunner;
    const result = await runner.getToolDefinition("prompt_" + tool).execute("test", args, undefined, undefined, runner.createContext());
    return result.details;
  };
  await session.prompt("Unit checks passed. Deployment verification is pending.");
  await session.prompt("/prompt-capture");
  await session.prompt("Can we close delivery?");
  const selected = structuredClone(requests.at(-1));
  await session.prompt("Later, unrelated message.");
  const { active, captured } = await call("list", {});
  const { text } = await call("read", { revision: active, module: "verification" });
  await assert.rejects(call("edit", { base: active, module: "../settings", text: replacement }), /Unknown module/);
  await assert.rejects(call("edit", { base: active, module: "verification", text: " " }), /Empty/);
  const edit = await call("edit", { base: active, module: "verification", text: replacement });
  assert.equal((await call("read", { revision: edit.id, module: "verification" })).text, replacement);
  const second = await call("edit", { base: edit.id, module: "verification", text: replacement + " Be concise." });
  assert.equal(second.parent, edit.id);
  await assert.rejects(call("replay", { caseId: "absent", candidate: edit.id }), /Missing pre-answer input/);
  assert.equal(currentInstructions(agentDir), originalPrompt);
  const replay = await call("replay", { caseId: captured, candidate: edit.id });
  const [baseline, candidate] = requests.slice(-2);
  assert.deepEqual(baseline, selected);
  assert.ok(baseline.tools.length > 0);
  assert.deepEqual(candidate, { ...selected, messages: selected.messages.map((m, i) =>
    i === 0 ? { ...m, content: m.content.replace(text, replacement) } : m) });
  assert.deepEqual(replay.difference.added, ["Deployment verification is pending."]);
  const { evaluation } = await call("compare", { runId: replay.id, rubric: "Identify pending checks", judgment: "Candidate names the blocker." });
  await assert.rejects(call("promote", { from: active, to: edit.id, evidence: evaluation }), /confirmation/);
  approved = true;
  requestTool = true;
  const beforeReplay = session.messages.slice();
  const needsTurn = await call("replay", { caseId: captured, candidate: second.id });
  assert.equal(needsTurn.requiresTurnReplay, true);
  assert.deepEqual(session.messages, beforeReplay);
  const inconclusive = await call("compare", { runId: needsTurn.id, rubric: "Writing", judgment: "Tool requested." });
  await assert.rejects(call("promote", { from: active, to: second.id, evidence: inconclusive.evaluation }), /completed comparison/);
  requestTool = false;
  await call("promote", { from: active, to: edit.id, evidence: evaluation });
  await session.setModel(modelRuntime.getModel("fixture", "second"));
  await session.prompt("after model switch");
  checkSystem(requests.at(-1), text, replacement);
  await session.compact();
  await session.prompt("after compaction");
  function checkSystem(request, expected, absent) {
    const first = request.messages[0];
    assert.ok(["system", "developer"].includes(first.role));
    assert.ok(JSON.stringify(first.content).includes("NATIVE_INSTRUCTIONS"));
    assert.ok(JSON.stringify(first.content).includes(expected));
    const history = JSON.stringify(request.messages);
    assert.equal(history.split(expected).length - 1, 1);
    assert.ok(!history.includes(absent));
  }
  checkSystem(requests.at(-1), text, replacement);
  await session.reload();
  await session.prompt("after reload");
  checkSystem(requests.at(-1), replacement, text);
  await call("rollback", { from: edit.id, to: active });
  assert.deepEqual(await readFile(join(agentDir, "APPEND_SYSTEM.md")), originalFile);
});
