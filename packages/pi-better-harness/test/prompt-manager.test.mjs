import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { currentInstructions, manageInstructions } from "../lib/instructions.mjs";
import { activeRevision, createCandidate } from "../lib/prompt-revisions.mjs";

async function browser(t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/pi-better-harness.mjs", import.meta.url)), "instructions", "web"],
    { env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "inherit"] });
  const closed = once(child, "exit");
  t.after(async () => { child.kill(); await closed; });
  const [line] = await Promise.race([once(child.stdout, "data"), closed.then(() => { throw Error("Web CLI exited"); })]);
  const { origin, hash } = new URL(line.toString().trim());
  async function send(args, overrides) {
    return fetch(origin + "/api", { method: "POST", headers: { origin, authorization: "Bearer " + hash.slice(1),
      "content-type": "application/json", ...overrides }, body: JSON.stringify(args) });
  }
  return { origin, send, async api(args) {
    const res = await send(args);
    const data = await res.json();
    if (!res.ok) throw Error(data.error);
    return data.result;
  } };
}

test("settings TUI saves a module without a provider, standalone Web publishes, Pi reloads and TUI rolls back", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-manager-"));
  const dir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(dir);
  manageInstructions("enable", dir);
  const original = await readFile(join(dir, "APPEND_SYSTEM.md"));
  const active = activeRevision(dir).id;
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ agentDir: dir, cwd:root, settingsManager, noExtensions:true, noSkills:true,
    additionalExtensionPaths: ["settings", "harness-instructions"].map(ext => fileURLToPath(new URL("../extensions/" + ext + "/index.ts", import.meta.url))) });
  await resourceLoader.reload();
  const runtime = await ModelRuntime.create({ credentials:new InMemoryCredentialStore(), refreshOnCreate:false,
    modelsPath:join(dir,"models.json"), modelsStorePath:join(dir,"models-store.json") });
  const { session } = await createAgentSession({ agentDir:dir,cwd:root,settingsManager,resourceLoader,modelRuntime:runtime,sessionManager:SessionManager.inMemory(root) });
  t.after(() => session.dispose());
  const queue = ["Modules","verification","Edit text","Save candidate","Close"];
  let menuVisits = 0;
  const errors = [];
  await session.bindExtensions({ mode:"tui", uiContext: {
    custom: async () => menuVisits++ === 0 ? "link:prompt-manager" : undefined,
    select: async (_, items) => {
      const wanted = queue.shift();
      if (wanted === "latest") return items[0];
      if (wanted && !items.includes(wanted)) errors.push("Missing option " + wanted);
      return wanted;
    }, editor: async () => "State the pending check first.", confirm: async () => true,
    notify(message, level) { if (level === "error") errors.push(message); },
  } });
  await session.prompt("/harness-settings");
  assert.deepEqual(errors, []);
  assert.deepEqual(queue, []);
  const web = await browser(t);
  assert.match(await (await fetch(web.origin)).text(), /Prompt manager/);
  assert.equal((await web.send({action:"state"}, {origin:"http://example.invalid"})).status,403);
  assert.equal((await web.send({action:"state"}, {authorization:""})).status,403);
  const state = await web.api({ action:"state" });
  assert.equal(state.active, active);
  assert.equal(state.session, null);
  const draft = state.records.find(r => r.id !== active).id;
  const review = await web.api({ action:"state", candidate:draft });
  assert.equal(review.parent, active);
  assert.match(review.diff, /State the pending check first/);
  const stale = createCandidate(dir, active, active, "engineering", "Verify the boundary.").id;
  await web.api({action:"publish",base:active,candidate:draft,confirmed:true});
  await assert.rejects(web.api({action:"publish",base:active,candidate:stale,confirmed:true}), /Active revision changed/);
  await assert.rejects(web.api({action:"publish",base:draft,candidate:stale,confirmed:true}), /Stale candidate/);
  assert.ok((await web.api({action:"state"})).records.some(r => r.id === stale));
  assert.ok(!session.extensionRunner.createContext().getSystemPrompt().includes("State the pending check first."));
  await session.reload();
  assert.ok(session.extensionRunner.createContext().getSystemPrompt().includes("State the pending check first."));
  queue.push("History and rollback", "latest", "Close");
  await session.prompt("/prompt-manager");
  assert.deepEqual(queue, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(await readFile(join(dir,"APPEND_SYSTEM.md")), original);
  assert.deepEqual((await web.api({action:"state"})).history.map(h => h.action), ["manual","rollback"]);
  const modules = review.modules.slice(1).reverse().concat({id:"extra", text:"A new module."});
  const next = await web.api({action:"save",candidate:draft,modules});
  assert.deepEqual((await web.api({action:"state",candidate:next})).modules, modules);
  for (const [setting, source] of [[{instructionsPrompt:"Override"},"saved prompt"], [{instructionsFile:"custom.md"},"custom file"], [{instructionsFile:false},"off"]]) {
    await writeFile(join(dir,"settings.json"), JSON.stringify({piBetterHarness:setting}));
    await writeFile(join(dir,"custom.md"), "Custom");
    manageInstructions("sync",dir);
    const before = currentInstructions(dir);
    assert.equal((await web.api({action:"state"})).source,source);
    await assert.rejects(web.api({action:"publish",base:active,candidate:draft,confirmed:true}));
    assert.equal(currentInstructions(dir),before);
  }
});
