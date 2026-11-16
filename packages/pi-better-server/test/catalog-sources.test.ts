import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { CatalogSources } from "../src/runtime/catalog-sources.ts";

const markdown = (name: string) => `---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: ${name}\n---\n${name} instructions.\n`;

test("authorized scopes share reads and parsing; rewrites, replacement and revocation preserve identity", () => {
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
    const projectFile = join(a, ".pi/agents/roles/fixture.md");
    writeFileSync(projectFile, markdown("ProjectA"));
    const changed = sources.load(loc);
    assert.equal(changed.roles.get("role.fixture")!.definition!.name, "ProjectA");
    assert.equal(sources.load({ ...loc, cwd: b }).roles.get("role.fixture")!.definition!.name, "Personal");
    const reads = sources.metrics.reads;
    assert.equal(sources.load({ ...loc, projectTrusted: false }).roles.get("role.fixture")!.definition!.name, "Personal");
    assert.equal(sources.metrics.reads, reads, "revoked sources are not read");
    writeFileSync(projectFile + ".new", markdown("Replaced")); renameSync(projectFile + ".new", projectFile);
    assert.equal(sources.load(loc).roles.get("role.fixture")!.definition!.name, "Replaced");
    rmSync(join(a, ".pi/agents/roles"), { recursive: true }); mkdirSync(join(a, ".pi/agents/roles"));
    symlinkSync(personal, projectFile);
    assert.equal(sources.load(loc).roles.get("role.fixture")!.definition!.name, "Personal");
    assert.equal(first.roles.get("role.fixture")!.definition!.name, "Personal", "older snapshots stay frozen");
    sources.clear();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
