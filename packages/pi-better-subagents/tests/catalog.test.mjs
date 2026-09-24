import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
    APPROVED_ROLE_DEFAULTS,
    DiagnosticCodes,
    parseDefinition,
    removeAgentOverride,
    serializeDefinition,
    setAgentOverride,
} from "../catalog-schema.ts";
import {
    bundledRolesRoot,
    createDefinition,
    loadCatalog,
    refreshCatalog,
    saveDefinition,
} from "../catalog-store.ts";
import { inspectCatalog, listCatalog, resolveSelection } from "../catalog-resolver.ts";

function fixture(bundled = "empty") {
    const root = mkdtempSync(join(tmpdir(), "pi-catalog-"));
    const cwd = join(root, "project");
    const userRoot = join(root, "user");
    const bundledRoot = bundled === "real" ? bundledRolesRoot() : join(root, "bundled");
    mkdirSync(cwd);
    mkdirSync(userRoot);
    if (bundled !== "real") mkdirSync(bundledRoot);
    return {
        root,
        cwd,
        userRoot,
        bundledRoot,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function load(ctx, extra = {}) {
    return loadCatalog({
        cwd: ctx.cwd,
        userRoot: ctx.userRoot,
        bundledRoot: ctx.bundledRoot,
        projectTrusted: true,
        ...extra,
    });
}

function writeDefinition(directory, filename, markdown) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, filename), markdown);
}

function roleMarkdown(id, name, extra = "") {
    return `---\nschema: pi-agent/v1\nkind: role\nid: ${id}\nname: ${name}\ndefaults:\n  model: openai/gpt-6-sol\n  effort: medium\n  tier: balanced\n${extra}---\nRole ${name} instructions.\n`;
}

function agentMarkdown(id, roleId, body, frontmatter = "") {
    return `---\nschema: pi-agent/v1\nkind: agent\nid: ${id}\nname: ${id}\nroleId: ${roleId}\ninstructions:\n  mode: add\n${frontmatter}---\n${body}`;
}

describe("catalog schema", () => {
    it("accepts a YAML anchor and keeps the aliased model", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.alias
name: Alias
shared: &model openai/gpt-6-sol
defaults:
  model: *model
  effort: medium
  tier: balanced
---
Use the anchored model.
`);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.definition.defaults.model, "openai/gpt-6-sol");
        assert.equal(parsed.definition.extensions.shared, "openai/gpt-6-sol");
    });

    it("accepts a merge key without dropping the explicit effort", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.merge
name: Merge
base: &base
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
defaults:
  <<: *base
  effort: high
---
Merged defaults.
`);
        assert.equal(parsed.ok, true, parsed.diagnostics.map((item) => item.message).join("\n"));
        assert.equal(parsed.definition.defaults.model, "openai/gpt-6-sol");
        assert.equal(parsed.definition.defaults.effort, "high");
        assert.equal(parsed.definition.defaults.tier, "balanced");
    });

    it("rejects duplicate keys and alias expansion past the safe limit", () => {
        const duplicate = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.dup
id: role.other
name: Dup
---
Body.
`);
        assert.equal(duplicate.ok, false);
        assert.ok(duplicate.diagnostics.some((item) => item.code === DiagnosticCodes.duplicateKey));

        const aliases = ["base: &base marker"];
        for (let index = 0; index < 60; index += 1) aliases.push(`k${index}: *base`);
        const bomb = parseDefinition(`---\n${aliases.join("\n")}\n---\nbody\n`);
        assert.equal(bomb.ok, false);
        assert.ok(bomb.diagnostics.some((item) => item.code === DiagnosticCodes.parserLimit || item.code === DiagnosticCodes.malformedFrontmatter));
    });

    it("recovers one stable id from a malformed document without guessing another", () => {
        const commented = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.developer # stable identity
name: [unterminated
---
BROKEN PROJECT
`);
        assert.equal(commented.ok, false);
        assert.equal(commented.definition, undefined);
        assert.equal(commented.occupantId, "role.developer");
        assert.ok(commented.diagnostics.some((item) => item.code === DiagnosticCodes.malformedFrontmatter && item.id === "role.developer"));

        const quoted = parseDefinition(`---
schema: pi-agent/v1
kind: agent
id: "agent.payments" # display name is not the id
name: [unterminated
---
Broken agent.
`);
        assert.equal(quoted.ok, false);
        assert.equal(quoted.occupantId, "agent.payments");

        const aliased = parseDefinition(`---
schema: pi-agent/v1
kind: role
stable: &stable role.developer
id: *stable
name: [unterminated
---
Broken alias.
`);
        assert.equal(aliased.ok, false);
        assert.equal(aliased.occupantId, "role.developer");

        const forward = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: *later
name: [unterminated
later: &later role.developer
---
Forward alias is not an id.
`);
        assert.equal(forward.occupantId, undefined);

        const conflict = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.developer # one
id: role.reviewer
name: [unterminated
---
Two ids.
`);
        assert.equal(conflict.ok, false);
        assert.equal(conflict.occupantId, undefined);
        assert.ok(conflict.diagnostics.some((item) => item.code === DiagnosticCodes.duplicateKey));

        const repeated = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.developer # one
id: role.developer
name: [unterminated
---
Same id twice.
`);
        assert.equal(repeated.occupantId, "role.developer");

        const falseFriend = parseDefinition(`---
schema: pi-agent/v1
kind: role
# id: role.developer
name: [unterminated
defaults:
  note: "id: role.developer"
---
Not an id.
`);
        assert.equal(falseFriend.occupantId, undefined);

        const nestedAlias = parseDefinition(`---
schema: pi-agent/v1
kind: role
stable: &stable
  id: role.developer
id: *stable
name: [unterminated
---
Alias is not a scalar id.
`);
        assert.equal(nestedAlias.occupantId, undefined);
    });

    it("rejects a YAML alias cycle and still accepts a shared anchor", () => {
        const cyclic = `---
schema: pi-agent/v1
kind: role
id: role.reviewer
name: Reviewer
metadata: &loop
  again: *loop
---
Review
`;
        assert.doesNotThrow(() => parseDefinition(cyclic, "cycle.md"));
        const parsed = parseDefinition(cyclic, "cycle.md");
        assert.equal(parsed.ok, false);
        assert.equal(parsed.definition, undefined);
        assert.equal(parsed.occupantId, "role.reviewer");
        const diagnostic = parsed.diagnostics.find((item) => item.code === DiagnosticCodes.parserLimit);
        assert.ok(diagnostic);
        assert.match(diagnostic.message, /cycle/);
        assert.equal(diagnostic.path, "cycle.md");
        assert.equal(diagnostic.blocking, true);
        assert.equal(JSON.stringify(parsed).includes("Maximum call stack"), false);

        const rooted = parseDefinition(`---
&root
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
self: *root
defaults:
  model: openai/gpt-6-sol
  effort: high
  tier: balanced
---
Root cycle.
`);
        assert.equal(rooted.ok, false);
        assert.equal(rooted.occupantId, "role.developer");
        assert.match(rooted.diagnostics.map((item) => item.message).join("\n"), /cycle/);

        const listed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.explorer
name: Explorer
metadata:
  items: &items
    - *items
---
Explore
`);
        assert.equal(listed.ok, false);
        assert.equal(listed.occupantId, "role.explorer");
        assert.match(listed.diagnostics.map((item) => item.message).join("\n"), /cycle/);

        const shared = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.shared
name: Shared
defaults:
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
metadata:
  left: &box
    note: shared
  right: *box
---
Diamond alias.
`);
        assert.equal(shared.ok, true, shared.diagnostics.map((item) => item.message).join("\n"));
        assert.equal(shared.definition.metadata.left.note, "shared");
        assert.equal(shared.definition.metadata.right.note, "shared");
        assert.equal(shared.diagnostics.some((item) => /cycle/.test(item.message)), false);
    });

    it("rejects a second base role and an empty replacement without writing inherited defaults", () => {
        const many = parseDefinition(`---
schema: pi-agent/v1
kind: agent
id: agent.many
name: Many
roleId: role.developer
roleIds:
  - role.reviewer
---
Extra.
`);
        assert.equal(many.ok, false);
        assert.ok(many.diagnostics.some((item) => item.code === DiagnosticCodes.multipleBaseRoles));

        const flattened = parseDefinition(`---
schema: pi-agent/v1
kind: agent
id: agent.flat
name: Flat
roleId: role.developer
defaults:
  model: openai/gpt-6-astra
  effort: low
---
Do not copy these into overrides.
`);
        assert.equal(flattened.ok, false);
        assert.equal(flattened.definition, undefined);

        const valid = parseDefinition(agentMarkdown("agent.one", "role.developer", "Agent text.\n"));
        assert.equal(valid.ok, true);
        const emptied = { ...valid.definition, instructionMode: "replace", body: " \n\t" };
        const serialized = serializeDefinition(emptied);
        assert.equal(serialized.ok, false);
        assert.ok(serialized.diagnostics.some((item) => item.code === DiagnosticCodes.emptyReplacement));
        assert.equal(Object.hasOwn(valid.definition.overrides, "model"), false);
    });

    it("redacts credential-like fields and still blocks launch", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.secret
name: Secret
defaults:
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
apiKey: super-secret-value
---
Do not keep the secret.
`);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.definition.extensions.apiKey, "[redacted]");
        assert.equal(JSON.stringify(parsed.definition).includes("super-secret-value"), false);
        assert.ok(parsed.diagnostics.some((item) => item.blocking && item.code === DiagnosticCodes.credentialMaterial));
        const markdown = serializeDefinition(parsed.definition).markdown;
        assert.equal(markdown.includes("super-secret-value"), false);
    });

    it("treats override removal as inheritance and null as an explicit value", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: agent
id: agent.one
name: One
roleId: role.developer
overrides:
  model: openai/gpt-6-astra
  effort: low
---
Custom.
`);
        assert.equal(parsed.ok, true);
        const removed = removeAgentOverride(parsed.definition, "effort");
        assert.equal(Object.hasOwn(removed.overrides, "effort"), false);
        assert.equal(removed.overrides.model, "openai/gpt-6-astra");
        const cleared = setAgentOverride(removed, "model", null);
        assert.equal(cleared.overrides.model, null);
        const roundTrip = parseDefinition(serializeDefinition(cleared).markdown);
        assert.equal(roundTrip.ok, true);
        assert.equal(roundTrip.definition.overrides.model, null);
        assert.equal(Object.hasOwn(roundTrip.definition.overrides, "effort"), false);
        assert.doesNotMatch(serializeDefinition(cleared).markdown, /effort:/);
    });
});

describe("catalog discovery and inheritance", () => {
    it("T01 discovers the six bundled roles with approved defaults", () => {
        const ctx = fixture("real");
        try {
            const snapshot = load(ctx);
            assert.equal(snapshot.roles.size, APPROVED_ROLE_DEFAULTS.length);
            for (const approved of APPROVED_ROLE_DEFAULTS) {
                const entry = snapshot.roles.get(approved.id);
                assert.ok(entry, approved.id);
                assert.equal(entry.scope, "bundled");
                assert.equal(entry.schemaLaunchable, true);
                assert.equal(entry.definition.name, approved.name);
                assert.equal(entry.definition.defaults.model, approved.model);
                assert.equal(entry.definition.defaults.effort, approved.effort);
                assert.equal(entry.definition.defaults.tier, approved.tier);
                const resolved = resolveSelection(snapshot, { roleId: approved.id });
                assert.equal(resolved.launchable, true);
                assert.equal(resolved.effective.model.value, approved.model);
                assert.equal(resolved.effective.model.explicit, false);
                assert.equal(resolved.effective.effort.value, approved.effort);
                assert.equal(resolved.effective.capabilities.grantedByCatalog, false);
                const inspection = inspectCatalog(snapshot, approved.id);
                assert.equal(inspection.found, true);
                assert.equal(inspection.winningSource.scope, "bundled");
                assert.equal(inspection.launchable, true);
            }
            assert.deepEqual(
                listCatalog(snapshot).map((entry) => entry.id),
                APPROVED_ROLE_DEFAULTS.map((entry) => entry.id).sort(),
            );
        } finally {
            ctx.cleanup();
        }
    });

    it("T02 creates two agents from one role without mutating the role", () => {
        const ctx = fixture("real");
        try {
            const rolePath = join(ctx.bundledRoot, "role.developer.md");
            const before = readFileSync(rolePath);
            const first = parseDefinition(agentMarkdown("agent.one", "role.developer", "First instructions.\n", "overrides:\n  effort: low\n"));
            const second = parseDefinition(agentMarkdown("agent.two", "role.developer", "Second instructions.\n", "overrides:\n  model: openai/gpt-6-luna\n"));
            assert.equal(first.ok && second.ok, true);
            const savedFirst = createDefinition({ definition: first.definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true });
            const savedSecond = createDefinition({ definition: second.definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true });
            assert.equal(savedFirst.ok, true, savedFirst.diagnostics.map((item) => item.message).join("\n"));
            assert.equal(savedSecond.ok, true, savedSecond.diagnostics.map((item) => item.message).join("\n"));
            assert.equal(savedFirst.scope, "user");
            assert.ok(savedFirst.path.startsWith(ctx.userRoot));
            assert.deepEqual(readFileSync(rolePath), before);

            const snapshot = load(ctx);
            const left = resolveSelection(snapshot, { agentId: "agent.one" });
            const right = resolveSelection(snapshot, { agentId: "agent.two" });
            assert.equal(left.launchable && right.launchable, true);
            assert.match(left.effective.instructions, /First instructions/);
            assert.match(left.effective.instructions, /Implement the requested change/);
            assert.equal(left.effective.effort.value, "low");
            assert.equal(left.effective.effort.explicit, true);
            assert.equal(left.effective.model.value, "openai/gpt-6-sol");
            assert.equal(left.effective.model.explicit, false);
            assert.match(right.effective.instructions, /Second instructions/);
            assert.equal(right.effective.model.value, "openai/gpt-6-luna");
            assert.equal(right.effective.effort.value, "high");
            assert.equal(right.effective.effort.source, "role-default");
            assert.equal(snapshot.roles.get("role.developer").definition.body, parseDefinition(before.toString()).definition.body);
        } finally {
            ctx.cleanup();
        }
    });

    it("T18 applies project, personal, then bundled precedence and ignores Codex directories", () => {
        const ctx = fixture("real");
        try {
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "custom.md", roleMarkdown("role.developer", "Personal Developer").replace("effort: medium", "effort: low"));
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "ignored-name.md", roleMarkdown("role.developer", "Project Developer").replace("effort: medium", "effort: high").replace("model: openai/gpt-6-sol", "model: openai/gpt-6-luna"));
            writeDefinition(join(ctx.cwd, ".codex", "agents"), "role.developer.md", roleMarkdown("role.codex", "Codex"));
            writeDefinition(join(ctx.userRoot, ".codex", "agents"), "extra.md", roleMarkdown("role.home-codex", "Home Codex"));
            const snapshot = load(ctx);
            const winner = snapshot.roles.get("role.developer");
            assert.equal(winner.scope, "project");
            assert.equal(winner.definition.name, "Project Developer");
            assert.equal(winner.definition.defaults.model, "openai/gpt-6-luna");
            assert.equal(winner.unused.some((item) => item.scope === "user" && item.reason === "shadowed-by-whole-definition"), true);
            assert.equal(winner.unused.some((item) => item.scope === "bundled"), true);
            assert.equal(snapshot.roles.has("role.codex"), false);
            assert.equal(snapshot.roles.has("role.home-codex"), false);
            const listed = listCatalog(snapshot).find((entry) => entry.id === "role.developer");
            assert.equal(listed.winningSource, "project");
            const inspection = inspectCatalog(snapshot, "role.developer");
            assert.equal(inspection.fields.model.source, "role-default");
            assert.equal(inspection.fields.model.value, "openai/gpt-6-luna");
        } finally {
            ctx.cleanup();
        }
    });

    it("T18 reports same-scope duplicates without hiding a valid sibling", () => {
        const ctx = fixture();
        try {
            const roles = join(ctx.userRoot, "agents", "roles");
            writeDefinition(roles, "b.md", roleMarkdown("role.same", "From B"));
            writeDefinition(roles, "a.md", roleMarkdown("role.same", "From A"));
            writeDefinition(roles, "sibling.md", roleMarkdown("role.sibling", "Sibling"));
            const snapshot = load(ctx);
            assert.equal(snapshot.roles.has("role.same"), false);
            assert.equal(snapshot.blocked.some((entry) => entry.id === "role.same"), true);
            const resolved = resolveSelection(snapshot, { roleId: "role.same" });
            assert.equal(resolved.launchable, false);
            assert.ok(resolved.diagnostics.some((item) => item.code === DiagnosticCodes.duplicateId));
            assert.match(resolved.diagnostics.find((item) => item.code === DiagnosticCodes.duplicateId).message, /a\.md/);
            assert.equal(resolveSelection(snapshot, { roleId: "role.sibling" }).launchable, true);
        } finally {
            ctx.cleanup();
        }
    });

    it("keeps a recovered higher-priority id from falling back to a valid lower source", () => {
        const ctx = fixture("real");
        try {
            const broken = `---
schema: pi-agent/v1
kind: role
id: role.developer # stable identity
name: [unterminated
---
BROKEN PROJECT
`;
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "personal-developer.md", roleMarkdown("role.developer", "Personal Developer"));
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "renamed.md", broken);
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "personal-explorer.md", roleMarkdown("role.explorer", "Personal Explorer"));
            const snapshot = load(ctx);
            const developer = snapshot.roles.get("role.developer");
            assert.equal(developer.scope, "project");
            assert.equal(developer.path.endsWith("renamed.md"), true);
            assert.equal(developer.schemaLaunchable, false);
            assert.equal(developer.definition, undefined);
            assert.equal(developer.unused.some((item) => item.scope === "user" && item.reason === "blocked-by-invalid-higher-priority"), true);
            assert.equal(developer.unused.some((item) => item.scope === "bundled" && item.reason === "blocked-by-invalid-higher-priority"), true);
            const resolved = resolveSelection(snapshot, { roleId: "role.developer" });
            assert.equal(resolved.status, "blocked");
            assert.equal(resolved.launchable, false);
            assert.equal(resolved.effective, undefined);
            assert.equal(resolved.entry.scope, "project");
            assert.equal(snapshot.roles.get("role.explorer").scope, "user");
            assert.equal(snapshot.roles.get("role.explorer").schemaLaunchable, true);
            assert.equal(resolveSelection(snapshot, { roleId: "role.explorer" }).launchable, true);
            assert.equal(snapshot.roles.get("role.reviewer").scope, "bundled");
            assert.equal(snapshot.roles.get("role.reviewer").schemaLaunchable, true);

            const falseFriend = `---
schema: pi-agent/v1
kind: role
# id: role.architect
name: [unterminated
defaults:
  note: "id: role.architect"
---
no id
`;
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "false-friend.md", falseFriend);
            const withFriend = load(ctx);
            assert.equal(withFriend.roles.get("role.architect").scope, "bundled");
            assert.equal(withFriend.roles.get("role.architect").schemaLaunchable, true);
            assert.equal(withFriend.roles.get("role.developer").scope, "project");
            assert.ok(withFriend.diagnostics.some((item) => item.path.endsWith("false-friend.md")));
        } finally {
            ctx.cleanup();
        }
    });

    it("isolates a cyclic alias file and still blocks that id from lower sources", () => {
        const ctx = fixture("real");
        try {
            const cycle = (id, name) => `---
schema: pi-agent/v1
kind: role
id: ${id}
name: ${name}
metadata: &loop
  again: *loop
---
${name}
`;
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "personal-developer.md", roleMarkdown("role.developer", "Personal Developer"));
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "cycle-reviewer.md", cycle("role.reviewer", "Reviewer"));
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "cycle-developer.md", cycle("role.developer", "Developer"));
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "explorer.md", roleMarkdown("role.explorer", "Project Explorer"));
            const snapshot = load(ctx);
            const reviewer = snapshot.roles.get("role.reviewer");
            assert.equal(reviewer.scope, "user");
            assert.equal(reviewer.schemaLaunchable, false);
            assert.equal(reviewer.unused.some((item) => item.scope === "bundled" && item.reason === "blocked-by-invalid-higher-priority"), true);
            assert.ok(reviewer.diagnostics.some((item) => item.code === DiagnosticCodes.parserLimit && /cycle/.test(item.message) && item.path.endsWith("cycle-reviewer.md")));
            assert.equal(resolveSelection(snapshot, { roleId: "role.reviewer" }).launchable, false);

            const developer = snapshot.roles.get("role.developer");
            assert.equal(developer.scope, "project");
            assert.equal(developer.schemaLaunchable, false);
            assert.equal(developer.unused.some((item) => item.scope === "user" && item.reason === "blocked-by-invalid-higher-priority"), true);
            assert.equal(developer.unused.some((item) => item.scope === "bundled" && item.reason === "blocked-by-invalid-higher-priority"), true);
            assert.equal(resolveSelection(snapshot, { roleId: "role.developer" }).launchable, false);

            assert.equal(snapshot.roles.get("role.explorer").scope, "project");
            assert.equal(snapshot.roles.get("role.explorer").definition.name, "Project Explorer");
            assert.equal(resolveSelection(snapshot, { roleId: "role.explorer" }).launchable, true);
            assert.equal(snapshot.roles.get("role.architect").scope, "bundled");
            assert.equal(snapshot.roles.get("role.architect").schemaLaunchable, true);
            assert.equal(snapshot.roles.size, APPROVED_ROLE_DEFAULTS.length);
        } finally {
            ctx.cleanup();
        }
    });

    it("T20 keeps valid entries when one file is malformed, and repair is visible on reload", () => {
        const ctx = fixture("real");
        try {
            const registry = join(ctx.root, "registry-sentinel");
            writeFileSync(registry, "active-run");
            const brokenPath = join(ctx.cwd, ".pi", "agents", "roles", "broken.md");
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "broken.md", "this is not a definition\n");
            const before = load(ctx);
            assert.equal(before.roles.get("role.developer").scope, "bundled");
            assert.equal(before.roles.get("role.developer").schemaLaunchable, true);
            assert.ok(before.diagnostics.some((item) => item.path === brokenPath));
            assert.equal(resolveSelection(before, { agentId: "agent.missing" }).status, "not-found");
            assert.equal(before.roles.get("role.reviewer").schemaLaunchable, true);

            writeFileSync(brokenPath, roleMarkdown("role.repaired", "Repaired"));
            const after = refreshCatalog({
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                bundledRoot: ctx.bundledRoot,
                projectTrusted: true,
            });
            assert.notEqual(after, before);
            assert.equal(before.roles.has("role.repaired"), false);
            assert.equal(after.roles.get("role.repaired").schemaLaunchable, true);
            assert.equal(readFileSync(registry, "utf8"), "active-run");
        } finally {
            ctx.cleanup();
        }
    });

    it("T23 keeps an old snapshot stable while the next load inherits a role edit", () => {
        const ctx = fixture();
        try {
            const roles = join(ctx.userRoot, "agents", "roles");
            const rolePath = join(roles, "role.worker.md");
            writeDefinition(roles, "role.worker.md", roleMarkdown("role.worker", "Worker"));
            const inheriting = parseDefinition(agentMarkdown("agent.inherit", "role.worker", "Keep this addition.\n"));
            const pinned = parseDefinition(agentMarkdown("agent.pinned", "role.worker", "Pinned instructions.\n", "overrides:\n  model: openai/gpt-6-astra\n  effort: high\n"));
            assert.equal(createDefinition({ definition: inheriting.definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true }).ok, true);
            assert.equal(createDefinition({ definition: pinned.definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true }).ok, true);
            const original = load(ctx);
            const originalInherit = resolveSelection(original, { agentId: "agent.inherit" });
            assert.equal(originalInherit.effective.model.value, "openai/gpt-6-sol");
            assert.match(originalInherit.effective.instructions, /Role Worker instructions/);

            writeFileSync(rolePath, roleMarkdown("role.worker", "Worker").replace("model: openai/gpt-6-sol", "model: openai/gpt-6-luna").replace("Role Worker instructions.", "Updated role instructions."));
            const stillOriginal = resolveSelection(original, { agentId: "agent.inherit" });
            assert.equal(stillOriginal.effective.model.value, "openai/gpt-6-sol");
            assert.equal(stillOriginal.effective.snapshotDigest, original.digest);
            const next = load(ctx);
            const inherited = resolveSelection(next, { agentId: "agent.inherit" });
            const kept = resolveSelection(next, { agentId: "agent.pinned" });
            assert.equal(inherited.effective.model.value, "openai/gpt-6-luna");
            assert.match(inherited.effective.instructions, /Updated role instructions/);
            assert.match(inherited.effective.instructions, /Keep this addition/);
            assert.equal(kept.effective.model.value, "openai/gpt-6-astra");
            assert.equal(kept.effective.model.explicit, true);
            assert.match(kept.effective.instructions, /Pinned instructions/);
            assert.equal(resolveSelection(original, { agentId: "agent.pinned" }).effective.model.value, "openai/gpt-6-astra");
        } finally {
            ctx.cleanup();
        }
    });

    it("T27 replaces instruction text only and rejects an empty replacement", () => {
        const ctx = fixture();
        try {
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "role.worker.md", roleMarkdown("role.worker", "Worker"));
            const added = parseDefinition(agentMarkdown("agent.add", "role.worker", "Added text.\n"));
            const replaced = parseDefinition(`---
schema: pi-agent/v1
kind: agent
id: agent.replace
name: Replace
roleId: role.worker
instructions:
  mode: replace
---
Replacement text only.
`);
            assert.equal(added.ok && replaced.ok, true);
            for (const definition of [added.definition, replaced.definition]) {
                assert.equal(createDefinition({ definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true }).ok, true);
            }
            const snapshot = load(ctx);
            const add = resolveSelection(snapshot, { agentId: "agent.add" });
            const replace = resolveSelection(snapshot, { agentId: "agent.replace" });
            assert.match(add.effective.instructions, /Role Worker instructions/);
            assert.match(add.effective.instructions, /Added text/);
            assert.equal(replace.effective.instructions.trim(), "Replacement text only.");
            assert.doesNotMatch(replace.effective.instructions, /Role Worker instructions/);
            assert.equal(replace.effective.model.value, "openai/gpt-6-sol");
            assert.equal(replace.effective.effort.value, "medium");
            assert.equal(replace.effective.model.source, "role-default");
            const empty = createDefinition({
                definition: { ...replaced.definition, id: "agent.empty", body: "\n" },
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
            });
            assert.equal(empty.ok, false);
            assert.equal(load(ctx).agents.has("agent.empty"), false);
        } finally {
            ctx.cleanup();
        }
    });

    it("T28 keeps a stable id across display and file renames and blocks a missing role", () => {
        const ctx = fixture();
        try {
            const roles = join(ctx.userRoot, "agents", "roles");
            writeDefinition(roles, "not-the-id.md", roleMarkdown("role.worker", "Worker"));
            const agent = parseDefinition(agentMarkdown("agent.worker", "role.worker", "Body.\n"));
            assert.equal(createDefinition({ definition: agent.definition, cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true }).ok, true);
            const renamed = saveDefinition({
                definition: { ...agent.definition, name: "Renamed Worker" },
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
                replace: true,
            });
            assert.equal(renamed.ok, true);
            assert.equal(renamed.path.endsWith("agent.worker.md"), true);
            const movedFrom = join(roles, "not-the-id.md");
            const movedTo = join(roles, "another-file.md");
            writeFileSync(movedTo, readFileSync(movedFrom, "utf8").replace("name: Worker", "name: Still Worker"));
            rmSync(movedFrom);
            const snapshot = load(ctx);
            assert.equal(snapshot.roles.get("role.worker").definition.name, "Still Worker");
            assert.equal(snapshot.roles.get("role.worker").path, movedTo);
            assert.equal(inspectCatalog(snapshot, "agent.worker").name, "Renamed Worker");
            assert.equal(resolveSelection(snapshot, { agentId: "agent.worker" }).launchable, true);

            writeFileSync(movedTo, roleMarkdown("role.worker-renamed", "Still Worker"));
            const broken = load(ctx);
            const agentView = inspectCatalog(broken, "agent.worker");
            assert.equal(agentView.found, true);
            assert.equal(agentView.launchable, false);
            assert.equal(resolveSelection(broken, { agentId: "agent.worker" }).diagnostics.some((item) => item.code === DiagnosticCodes.missingRole), true);
            assert.equal(broken.roles.has("role.worker"), false);
            assert.equal(broken.roles.get("role.worker-renamed").schemaLaunchable, true);
        } finally {
            ctx.cleanup();
        }
    });

    it("T29 shadows a whole personal agent and applies the project role", () => {
        const ctx = fixture("real");
        try {
            writeDefinition(join(ctx.userRoot, "agents", "agents"), "agent.worker.md", `---
schema: pi-agent/v1
kind: agent
id: agent.worker
name: Personal
roleId: role.developer
instructions:
  mode: add
overrides:
  effort: low
---
Personal instructions.
`);
            writeDefinition(join(ctx.cwd, ".pi", "agents", "agents"), "agent.worker.md", `---
schema: pi-agent/v1
kind: agent
id: agent.worker
name: Project
roleId: role.developer
instructions:
  mode: add
---
Project instructions.
`);
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "role.developer.md", roleMarkdown("role.developer", "Project Role").replace("model: openai/gpt-6-sol", "model: openai/gpt-6-luna"));
            const snapshot = load(ctx);
            const resolved = resolveSelection(snapshot, { agentId: "agent.worker" });
            assert.equal(resolved.effective.name, "Project");
            assert.match(resolved.effective.instructions, /Project instructions/);
            assert.doesNotMatch(resolved.effective.instructions, /Personal instructions/);
            assert.equal(resolved.effective.effort.value, "medium");
            assert.equal(resolved.effective.effort.source, "role-default");
            assert.notEqual(resolved.effective.effort.value, "low");
            assert.equal(resolved.effective.model.value, "openai/gpt-6-luna");
            assert.equal(resolved.effective.roleSource.scope, "project");
            assert.equal(snapshot.agents.get("agent.worker").unused.some((item) => item.scope === "user"), true);

            writeFileSync(join(ctx.cwd, ".pi", "agents", "roles", "role.developer.md"), `---
schema: pi-agent/v1
kind: role
id: role.developer
name: Broken
defaults:
  model: not a model
---
Broken.
`);
            const blocked = load(ctx);
            const role = blocked.roles.get("role.developer");
            assert.equal(role.scope, "project");
            assert.equal(role.schemaLaunchable, false);
            assert.equal(role.unused.some((item) => item.scope === "bundled"), true);
            const agent = resolveSelection(blocked, { agentId: "agent.worker" });
            assert.equal(agent.launchable, false);
            assert.equal(agent.effective.model.value, null);
            assert.equal(blocked.roles.get("role.reviewer").scope, "bundled");
            assert.equal(blocked.roles.get("role.reviewer").schemaLaunchable, true);
        } finally {
            ctx.cleanup();
        }
    });

    it("T30 serves every resolve from the snapshot taken before a later edit", () => {
        const ctx = fixture();
        try {
            const rolePath = join(ctx.userRoot, "agents", "roles", "role.worker.md");
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "role.worker.md", roleMarkdown("role.worker", "Worker"));
            const snapshot = load(ctx);
            writeFileSync(rolePath, roleMarkdown("role.worker", "Worker").replace("tier: balanced", "tier: frontier"));
            const first = resolveSelection(snapshot, { roleId: "role.worker" });
            const second = resolveSelection(snapshot, { roleId: "role.worker" });
            assert.equal(first.effective.tier.value, "balanced");
            assert.equal(second.effective.tier.value, "balanced");
            assert.equal(first.effective.snapshotDigest, second.effective.snapshotDigest);
            const reloaded = load(ctx);
            assert.equal(resolveSelection(reloaded, { roleId: "role.worker" }).effective.tier.value, "frontier");
            assert.notEqual(reloaded.digest, snapshot.digest);
            assert.equal(resolveSelection(snapshot, { roleId: "role.worker" }).effective.tier.value, "balanced");
        } finally {
            ctx.cleanup();
        }
    });

    it("T36 preserves an unsupported restriction, blocks that id, and leaves another role launchable", () => {
        const ctx = fixture();
        try {
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "role.locked.md", `---
schema: pi-agent/v1
kind: role
id: role.locked
name: Locked
description: Claims a host restriction the catalog does not enforce.
defaults:
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
sandbox_mode: read-only
---
You are read-only.
`);
            writeDefinition(join(ctx.userRoot, "agents", "roles"), "role.open.md", `---
schema: pi-agent/v1
kind: role
id: role.open
name: Open
defaults:
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
---
You are read-only in prose only.
`);
            const snapshot = load(ctx);
            const locked = resolveSelection(snapshot, { roleId: "role.locked" });
            const open = resolveSelection(snapshot, { roleId: "role.open" });
            assert.equal(locked.launchable, false);
            assert.ok(locked.diagnostics.some((item) => item.code === DiagnosticCodes.unsupportedExecutionRestriction));
            assert.equal(locked.effective.restrictions.some((item) => item.name === "sandbox_mode" && item.required === true && item.honored === false), true);
            assert.match(serializeDefinition(snapshot.roles.get("role.locked").definition).markdown, /sandbox_mode/);
            assert.equal(open.launchable, true);
            assert.equal(open.effective.restrictions.length, 0);
            const saved = createDefinition({
                definition: snapshot.roles.get("role.locked").definition,
                cwd: ctx.cwd,
                userRoot: join(ctx.root, "other-home"),
                projectTrusted: true,
            });
            assert.equal(saved.ok, true, saved.diagnostics.map((item) => item.message).join("\n"));
            const reread = parseDefinition(readFileSync(saved.path, "utf8"), saved.path);
            assert.equal(reread.ok, true);
            assert.equal(reread.definition.executionRestrictions.some((item) => item.name === "sandbox_mode"), true);
            assert.ok(reread.diagnostics.some((item) => item.blocking && item.code === DiagnosticCodes.unsupportedExecutionRestriction));
        } finally {
            ctx.cleanup();
        }
    });

    it("asks for one selector when both an agent and a role are supplied", () => {
        const ctx = fixture("real");
        try {
            const snapshot = load(ctx);
            const resolved = resolveSelection(snapshot, { agentId: "agent.one", roleId: "role.developer" });
            assert.equal(resolved.status, "clarification-needed");
            assert.equal(resolved.launchable, false);
            assert.equal(resolved.effective, undefined);
        } finally {
            ctx.cleanup();
        }
    });

    it("does not read or write an untrusted project, and project scope must be explicit", () => {
        const ctx = fixture();
        try {
            writeDefinition(join(ctx.cwd, ".pi", "agents", "roles"), "role.secret.md", roleMarkdown("role.secret", "Secret"));
            const suppressed = load(ctx, { projectTrusted: false });
            assert.equal(suppressed.roles.has("role.secret"), false);
            assert.ok(suppressed.diagnostics.some((item) => item.code === DiagnosticCodes.projectCatalogSuppressed));
            const personal = parseDefinition(roleMarkdown("role.personal", "Personal"));
            const created = createDefinition({
                definition: personal.definition,
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: false,
            });
            assert.equal(created.ok, true);
            assert.equal(created.scope, "user");
            assert.equal(created.path.includes(`${join(".pi", "agents")}`), false);
            const refused = createDefinition({
                definition: { ...personal.definition, id: "role.project" },
                scope: "project",
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: false,
            });
            assert.equal(refused.ok, false);
            assert.equal(readdirSync(join(ctx.cwd, ".pi", "agents", "roles")).includes("role.project.md"), false);
            const allowed = createDefinition({
                definition: { ...personal.definition, id: "role.project", name: "Project" },
                scope: "project",
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
            });
            assert.equal(allowed.ok, true);
            assert.ok(allowed.path.startsWith(join(ctx.cwd, ".pi", "agents")));
        } finally {
            ctx.cleanup();
        }
    });

    it("refuses symlink escapes and leaves no temporary file after an atomic create", () => {
        const ctx = fixture();
        try {
            const outside = join(ctx.root, "outside");
            mkdirSync(outside);
            const roles = join(ctx.userRoot, "agents", "roles");
            mkdirSync(join(ctx.userRoot, "agents"));
            symlinkSync(outside, roles);
            const parsed = parseDefinition(roleMarkdown("role.linked", "Linked"));
            const saved = createDefinition({
                definition: parsed.definition,
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
            });
            assert.equal(saved.ok, false);
            assert.equal(readdirSync(outside).length, 0);
            rmSync(roles);
            const written = createDefinition({
                definition: parsed.definition,
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
            });
            assert.equal(written.ok, true);
            assert.equal(readFileSync(written.path, "utf8").startsWith("---\n"), true);
            assert.equal(readdirSync(roles).some((name) => name.includes(".tmp")), false);
            const digest = createHash("sha256").update(readFileSync(written.path)).digest("hex");
            assert.equal(load(ctx).roles.get("role.linked").contentDigest, digest);
        } finally {
            ctx.cleanup();
        }
    });

    it("returns a new immutable snapshot with a stable digest for unchanged bytes", () => {
        const ctx = fixture("real");
        try {
            const first = load(ctx);
            const second = load(ctx);
            assert.notEqual(first, second);
            assert.equal(first.digest, second.digest);
            assert.equal(first.revision, first.digest);
            assert.throws(() => first.roles.set("role.extra", /** @type {never} */ (undefined)));
            assert.throws(() => {
                first.roles.get("role.developer").definition.name = "Changed";
            });
            assert.equal(second.roles.get("role.developer").definition.name, "Developer");
        } finally {
            ctx.cleanup();
        }
    });
});
