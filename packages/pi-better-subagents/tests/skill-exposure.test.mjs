/**
 * Skill exposure (#664).
 *
 * Three observable states, one precedence chain, and one frozen recipe entry:
 *
 * - an absent choice keeps user-catalog discovery (no argv flag);
 * - `[]` disables discovery (`--no-skills`) and must NOT fall through to a
 *   wider default;
 * - paths load exactly those skills (`--no-skills --skill <path>…`).
 *
 * The argv mapping is Pi's CLI contract, so it is asserted here directly. The
 * run through the real launch path lives in `batch_spawn_end_to_end.test.mjs`,
 * and recipe replay in `continuation.test.mjs`.
 *
 * @covers subagent.skill-exposure
 * @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    absolutizeSkillPaths,
    describeSkillExposure,
    normalizeSkillExposure,
    resolveSkillExposure,
    skillLaunchArgs,
} from "../skills.ts";
import { mergeJobOptions } from "../batch.mjs";
import { parseDefinition, serializeDefinition, DiagnosticCodes } from "../catalog-schema.ts";
import { loadCatalog } from "../catalog-store.ts";
import { inspectCatalog, resolveSelection } from "../catalog-resolver.ts";
import { prepareCatalogJob } from "../catalog-runtime.ts";

const WORKSPACE = "/work/project";
const SKILL_A = "/Users/someone/.pi/agent/skills/better-review/SKILL.md";
const SKILL_B = "/Users/someone/.pi/agent/skills/test-quality/SKILL.md";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "skill-exposure-"));
    const cwd = join(root, "project");
    const userRoot = join(root, "user");
    const bundledRoot = join(root, "bundled");
    mkdirSync(cwd);
    mkdirSync(userRoot);
    mkdirSync(bundledRoot);
    return {
        root,
        cwd,
        userRoot,
        bundledRoot,
        write(directory, filename, markdown) {
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, filename), markdown);
        },
        cleanup() { rmSync(root, { recursive: true, force: true }); },
    };
}

describe("skill exposure argv", () => {
    it("emits no flag at all when nothing chose an exposure", () => {
        const exposure = resolveSkillExposure({ cwd: WORKSPACE });
        assert.deepEqual(exposure, { mode: "inherit", paths: [], source: "default" });
        assert.deepEqual(skillLaunchArgs(exposure), [], "an inheriting launch must stay byte-identical");
    });

    it("maps an empty list to --no-skills and nothing else", () => {
        const exposure = resolveSkillExposure({ requested: [], cwd: WORKSPACE });
        assert.equal(exposure.mode, "none");
        assert.deepEqual(skillLaunchArgs(exposure), ["--no-skills"]);
    });

    it("disables discovery and loads each explicit path exactly once", () => {
        const exposure = resolveSkillExposure({ requested: [SKILL_A, SKILL_B], cwd: WORKSPACE });
        assert.equal(exposure.mode, "explicit");
        assert.deepEqual(skillLaunchArgs(exposure), [
            "--no-skills", "--skill", SKILL_A, "--skill", SKILL_B,
        ]);
    });

    it("resolves relative paths against the child workspace so the recipe is replayable", () => {
        const exposure = resolveSkillExposure({ requested: [".agents/skills/review/SKILL.md"], cwd: WORKSPACE });
        assert.deepEqual(exposure.paths, [join(WORKSPACE, ".agents/skills/review/SKILL.md")]);
        assert.deepEqual(absolutizeSkillPaths([SKILL_A], WORKSPACE), [SKILL_A], "absolute paths stay literal");
    });

    it("trims entries and rejects shapes Pi could not act on", () => {
        assert.deepEqual(normalizeSkillExposure([`  ${SKILL_A}  `], "skills"), [SKILL_A]);
        assert.equal(normalizeSkillExposure(undefined, "skills"), undefined);
        assert.equal(normalizeSkillExposure(null, "skills"), undefined);
        assert.throws(() => normalizeSkillExposure(SKILL_A, "skills"), /must be an array of absolute paths/);
        assert.throws(() => normalizeSkillExposure([""], "skills"), /skills\[0\] must be a non-empty path/);
        assert.throws(() => normalizeSkillExposure([42], "skills"), /skills\[0\] must be a non-empty path/);
    });

    it("names the offending layer in a config mistake", () => {
        assert.throws(
            () => resolveSkillExposure({ configured: { paths: [SKILL_A] }, cwd: WORKSPACE }),
            /config defaultSkills must be an array/,
        );
    });
});

describe("skill exposure precedence", () => {
    const table = [
        ["launch beats catalog, session, config, and discovery", { requested: [SKILL_A], catalog: [SKILL_B], session: { value: [SKILL_B] }, configured: [] }, "explicit", "launch", [SKILL_A]],
        ["catalog beats session, config, and discovery", { catalog: [], session: { value: [SKILL_A] }, configured: [SKILL_B] }, "none", "catalog", []],
        ["session beats config and discovery", { session: { value: [SKILL_A] }, configured: [SKILL_B] }, "explicit", "session", [SKILL_A]],
        ["session discovery beats a saved config list", { session: {}, configured: [SKILL_B] }, "inherit", "session", []],
        ["session none beats a saved config list", { session: { value: [] }, configured: [SKILL_B] }, "none", "session", []],
        ["config beats discovery when the others are unset", { catalog: null, configured: [SKILL_B] }, "explicit", "config", [SKILL_B]],
        ["nothing set keeps discovery", {}, "inherit", "default", []],
        // `[]` is a choice: it must not be treated as "unset" and widen to config.
        ["an empty launch list does not fall through to session or config", { requested: [], session: { value: [SKILL_A] }, configured: [SKILL_B] }, "none", "launch", []],
        ["an empty catalog list does not fall through to session or config", { catalog: [], session: { value: [SKILL_A] }, configured: [SKILL_B] }, "none", "catalog", []],
        ["an empty session list does not fall through to config", { session: { value: [] }, configured: [SKILL_B] }, "none", "session", []],
    ];
    for (const [name, input, mode, source, paths] of table) {
        it(name, () => {
            const exposure = resolveSkillExposure({ cwd: WORKSPACE, ...input });
            assert.equal(exposure.mode, mode);
            assert.equal(exposure.source, source);
            assert.deepEqual(exposure.paths, paths);
        });
    }

    it("a frozen recipe decides even when it recorded no choice", () => {
        const inherited = resolveSkillExposure({ saved: {}, requested: [SKILL_A], configured: [SKILL_B], cwd: WORKSPACE });
        assert.equal(inherited.mode, "inherit", "a pre-#664 recipe keeps discovery");
        assert.equal(inherited.source, "recipe");
        const none = resolveSkillExposure({ saved: { paths: [] }, configured: [SKILL_B], cwd: WORKSPACE });
        assert.equal(none.mode, "none");
        assert.deepEqual(skillLaunchArgs(none), ["--no-skills"]);
    });
});

describe("skill exposure reporting", () => {
    it("states the resolved mode and source for each state", () => {
        assert.match(describeSkillExposure(resolveSkillExposure({ cwd: WORKSPACE })), /discovery/);
        assert.match(describeSkillExposure(resolveSkillExposure({ session: {}, configured: [SKILL_A], cwd: WORKSPACE })), /discovery.*source session/);
        const none = describeSkillExposure(resolveSkillExposure({ requested: [], cwd: WORKSPACE }));
        assert.match(none, /none/);
        assert.match(none, /--no-skills/);
        assert.match(none, /source launch/);
        const explicit = describeSkillExposure(resolveSkillExposure({ requested: [SKILL_A, SKILL_B], configured: [SKILL_A], cwd: WORKSPACE }));
        assert.match(explicit, /2 explicit/);
        assert.match(explicit, /better-review/);
        assert.match(explicit, /source launch/, "the launch value, not the config default");
    });
});

describe("skill exposure in a batch", () => {
    it("inherits shared skills, lets a job replace them, and keeps [] as a choice", () => {
        assert.deepEqual(mergeJobOptions({ skills: [SKILL_A] }, { prompt: "x" }).skills, [SKILL_A]);
        assert.deepEqual(mergeJobOptions({ skills: [SKILL_A] }, { prompt: "x", skills: [SKILL_B] }).skills, [SKILL_B]);
        assert.deepEqual(
            mergeJobOptions({ skills: [SKILL_A] }, { prompt: "x", skills: [] }).skills,
            [],
            "a job's empty list must not fall back to shared",
        );
        assert.equal(mergeJobOptions({}, { prompt: "x" }).skills, undefined);
        assert.equal(mergeJobOptions({ skills: [] }, { prompt: "x" }).skills?.length, 0);
    });
});

describe("skill exposure carried by a catalog definition", () => {
    it("inherits a role's list into its agent and lets an override replace it", () => {
        const ctx = fixture();
        try {
            ctx.write(join(ctx.userRoot, "agents", "roles"), "developer.md", `---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
defaults:
  model: openai/gpt-6.1-sol
  skills:
    - ${SKILL_A}
---
Implement.
`);
            ctx.write(join(ctx.userRoot, "agents", "agents"), "reviewer.md", `---
schema: pi-agent/v1
kind: agent
id: agent.reviewer
name: Reviewer
roleId: role.developer
instructions:
  mode: add
overrides:
  skills: []
---
Review.
`);
            const snapshot = loadCatalog({
                cwd: ctx.cwd, userRoot: ctx.userRoot, bundledRoot: ctx.bundledRoot, projectTrusted: true,
            });
            const role = resolveSelection(snapshot, { roleId: "role.developer" });
            assert.equal(role.launchable, true);
            assert.deepEqual(role.effective?.skills, { value: [SKILL_A], source: "role-default", explicit: false });

            const agent = resolveSelection(snapshot, { agentId: "agent.reviewer" });
            assert.equal(agent.launchable, true);
            assert.deepEqual(agent.effective?.skills, { value: [], source: "agent-override", explicit: true },
                "an override's empty list means none, not inherit");

            const inspected = inspectCatalog(snapshot, "role.developer");
            assert.equal(inspected.skills?.value?.[0], SKILL_A, "inspection reports the definition's own list");
        } finally {
            ctx.cleanup();
        }
    });

    it("lets an explicit null suppress the role's list", () => {
        const ctx = fixture();
        try {
            ctx.write(join(ctx.userRoot, "agents", "roles"), "developer.md", `---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
defaults:
  skills:
    - ${SKILL_A}
---
Implement.
`);
            ctx.write(join(ctx.userRoot, "agents", "agents"), "reviewer.md", `---
schema: pi-agent/v1
kind: agent
id: agent.reviewer
name: Reviewer
roleId: role.developer
instructions:
  mode: add
overrides:
  skills: null
---
Review.
`);
            const snapshot = loadCatalog({
                cwd: ctx.cwd, userRoot: ctx.userRoot, bundledRoot: ctx.bundledRoot, projectTrusted: true,
            });
            const agent = resolveSelection(snapshot, { agentId: "agent.reviewer" });
            assert.deepEqual(agent.effective?.skills, { value: null, source: "agent-override", explicit: true });
            const exposure = resolveSkillExposure({
                catalog: agent.effective?.skills.value,
                configured: [SKILL_B],
                cwd: WORKSPACE,
            });
            assert.deepEqual(exposure.paths, [SKILL_B], "a suppressed list falls to the config default");
            assert.equal(exposure.source, "config");
        } finally {
            ctx.cleanup();
        }
    });

    it("rejects a relative path because a definition has no workspace of its own", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
defaults:
  skills:
    - .agents/skills/review/SKILL.md
---
Implement.
`);
        assert.equal(parsed.ok, false);
        const blocked = parsed.diagnostics.find((item) => item.code === DiagnosticCodes.invalidField && item.field === "defaults.skills");
        assert.ok(blocked, "relative skill paths must block launch with a field diagnostic");
        assert.equal(blocked.blocking, true);
    });

    it("round-trips skills through serialization", () => {
        const parsed = parseDefinition(`---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
defaults:
  skills: []
---
Implement.
`);
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.definition.defaults?.skills, []);
        const markdown = serializeDefinition(parsed.definition).markdown;
        assert.match(markdown, /skills: \[\]/);
        const roundTrip = parseDefinition(markdown);
        assert.deepEqual(roundTrip.definition?.defaults?.skills, [], "an empty list must survive a save");
    });

    it("freezes the catalog's exposure on the prepared launch record", async () => {
        const ctx = fixture();
        try {
            ctx.write(join(ctx.userRoot, "agents", "roles"), "developer.md", `---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
defaults:
  model: openai/gpt-6.1-sol
  skills:
    - ${SKILL_A}
---
Implement.
`);
            const snapshot = loadCatalog({
                cwd: ctx.cwd, userRoot: ctx.userRoot, bundledRoot: ctx.bundledRoot, projectTrusted: true,
            });
            const prepared = await prepareCatalogJob(snapshot, { prompt: "Do it", role: "developer" }, {
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                bundledRoot: ctx.bundledRoot,
                projectTrusted: true,
                hasUI: false,
                foregroundModel: "openai/gpt-6.1-sol",
                registryDir: join(ctx.root, "registry"),
                registry: {
                    getAvailable: () => [{ provider: "openai", id: "gpt-6.1-sol", reasoning: true }],
                    find: () => undefined,
                },
            });
            assert.equal(prepared.status, "ready");
            if (prepared.status !== "ready") return;
            assert.deepEqual(prepared.assign.catalog.effective.skills, {
                value: [SKILL_A], source: "role-default", explicit: false,
            }, "the run record carries the resolved exposure, not the raw file value");

            // The launch path prefers an explicit option over the catalog choice.
            assert.equal(resolveSkillExposure({
                catalog: prepared.assign.catalog.effective.skills.value, cwd: WORKSPACE,
            }).source, "catalog");
            assert.equal(resolveSkillExposure({
                requested: [], catalog: prepared.assign.catalog.effective.skills.value, cwd: WORKSPACE,
            }).source, "launch");
        } finally {
            ctx.cleanup();
        }
    });
});
