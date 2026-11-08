/**
 * The skill-exposure argv, executed by Pi's own parser and resource loader (#664).
 *
 * `skill-exposure.test.mjs` proves what our launcher asks for and
 * `batch_spawn_end_to_end.test.mjs` proves the detached child receives it. Both
 * read our side of the contract. This file reads Pi's side: the exact argv a
 * launch builds is parsed by the installed CLI's `parseArgs` and handed to the
 * installed `DefaultResourceLoader` the same way `main.ts` hands it over, so the
 * three states are proven against the skills Pi actually loads.
 *
 * Nothing here is a mock: without `--no-skills`, the loader discovers the user
 * skills directory; with it and no `--skill`, the list is empty; with explicit
 * paths and no discovery, only those skills are present — and
 * `formatSkillsForPrompt` (the function that renders the catalog into the system
 * prompt) is empty for "none" and lists only the requested name otherwise.
 *
 * @covers subagent.skill-exposure
 * @level integration
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_DIR));
const SDK_DIST = join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist");
const ARGS_URL = pathToFileURL(join(SDK_DIST, "cli/args.js")).href;
const LOADER_URL = pathToFileURL(join(SDK_DIST, "core/resource-loader.js")).href;
const SKILLS_URL = pathToFileURL(join(SDK_DIST, "core/skills.js")).href;
const SDK_AVAILABLE = existsSync(join(SDK_DIST, "cli/args.js")) && existsSync(join(SDK_DIST, "core/resource-loader.js"));

const { resolveSkillExposure, skillLaunchArgs } = await import("../skills.ts");

const RUNTIME = mkdtempSync(join(tmpdir(), "skill-loader-"));
const AGENT_DIR = join(RUNTIME, "agent");
const PROJECT = join(RUNTIME, "project");
const HOME = join(RUNTIME, "home");
const ALPHA = join(AGENT_DIR, "skills", "alpha");
const BETA = join(AGENT_DIR, "skills", "beta");

/** The two skills a user-level catalog holds in this fixture. */
function writeSkill(directory, name, description) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow ${name}.\n`);
}

writeSkill(ALPHA, "alpha", "Reviews a change.");
writeSkill(BETA, "beta", "Reports test quality.");
mkdirSync(PROJECT, { recursive: true });
mkdirSync(HOME, { recursive: true });

after(() => rmSync(RUNTIME, { recursive: true, force: true }));

/**
 * Load the child's skills exactly as `main.ts` does: parse our argv with Pi's
 * own parser, then construct the resource loader from those parsed fields.
 */
async function loadChild(argv) {
    const [{ parseArgs }, { DefaultResourceLoader }, { formatSkillsForPrompt }] = await Promise.all([
        import(ARGS_URL), import(LOADER_URL), import(SKILLS_URL),
    ]);
    const parsed = parseArgs(argv);
    const errors = parsed.diagnostics.filter((item) => item.type === "error");
    assert.deepEqual(errors, [], `our argv must parse without errors: ${JSON.stringify(argv)}`);
    // `~/.agents/skills` is discovered from HOME, which is real on a developer
    // machine. Isolate it so discovery can only see this fixture's catalog.
    const previousHome = process.env.HOME;
    process.env.HOME = HOME;
    try {
        const loader = new DefaultResourceLoader({
            cwd: PROJECT,
            agentDir: AGENT_DIR,
            noSkills: parsed.noSkills,
            additionalSkillPaths: parsed.skills ?? [],
            noExtensions: true,
            noPromptTemplates: true,
            noThemes: true,
        });
        await loader.reload();
        const { skills, diagnostics } = loader.getSkills();
        return {
            parsed,
            names: skills.map((skill) => skill.name).sort(),
            catalogText: formatSkillsForPrompt(skills),
            diagnostics,
        };
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
    }
}

describe("Pi loads exactly the skills our argv asks for", { skip: SDK_AVAILABLE ? false : "installed Pi SDK not available" }, () => {
    it("discovers the user catalog when a launch chose nothing", async () => {
        const argv = skillLaunchArgs(resolveSkillExposure({ cwd: PROJECT }));
        assert.deepEqual(argv, [], "an inheriting launch adds no flag");
        const child = await loadChild(argv);
        assert.deepEqual(child.names, ["alpha", "beta"],
            "the default really does advertise the whole user catalog");
        assert.match(child.catalogText, /<available_skills>[\s\S]*alpha[\s\S]*beta[\s\S]*<\/available_skills>/);
    });

    it("loads no catalog at all for an empty list", async () => {
        const argv = skillLaunchArgs(resolveSkillExposure({ requested: [], cwd: PROJECT }));
        const child = await loadChild(argv);
        assert.equal(child.parsed.noSkills, true);
        assert.deepEqual(child.names, [], "#664: --no-skills must remove every catalog entry");
        assert.equal(child.catalogText, "", "the system prompt gains no skills section");
        assert.deepEqual(child.diagnostics, [], "no skipped-path diagnostics");
    });

    it("loads only the requested skills and never the rest of the catalog", async () => {
        const argv = skillLaunchArgs(resolveSkillExposure({ requested: [ALPHA], cwd: PROJECT }));
        const child = await loadChild(argv);
        assert.equal(child.parsed.noSkills, true, "explicit paths disable discovery first");
        assert.deepEqual(child.parsed.skills, [ALPHA]);
        assert.deepEqual(child.names, ["alpha"], "the requested skill loads and discovery does not leak back in");
        assert.equal(child.catalogText.includes("alpha"), true);
        assert.equal(child.catalogText.includes("beta"), false);
        assert.equal(readFileSync(join(ALPHA, "SKILL.md"), "utf8").includes("Follow alpha"), true,
            "the loader read the same file the recipe froze");
    });

    it("resolves a relative path against the child workspace, as the recipe records it", async () => {
        const explicit = resolveSkillExposure({ requested: ["../agent/skills/beta"], cwd: PROJECT });
        const child = await loadChild(skillLaunchArgs(explicit));
        assert.deepEqual(child.names, ["beta"], "the resolved absolute path is what the child loads");
    });
});
