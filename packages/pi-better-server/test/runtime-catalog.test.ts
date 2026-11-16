import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { WorkClient } from "../src/runtime/work-client.mjs";

const markdown = (name: string) => `---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: ${name}\n---\n${name} instructions.\n`;

test("real daemon catalog isolates two projects, freezes branch reads, rejects stale writes and rechecks trust", { timeout: 30000 }, async () => {
  const parent = resolve("../../.work/758"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "catalog-"));
  const transport = mkdtempSync("/tmp/p758-");
  const agent = join(root, "agent"); mkdirSync(agent);
  const projects = [join(root, "a"), join(root, "b")] as const;
  const trust = new ProjectTrustStore(agent);
  for (const [index, cwd] of projects.entries()) {
    mkdirSync(join(cwd, ".pi/agents/roles"), { recursive: true });
    writeFileSync(join(cwd, ".pi/agents/roles/fixture.md"), markdown(`Project${index}`));
    trust.set(cwd, true);
  }
  mkdirSync(join(agent, "agents/roles"), { recursive: true });
  writeFileSync(join(agent, "agents/roles/fixture.md"), markdown("Personal"));
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = ""; child.stderr!.on("data", data => { errors += data; });
  const clients: WorkClient[] = [];
  const adapters: any[] = [];
  try {
    const toolPath = new URL("../../pi-better-subagents/agents-catalog-tool.ts", import.meta.url).href;
    const commandPath = new URL("../../pi-better-subagents/agent-commands.ts", import.meta.url).href;
    const { agentsCatalogTool } = await import(toolPath);
    const { executeAgentsCommand } = await import(commandPath);
    const admissionPath = new URL("../../pi-better-subagents/catalog-host-admission.ts", import.meta.url).href;
    const { createCatalogHostAdapter, noteCatalogHostContext, closeCatalogHost } = await import(admissionPath);
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`startup failed: ${errors}`); })]);
    for (const cwd of [projects[0], projects[0], projects[1], ...Array<string>(8).fill(projects[0])]) {
      const client = new WorkClient(message.ready, agent, ["runtime-catalog-v1"]); clients.push(client);
      const adapter = createCatalogHostAdapter(); adapters.push(adapter);
      adapter.noteCatalogHostContext({ cwd, isProjectTrusted: () => trust.get(cwd) === true, sessionManager: { getSessionId: () => `pi-${clients.length}` } }, () => ({}));
      await client.ready;
      const authority = await adapter.catalogHostAuthority(agent, cwd, message.ready);
      await client.request("runtime_register_catalog", { cwd, sessionId: authority.sessionId, authority });
    }
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    const get = async (index: number, overlay?: object) => {
      const cwd = index === 2 ? projects[1] : projects[0];
      adapters[index].noteCatalogHostContext({ cwd, isProjectTrusted: () => trust.get(cwd) === true, sessionManager: { getSessionId: () => `pi-${index + 1}` } }, () => overlay ?? {});
      const authority = await adapters[index].catalogHostAuthority(agent, cwd, message.ready);
      await clients[index]!.request("runtime_register_catalog", { cwd, sessionId: authority.sessionId, authority });
      return clients[index]!.request("runtime_get_catalog", { overlay });
    };
    const role = (snapshot: any) => new Map(snapshot.roles).get("role.fixture") as any;
    const first = await get(0);
    assert.equal(role(first).definition.name, "Project0");
    const metrics = async () => {
      const result = once(child, "message"); child.send("metrics");
      return (await result)[0].catalog;
    };
    const beforeEquivalent = await metrics();
    for (const count of [1, 5, 10]) {
      const equivalent = clients.map((_, index) => index).filter(index => index !== 2).slice(0, count);
      for (const index of equivalent) assert.equal((await get(index)).revision, first.revision);
    }
    const afterEquivalent = await metrics();
    assert.equal(afterEquivalent.reads, beforeEquivalent.reads, "socket clients share source bytes");
    assert.equal(afterEquivalent.parses, beforeEquivalent.parses, "socket clients share definition parsing");
    assert.equal(afterEquivalent.scopes, beforeEquivalent.scopes, "equivalent socket clients reuse scope computation");
    writeFileSync(join(projects[0], ".pi/agents/roles/fixture.md"), markdown("Project0"));
    assert.equal((await get(1)).revision, first.revision, "same-content rewrite keeps content revision");
    assert.equal((await metrics()).parses, beforeEquivalent.parses, "same-content rewrite reuses parsing");
    assert.equal(role(await get(2)).definition.name, "Project1");
    assert.equal((await get(1)).revision, first.revision);
    for (const cwd of projects) {
      const deps = { userRoot: agent, sharedCatalog: true };
      const host = { cwd, isProjectTrusted: () => true };
      noteCatalogHostContext(host, () => ({}));
      const Type = { Object: (v: unknown) => v, String: (v?: unknown) => v, Optional: (v: unknown) => v };
      const tool = agentsCatalogTool(Type, deps);
      const listed = await tool.execute("list", { action: "list" }, undefined, undefined, host);
      const slash = await executeAgentsCommand("list", { ...host, hasUI: false, ui: {} as never }, deps);
      const cli = JSON.parse(execFileSync(process.execPath, [new URL("../../pi-better-subagents/agent-catalog.mjs", import.meta.url).pathname, "list"], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, encoding: "utf8" }));
      assert.equal(listed.details.revision, (slash.data as any).revision);
      assert.equal(cli.revision, (slash.data as any).revision);
      const inspected = await tool.execute("inspect", { action: "inspect", id: "role.fixture" }, undefined, undefined, host);
      const shown = await executeAgentsCommand("inspect role.fixture", { ...host, hasUI: false, ui: {} as never }, deps);
      assert.deepEqual(inspected.details.view?.identity, (shown.data as any).identity);
    }
    const settingsPath = new URL("../../pi-better-subagents/agent-session-settings.ts", import.meta.url).href;
    const runtimePath = new URL("../../pi-better-subagents/catalog-runtime.ts", import.meta.url).href;
    const { createAgentSessionSettings } = await import(settingsPath);
    const { loadSharedLaunchSnapshot } = await import(runtimePath);
    const branchEntries: unknown[] = [];
    const sessionSettings = createAgentSessionSettings({ appendEntry: (...entry: unknown[]) => branchEntries.push(entry) });
    sessionSettings.change("role.fixture", "model", "openai/gpt-6.1-sol");
    sessionSettings.change("role.fixture", "effort", "medium");
    noteCatalogHostContext({ cwd: projects[0], isProjectTrusted: () => true }, () => sessionSettings.snapshot());
    const uiSaved = await executeAgentsCommand("inspect role.fixture", {
      cwd: projects[0], isProjectTrusted: () => true, hasUI: true, mode: "tui",
      ui: { setWidget() {}, notify() {}, custom(factory: Function) {
        return new Promise(resolve => {
          let component: any;
          component = factory({ requestRender() {
            if (component.render(100).join("\n").includes("Defaults saved")) resolve(undefined);
          } }, { fg: (_color: string, text: string) => text }, {}, resolve);
          component.handleInput("\x13");
        });
      } },
    }, { userRoot: agent, sharedCatalog: true, sessionSettings });
    assert.equal(uiSaved.wrote, true, "real catalog UI Ctrl+S committed through the server");
    assert.equal((await get(1)).savedSettings["role.fixture"].effort, "medium");
    assert.equal(branchEntries.length, 2, "saving defaults does not append or rewrite another branch");
    const frozen = await loadSharedLaunchSnapshot({ cwd: projects[0], projectTrusted: true, userRoot: agent });
    assert.equal(frozen.savedSettings["role.fixture"].effort, "medium");
    assert.throws(() => frozen.roles.clear(), /immutable/);
    const overlay = await get(0, { "role.fixture": { model: "openai/gpt-6.1-sol", effort: "high" } });
    assert.notEqual(overlay.revision, first.revision);
    assert.equal((await get(1)).sessionSettings, undefined);
    const edit = { action: "preferences", catalogId: "role.fixture", expectedRevision: (await get(0)).revision, preferences: { model: "openai/gpt-6.1-sol", effort: "high" } };
    assert.equal((await clients[0]!.request("runtime_edit_catalog", edit)).ok, true);
    await assert.rejects(clients[1]!.request("runtime_edit_catalog", edit), /catalog-conflict/);
    assert.equal((await get(1)).savedSettings["role.fixture"].effort, "high");
    assert.equal(frozen.savedSettings["role.fixture"].effort, "medium", "edits only affect future batch admission");
    writeFileSync(join(projects[0], ".pi/agents/roles/fixture.md"), markdown("External"));
    assert.equal(role(await get(1)).definition.name, "External");
    assert.equal(role(first).definition.name, "Project0", "admitted snapshots do not change");
    trust.set(projects[0], false);
    const revoked = await get(0);
    assert.equal(role(revoked).definition.name, "Personal");
    await assert.rejects(clients[0]!.request("runtime_edit_catalog", { action: "definition", catalogId: "role.fixture", scope: "project", markdown: markdown("Denied"), expectedRevision: revoked.revision }), /catalog-untrusted/);
    await assert.rejects(get(1, { "role.fixture": { apiKey: "refused" } }), /Invalid catalog preference/);
    await assert.rejects(clients[1]!.request("runtime_register_catalog", { cwd: projects[0], sessionId: "forged-session", projectTrusted: true, hostId: "forged-host" }), /catalog-authority-refused/);
    await assert.rejects(clients[1]!.request("runtime_get_catalog"), /catalog-authority-refused/);
    const current = await get(2);
    await assert.rejects(clients[2]!.request("runtime_edit_catalog", { action: "definition", scope: "bundled", catalogId: "role.fixture", markdown: markdown("Denied"), expectedRevision: current.revision }), /builtins are read-only/);
    await assert.rejects(clients[2]!.request("runtime_edit_catalog", { action: "definition", scope: "project", catalogId: "role.fixture", markdown: markdown("Secret").replace("name: Secret", "name: Secret\nextensions:\n  apiKey: refused"), expectedRevision: current.revision }), /credential/);
    writeFileSync(join(projects[1], ".pi/agents/roles/duplicate.md"), markdown("Duplicate"));
    const duplicate = await get(2);
    assert.equal(duplicate.blocked.some((entry: any) => entry.id === "role.fixture" && entry.duplicate), true);
    const refused = await clients[2]!.request("runtime_edit_catalog", { action: "preferences", catalogId: "role.fixture", preferences: { effort: "high" }, expectedRevision: duplicate.revision });
    assert.equal(refused.ok, false, "duplicates cannot be repaired or edited through preferences");
    rmSync(join(projects[1], ".pi/agents/roles/duplicate.md"));
    const outside = join(root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "escape.md"), markdown("Escaped").replace("role.fixture", "role.escape"));
    symlinkSync(join(outside, "escape.md"), join(projects[1], ".pi/agents/roles/escape.md"));
    assert.equal(new Map((await get(2)).roles).has("role.escape"), false, "symlink escape is never admitted");
    noteCatalogHostContext({ cwd: projects[1], isProjectTrusted: () => true }, () => ({}));
    const create = await executeAgentsCommand('create --role fixture --id agent.created --name Created --instructions "Owned fixture"', {
      cwd: projects[1], isProjectTrusted: () => true, hasUI: false, ui: {} as never,
    }, { userRoot: agent, sharedCatalog: true });
    assert.equal(create.wrote, true);
    assert.equal(new Map((await get(2)).agents).has("agent.created"), true, "slash create is visible through the shared server");
    let ephemeralTrusted = true;
    const ephemeral = createCatalogHostAdapter(); adapters.push(ephemeral);
    ephemeral.noteCatalogHostContext({ cwd: projects[0], isProjectTrusted: () => ephemeralTrusted,
      sessionManager: { getSessionId: () => "ephemeral", getLeafId: () => "branch-a" } }, () => ({}));
    const authority = await ephemeral.catalogHostAuthority(agent, projects[0], message.ready);
    const observer = new WorkClient(message.ready, agent, ["runtime-catalog-v1"]); clients.push(observer); await observer.ready;
    await observer.request("runtime_register_catalog", { cwd: projects[0], sessionId: "ephemeral", authority });
    assert.equal(role(await observer.request("runtime_get_catalog")).scope, "project", "session-only host trust overrides no persisted grant");
    await assert.rejects(observer.request("runtime_get_catalog", { overlay: { "role.fixture": { effort: "high" } } }), /catalog-overlay-refused/);
    const grantFile = join(agent, "catalog-host-admission", `${authority.id}.json`);
    chmodSync(grantFile, 0o644);
    await assert.rejects(observer.request("runtime_get_catalog"), /catalog-authority-refused/);
    chmodSync(grantFile, 0o600);
    for (const forged of [{ ...authority, branchId: "branch-b" }, { ...authority, sessionId: "foreign" }, { ...authority, cwd: projects[1] }, { ...authority, secret: "forged" }, { ...authority, generation: "foreign" }]) {
      await assert.rejects(observer.request("runtime_register_catalog", { cwd: projects[0], sessionId: "ephemeral", authority: forged }));
    }
    await observer.request("runtime_register_catalog", { cwd: projects[0], sessionId: "ephemeral", authority });
    const changed = new Promise<void>(resolve => {
      const stop = observer.onCatalog((snapshot: any) => { if (snapshot.roles?.some(([id, entry]: any) => id === "role.fixture" && entry.definition?.name === "Observed")) { stop(); resolve(); } });
    });
    await observer.request("runtime_subscribe_catalog");
    writeFileSync(join(projects[0], ".pi/agents/roles/fixture.md"), markdown("Observed"));
    await changed;
    const revokedEvent = new Promise<void>(resolve => { const stop = observer.onCatalog((snapshot: any) => { if (snapshot.status === "revoked") { assert.deepEqual(snapshot.roles, []); stop(); resolve(); } }); });
    ephemeralTrusted = false;
    const revalidated = await ephemeral.catalogHostAuthority(agent, projects[0], message.ready);
    await assert.rejects(observer.request("runtime_get_catalog"));
    await assert.rejects(observer.request("runtime_bind_catalog_host", { authority }), "a revoked grant cannot be rebound or replayed");
    await revokedEvent;
    await observer.request("runtime_register_catalog", { cwd: projects[0], sessionId: "ephemeral", authority: revalidated });
    assert.equal(role(await observer.request("runtime_get_catalog")).scope, "user");
    ephemeral.closeCatalogHost();
    await assert.rejects(observer.request("runtime_get_catalog"), "host shutdown revokes even an otherwise well-scoped grant");
  } finally {
    for (const adapter of adapters) adapter.closeCatalogHost();
    const admissionPath = new URL("../../pi-better-subagents/catalog-host-admission.ts", import.meta.url).href;
    (await import(admissionPath)).closeCatalogHost();
    for (const client of clients) client.close();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; }
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});
