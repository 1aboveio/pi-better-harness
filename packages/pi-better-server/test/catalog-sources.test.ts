import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { CatalogSources } from "../src/runtime/catalog-sources.ts";
import { SharedCatalog } from "../src/runtime/catalog.ts";
import { resolveSelection, catalogResolutionMetrics } from "../../pi-better-subagents/catalog-resolver.ts";
import { withAgentSessionSettings } from "../../pi-better-subagents/agent-session-settings.ts";

function fixture() {
  const parent = resolve("../../.work/804/tmp"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "incremental-"));
  const userRoot = join(root, "user"), cwd = join(root, "project");
  mkdirSync(join(userRoot, "agents/roles"), { recursive: true });
  mkdirSync(join(userRoot, "agents/agents"), { recursive: true });
  mkdirSync(join(cwd, ".pi/agents/roles"), { recursive: true });
  return { root, userRoot, cwd, projectTrusted: true };
}

const markdown = (name: string) => `---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: ${name}\n---\n${name} instructions.\n`;

test("authorized scopes share reads and parsing; rewrites, replacement and revocation preserve identity", t => {
  const parent = resolve("../../.work/804/tmp"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "sources-"));
  try {
    const agent = join(root, "user");
    const a = join(root, "a"), b = join(root, "b");
    for (const path of [join(agent, "agents/roles"), join(a, ".pi/agents/roles"), join(b, ".pi/agents/roles")]) mkdirSync(path, { recursive: true });
    const personal = join(agent, "agents/roles/fixture.md");
    writeFileSync(personal, markdown("Personal"));
    const sources = new CatalogSources();
    const loc = { cwd: a, userRoot: agent, projectTrusted: true };
    const first = sources.load(loc);
    const baseline = { ...sources.metrics };
    for (let i = 0; i < 10; i++) assert.equal(sources.load(loc), first);
    assert.equal(sources.metrics.reads, baseline.reads);
    assert.equal(sources.metrics.parses, baseline.parses);
    assert.equal(sources.metrics.scopes, baseline.scopes);
    assert.equal(sources.load(loc, true).revision, first.revision);
    assert.ok(sources.metrics.reads > baseline.reads, "fresh launch/edit admission rereads content");
    const afterFresh = sources.metrics.reads;
    sources.load({ ...loc, cwd: b });
    assert.equal(sources.metrics.reads, afterFresh, "another authorized project reuses personal sources");
    writeFileSync(personal, markdown("Personal"));
    assert.equal(sources.load(loc).revision, first.revision);
    assert.equal(sources.metrics.parses, baseline.parses, "same bytes do not parse again");
    const unrelated = sources.load({ ...loc, cwd: b });
    const projectFile = join(a, ".pi/agents/roles/fixture.md");
    writeFileSync(projectFile, markdown("ProjectA"));
    const changed = sources.load(loc);
    assert.equal(changed.roles.get("role.fixture")!.definition!.name, "ProjectA");
    assert.equal(sources.load({ ...loc, cwd: b }), unrelated, "project edits preserve unrelated scope snapshot identity");
    const reads = sources.metrics.reads;
    assert.equal(sources.load({ ...loc, projectTrusted: false }).roles.get("role.fixture")!.definition!.name, "Personal");
    assert.equal(sources.metrics.reads, reads, "revoked sources are not read");
    writeFileSync(projectFile + ".new", markdown("Replaced")); renameSync(projectFile + ".new", projectFile);
    assert.equal(sources.load(loc).roles.get("role.fixture")!.definition!.name, "Replaced");
    rmSync(join(a, ".pi/agents/roles"), { recursive: true }); mkdirSync(join(a, ".pi/agents/roles"));
    symlinkSync(personal, projectFile);
    assert.equal(sources.load(loc).roles.get("role.fixture")!.definition!.name, "Personal");
    assert.equal(first.roles.get("role.fixture")!.definition!.name, "Personal", "older snapshots stay frozen");
    t.diagnostic(JSON.stringify({ baseline, final: sources.metrics }));
    sources.clear();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("definition and preference changes assemble only real inheritance dependents", t => {
  const loc = fixture();
  try {
    const roles = join(loc.userRoot, "agents/roles"), agents = join(loc.userRoot, "agents/agents");
    writeFileSync(join(roles, "fixture.md"), markdown("Base"));
    writeFileSync(join(roles, "other.md"), markdown("Other").replace("role.fixture", "role.other"));
    const agent = (id: string, roleId: string) => `---\nschema: pi-agent/v1\nkind: agent\nid: agent.${id}\nname: ${id}\nroleId: ${roleId}\ninstructions:\n  mode: add\n---\n${id}\n`;
    writeFileSync(join(agents, "one.md"), agent("one", "role.fixture"));
    writeFileSync(join(agents, "two.md"), agent("two", "role.other"));
    const sources = new CatalogSources();
    let snapshot = sources.load(loc);
    const one = resolveSelection(snapshot, { agentId: "agent.one" });
    assert.equal(one.status, "resolved");
    resolveSelection(snapshot, { agentId: "agent.two" });
    const count = catalogResolutionMetrics.assemblies, parses = sources.metrics.parses;
    const other = snapshot.agents.get("agent.two");
    writeFileSync(join(roles, "fixture.md"), markdown("EditedBase"));
    snapshot = sources.load(loc);
    assert.equal(snapshot.agents.get("agent.two"), other, "unchanged entry retains object identity");
    assert.equal(sources.metrics.parses, parses + 1);
    resolveSelection(snapshot, { agentId: "agent.two" });
    assert.equal(catalogResolutionMetrics.assemblies, count, "unrelated inheritance result is reused");
    const changed = resolveSelection(snapshot, { agentId: "agent.one" });
    assert.match(changed.effective!.instructions, /EditedBase/);
    assert.equal(catalogResolutionMetrics.assemblies, count + 1);
    assert.equal(changed.effective!.snapshotDigest, snapshot.digest);
    const overlay = withAgentSessionSettings(snapshot, { "role.fixture": { effort: "high" } });
    resolveSelection(overlay, { agentId: "agent.two" });
    assert.equal(catalogResolutionMetrics.assemblies, count + 1);
    assert.equal(resolveSelection(overlay, { agentId: "agent.one" }).effective!.effort.value, "high");
    const revision = snapshot.revision;
    writeFileSync(join(loc.userRoot, "agents/settings.json"), JSON.stringify({ version: 1, defaults: { "agent.absent": { effort: "high" } } }));
    snapshot = sources.load(loc);
    assert.equal(snapshot.revision, revision, "preferences for absent definitions cannot advance content revision");
    const beforePreferences = catalogResolutionMetrics.assemblies;
    resolveSelection(snapshot, { agentId: "agent.two" });
    assert.equal(catalogResolutionMetrics.assemblies, beforePreferences);
    writeFileSync(join(loc.userRoot, "agents/settings.json"), JSON.stringify({ version: 1, defaults: { "role.fixture": { effort: "medium" } } }));
    snapshot = sources.load(loc);
    resolveSelection(snapshot, { agentId: "agent.two" });
    assert.equal(catalogResolutionMetrics.assemblies, beforePreferences);
    assert.equal(resolveSelection(snapshot, { agentId: "agent.one" }).effective!.effort.value, "medium");
    assert.equal(catalogResolutionMetrics.assemblies, beforePreferences + 1);
    rmSync(join(roles, "fixture.md"));
    assert.equal(resolveSelection(sources.load(loc), { agentId: "agent.one" }).launchable, false);
    writeFileSync(join(agents, "one.md"), agent("one", "role.other"));
    assert.equal(resolveSelection(sources.load(loc), { agentId: "agent.one" }).launchable, true);
    assert.match(one.effective!.instructions, /Base/);
    t.diagnostic(JSON.stringify({ source: sources.metrics, resolution: catalogResolutionMetrics }));
  } finally { rmSync(loc.root, { recursive: true, force: true }); }
});

test("missed hints repair with a shared resumable metadata budget and revoked sources stop scanning", t => {
  const loc = fixture();
  const sources = new CatalogSources();
  try {
    const directory = join(loc.cwd, ".pi/agents/roles");
    for (let index = 0; index < 260; index++) writeFileSync(join(directory, `${index}.md`), markdown(`N${index}`).replace("role.fixture", `role.r${index}`));
    const original = sources.load(loc);
    writeFileSync(join(directory, "259.md"), markdown("Repair").replace("role.fixture", "role.r259"));
    let snapshot = original;
    for (let cycle = 0; cycle < 100 && snapshot.revision === original.revision; cycle++) {
      sources.beginObservation();
      for (let client = 0; client < 10; client++) sources.load(loc);
      const before = sources.metrics.repairSteps;
      sources.repair(16);
      const steps = sources.metrics.repairSteps - before;
      assert.ok(steps > 0 && steps <= 16, "repair is capped, and stops early when its pass completes");
      snapshot = sources.load(loc);
      sources.endObservation();
    }
    assert.equal(snapshot.roles.get("role.r259")!.definition!.name, "Repair");
    const repairs = sources.metrics.repairs;
    for (let cycle = 0; cycle < 60; cycle++) {
      writeFileSync(join(directory, "0.md"), markdown(`Hot${cycle}`).replace("role.fixture", "role.r0"));
      sources.hint(join(directory, "0.md"));
      sources.beginObservation(); sources.load(loc); sources.repair(16); sources.load(loc); sources.endObservation();
    }
    assert.ok(sources.metrics.repairs > repairs, "continuous hints do not restart historical repair");
    sources.beginObservation(); sources.load({ ...loc, projectTrusted: false }); sources.endObservation();
    const reads = sources.metrics.reads;
    sources.beginObservation(); sources.load({ ...loc, projectTrusted: false }); sources.repair(16); sources.endObservation();
    assert.equal(sources.metrics.reads, reads);
    assert.ok(![...sources.watchPaths()].some(path => path.startsWith(loc.cwd)), "revoked project is absent from observation resources");
    t.diagnostic(JSON.stringify(sources.metrics));
  } finally { sources.clear(); rmSync(loc.root, { recursive: true, force: true }); }
});

test("shared observers notify content changes, recover watcher errors and release resources", async t => {
  const loc = fixture();
  const catalog = new SharedCatalog(loc.userRoot, "file-backed-observation");
  const stops: Array<{ close(): void }> = [];
  try {
    const path = join(loc.cwd, ".pi/agents/roles/fixture.md"); writeFileSync(path, markdown("Observed"));
    let trusted = true;
    const events: any[][] = Array.from({ length: 5 }, () => []);
    for (const eventsForClient of events) stops.push(catalog.observe(() => catalog.sources.load({ ...loc, projectTrusted: trusted }), snapshot => eventsForClient.push(snapshot)));
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(predicate());
    };
    writeFileSync(path, markdown("Observed"));
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(catalog.sources.metrics.notifications, 0);
    for (const { watcher } of (catalog as any).watchers.values()) watcher.emit("error", new Error("injected watcher failure"));
    writeFileSync(path + ".new", markdown("Renamed")); renameSync(path + ".new", path);
    await waitFor(() => events.every(items => items.at(-1)?.roles.get("role.fixture")?.definition?.name === "Renamed"));
    assert.equal(catalog.sources.metrics.notifications, 5);
    trusted = false;
    await waitFor(() => events.every(items => !items.at(-1)?.roles.has("role.fixture")));
    for (const stop of stops) { stop.close(); stop.close(); }
    assert.deepEqual(catalog.observationResources, { observers: 0, watchers: 0, timer: false, pending: false });
    assert.deepEqual(catalog.sources.resources, { scopes: 0, scans: 0, files: 0, fileBytes: 0 });
    t.diagnostic(JSON.stringify({ work: catalog.sources.metrics, resources: catalog.observationResources }));
  } finally { for (const stop of stops) stop.close(); rmSync(loc.root, { recursive: true, force: true }); }
});
