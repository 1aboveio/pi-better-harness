import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { currentInstructions, manageInstructions } from "../lib/instructions.mjs";

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
  assert.equal(manageInstructions("sync", agentDir), false);
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

test("Pi keeps the original system addendum across turns and compaction until resources reload", async t => {
  const { root, agentDir, setting } = await fixture(t);
  const file = join(agentDir, "supplement.md");
  await setting("supplement.md");
  await writeFile(file, "ORIGINAL_SUPPLEMENT");
  await writeFile(join(agentDir, "AGENTS.md"), "NATIVE_INSTRUCTIONS");
  assert.equal(manageInstructions("enable", agentDir), true);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const completion = { id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
    res.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
    apiKey: "test", models: [{ id: "local", name: "Local" }],
  } } }));
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
    modelsPath, modelsStorePath: join(agentDir, "models-store.json") });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 24 } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true });
  await resourceLoader.reload();
  const options = { cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime,
    model: modelRuntime.getModel("fixture", "local"), noTools: "all" };
  async function open() {
    const { session } = await createAgentSession({ ...options, sessionManager: SessionManager.inMemory(root) });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    return session;
  }
  const session = await open();
  assert.equal(requests.length, 0);
  await session.prompt("first ".repeat(160));
  await writeFile(file, "UPDATED_SUPPLEMENT");
  assert.equal(manageInstructions("sync", agentDir), true);
  await session.prompt("second ".repeat(160));
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
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
  checkSystem(requests.at(-1), "ORIGINAL_SUPPLEMENT", "UPDATED_SUPPLEMENT");
  await session.reload();
  await session.prompt("after reload");
  checkSystem(requests.at(-1), "UPDATED_SUPPLEMENT", "ORIGINAL_SUPPLEMENT");
});
