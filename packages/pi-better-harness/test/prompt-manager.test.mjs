import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { activatePrompt, currentInstructions, manageInstructions } from "../lib/instructions.mjs";
import { activeRevision, attribution, bundledRevision, createCandidate, editModules, orderedModules, readRevision, upgradeComposition } from "../lib/prompt-revisions.mjs";

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

test("ownership, exact package validation, legacy provenance and upgrade choices", async t => {
  const dir = await mkdtemp(join(tmpdir(),"pi-prompt-upgrade-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  manageInstructions("enable",dir);
  const base = activeRevision(dir), rows = orderedModules(base);
  for (const change of [
    v => { v[0].text += "!"; }, v => { v.reverse(); }, v => { v[0].origin = "user"; },
    v => { v.push({id:"bundled:fake",origin:"bundled",text:"Local",enabled:true}); }
  ]) {
    const bad = structuredClone(rows); change(bad);
    assert.throws(() => editModules(dir,base.id,bad), /Bundled|user module/);
  }
  assert.equal(currentInstructions(dir),base.rendered);
  rows[0].enabled = false;
  rows.push({id:"user:collaboration",origin:"user",text:"Local collaboration."});
  const draft = editModules(dir,base.id,rows);
  activatePrompt(dir,{action:"manual",from:base.id,to:draft});
  const before = currentInstructions(dir);
  const bundleDir = join(dir,"next-package");
  await cp(new URL("../extensions/harness-instructions/",import.meta.url),bundleDir,{recursive:true});
  await writeFile(join(bundleDir,"modules","communication.md"),"New shipped guidance.");
  const upgraded = bundledRevision(bundleDir);
  const untouched = join(dir,"untouched");
  manageInstructions("enable",untouched);
  upgradeComposition(untouched,upgraded);
  assert.equal(activeRevision(untouched).id,upgraded.id);
  assert.equal(readRevision(untouched,base.id).rendered,base.rendered);
  upgradeComposition(dir,upgraded);
  const after = activeRevision(dir);
  assert.ok(after.rendered.includes("New shipped guidance."));
  assert.ok(after.rendered.endsWith("Local collaboration."));
  assert.equal(orderedModules(after)[0].enabled,false);
  assert.equal(attribution(after).packageEvidence,null);
  assert.equal(attribution(readRevision(dir,draft)).packageEvidence.bundle,base.id);
  assert.equal(readRevision(dir,draft).rendered,before);
  const legacyModules = {...base.modules, collaboration:"An older local edit."};
  const hash = text => createHash("sha256").update(text).digest("hex");
  const legacyText = base.rendered.replace(base.modules.collaboration,legacyModules.collaboration);
  const id = hash(JSON.stringify([base.id,base.template,legacyModules]));
  await writeFile(join(dir,"harness-prompt-revisions",id+".json"), JSON.stringify({ parent:base.id, id,
    template:base.template, modules:legacyModules, rendered:legacyText, digest:hash(legacyText) }));
  const legacy = readRevision(dir,id);
  assert.equal(legacy.rendered,legacyText);
  assert.deepEqual(orderedModules(legacy).at(-1),{id:"user:collaboration",origin:"user",text:"An older local edit."});
  assert.equal(orderedModules(legacy)[0].enabled,false);
});

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
  const queue = ["Modules","bundled:verification","Turn off","Add module","user:verification","Edit text","Save candidate","Close"];
  let menuVisits = 0;
  const errors = [];
  await session.bindExtensions({ mode:"tui", uiContext: {
    custom: async () => menuVisits++ === 0 ? "link:prompt-manager" : undefined,
    select: async (_, items) => {
      const wanted = queue.shift();
      if (wanted === "latest") return items[0];
      if (wanted && !items.includes(wanted)) errors.push("Missing option " + wanted);
      return wanted;
    }, input:async () => "verification", editor: async () => "State the pending check first.", confirm: async () => true,
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
  assert.match(review.diff,/bundled:verification Off/);
  const stale = createCandidate(dir, active, active, "user:engineering", "Verify the boundary.").id;
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
  const modules = review.modules.map(r => r.id === "bundled:verification" ? { ...r, enabled:true } : r)
    .concat({id:"user:extra",origin:"user", text:"A new module."});
  const next = await web.api({action:"save",candidate:draft,modules});
  assert.deepEqual((await web.api({action:"state",candidate:next})).modules, modules);
  assert.ok((await web.api({action:"state",candidate:next})).rendered.includes(modules.find(r => r.id === "bundled:verification").text));
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
