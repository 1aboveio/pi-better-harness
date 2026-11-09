import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAgentCatalog } from "./check-agent-catalog.mjs";

function fixture(t, paths = "  roles: roles\n  agents: agents\n") {
    const root = mkdtempSync(join(tmpdir(), "published-catalog-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "roles"));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agent-catalog.yaml"), `schema: pi-agent-catalog/v1\nid: example.workers\nname: Workers\ndefinitionSchema: pi-agent/v1\npaths:\n${paths}`);
    writeFileSync(join(root, "roles", "developer.md"), role);
    writeFileSync(join(root, "agents", "payments.md"), agent);
    return root;
}

const role = "---\nschema: pi-agent/v1\nkind: role\nid: role.developer\nname: Developer\n---\nImplement changes.\n";
const agent = "---\nschema: pi-agent/v1\nkind: agent\nid: agent.payments\nname: Payments\nroleId: role.developer\n---\nCheck payments.\n";

test("discovers a self-contained catalog without requiring named agents", (t) => {
    const root = fixture(t, "  roles: roles\n");
    assert.deepEqual(checkAgentCatalog(root).files, [{ path: "roles/developer.md", id: "role.developer", kind: "role" }]);
});

test("accepts named agents with a published base role", (t) => {
    const result = checkAgentCatalog(fixture(t));
    assert.deepEqual(result.files.map((file) => file.id).sort(), ["agent.payments", "role.developer"]);
});

test("rejects duplicate identities and missing base roles", (t) => {
    const root = fixture(t);
    writeFileSync(join(root, "roles", "copy.md"), role);
    assert.throws(() => checkAgentCatalog(root), /Duplicate definition id/);
    rmSync(join(root, "roles", "copy.md"));
    writeFileSync(join(root, "agents", "payments.md"), agent.replace("role.developer", "role.missing"));
    assert.throws(() => checkAgentCatalog(root), /Missing base role role.missing/);
});

test("rejects invalid definitions instead of hiding them", (t) => {
    const root = fixture(t);
    writeFileSync(join(root, "roles", "developer.md"), role.replace("pi-agent/v1", "pi-agent/v999"));
    assert.throws(() => checkAgentCatalog(root), /Invalid definition roles\/developer.md/);
});

test("rejects traversal and symlink definition sources", (t) => {
    assert.throws(() => checkAgentCatalog(fixture(t, "  roles: ../roles\n")), /without traversal/);
    const root = fixture(t);
    symlinkSync("developer.md", join(root, "roles", "linked.md"));
    assert.throws(() => checkAgentCatalog(root), /regular file/);
    rmSync(join(root, "roles", "linked.md"));
    symlinkSync("roles", join(root, "linked"));
    writeFileSync(join(root, "agent-catalog.yaml"), "schema: pi-agent-catalog/v1\nid: example.workers\nname: Workers\ndefinitionSchema: pi-agent/v1\npaths:\n  roles: linked\n");
    assert.throws(() => checkAgentCatalog(root), /symlink/);
});