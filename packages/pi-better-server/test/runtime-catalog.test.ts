import test from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  try {
    const toolPath = new URL("../../pi-better-subagents/agents-catalog-tool.ts", import.meta.url).href;
    const commandPath = new URL("../../pi-better-subagents/agent-commands.ts", import.meta.url).href;
    const { agentsCatalogTool } = await import(toolPath);
    const { executeAgentsCommand } = await import(commandPath);
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`startup failed: ${errors}`); })]);
    for (const cwd of [projects[0], projects[0], projects[1]]) {
      const client = new WorkClient(message.ready, agent, ["runtime-catalog-v1"]); clients.push(client);
      await client.ready;
      await client.request("runtime_register_catalog", { cwd, sessionId: `pi-${clients.length}`, projectTrusted: true });
    }
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    const get = (index: number, overlay?: object) => clients[index]!.request("runtime_get_catalog", { overlay });
    const role = (snapshot: any) => new Map(snapshot.roles).get("role.fixture") as any;
    const first = await get(0);
    assert.equal(role(first).definition.name, "Project0");
    assert.equal(role(await get(2)).definition.name, "Project1");
    assert.equal((await get(1)).revision, first.revision);
    for (const cwd of projects) {
      const deps = { userRoot: agent, sharedCatalog: true };
      const host = { cwd, isProjectTrusted: () => true };
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
    const overlay = await get(0, { "role.fixture": { model: "openai/gpt-6.1-sol", effort: "high" } });
    assert.notEqual(overlay.revision, first.revision);
    assert.equal((await get(1)).sessionSettings, undefined);
    const edit = { action: "preferences", catalogId: "role.fixture", expectedRevision: first.revision, preferences: { model: "openai/gpt-6.1-sol", effort: "high" } };
    assert.equal((await clients[0]!.request("runtime_edit_catalog", edit)).ok, true);
    await assert.rejects(clients[1]!.request("runtime_edit_catalog", edit), /catalog-conflict/);
    assert.equal((await get(1)).savedSettings["role.fixture"].effort, "high");
    writeFileSync(join(projects[0], ".pi/agents/roles/fixture.md"), markdown("External"));
    assert.equal(role(await get(1)).definition.name, "External");
    assert.equal(role(first).definition.name, "Project0", "admitted snapshots do not change");
    trust.set(projects[0], false);
    const revoked = await get(0);
    assert.equal(role(revoked).definition.name, "Personal");
    await assert.rejects(clients[0]!.request("runtime_edit_catalog", { action: "definition", catalogId: "role.fixture", scope: "project", markdown: markdown("Denied"), expectedRevision: revoked.revision }), /catalog-untrusted/);
    await assert.rejects(get(1, { "role.fixture": { apiKey: "refused" } }), /Invalid catalog preference/);
  } finally {
    for (const client of clients) client.close();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; }
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});
