/**
 * The canonical write-deny rule module: validation, persistence, and putting
 * rules into force.
 *
 * Every fixture here is disposable and lives under /var/tmp, and the pi agent
 * directory is injected, so no test ever reads or writes the developer's real
 * ~/.pi state. That injection is also what lets these tests assert the exact
 * bytes of the override file.
 */

import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import test, { after } from "node:test";

import {
    DENY_RULES_FORMAT_VERSION,
    DenyRuleError,
    DenyRuleManager,
    type DenyRuleSeams,
    denyRuleOverridePath,
    describeDenyRules,
    formatDenyRuleReport,
    normalizeDenyRuleTemplate,
    partitionDenyRules,
    planDenyRuleAddition,
    planDenyRuleRemoval,
    readDenyRuleOverride,
} from "../deny-rules.ts";
import { createSandboxedWriteOperations } from "../files.ts";
import { PACKAGED_DENY_WRITE_TEMPLATES } from "../policy.ts";
import { ForegroundSandboxController, type ForegroundSandboxStatus } from "../state.ts";

const fixtures = realpathSync(
    mkdtempSync(join(realpathSync("/var/tmp"), "pi-better-sandbox-deny-rules-")),
);
after(() => rmSync(fixtures, { recursive: true, force: true }));

let counter = 0;

function directory(name: string): string {
    const path = join(fixtures, `${name}-${(counter += 1)}`);
    mkdirSync(path, { recursive: true });
    return path;
}

type Harness = {
    manager: DenyRuleManager;
    controller: ForegroundSandboxController;
    projectRoot: string;
    home: string;
    agentDir: string;
    overridePath: string;
    announced: ForegroundSandboxStatus[];
    seams: DenyRuleSeams;
};

/**
 * A manager wired to a real controller over a real disposable project, with the
 * agent directory and home redirected into the fixture tree.
 */
function harness(name: string, options: { projectRoot?: string; home?: string } = {}): Harness {
    const home = options.home ?? directory(`${name}-home`);
    const agentDir = directory(`${name}-agent`);
    const projectRoot = options.projectRoot ?? directory(`${name}-project`);
    const seams: DenyRuleSeams = { home: () => home, agentDir: () => agentDir };

    const controller = new ForegroundSandboxController(seams);
    controller.beginSession(projectRoot);

    const announced: ForegroundSandboxStatus[] = [];
    const manager = new DenyRuleManager({
        controller,
        onStateChange: (status) => announced.push(status),
        seams,
    });

    return {
        manager,
        controller,
        projectRoot,
        home,
        agentDir,
        overridePath: denyRuleOverridePath(seams),
        announced,
        seams,
    };
}

test("loading writes nothing: the packaged defaults come from source, not from disk", () => {
    const fixture = harness("no-install-file");

    const report = fixture.manager.load();

    assert.equal(existsSync(fixture.overridePath), false, "installing must not materialize a file");
    assert.equal(existsSync(fixture.agentDir), true, "the agent dir itself is pre-existing");
    assert.deepEqual([...report.templates], [...PACKAGED_DENY_WRITE_TEMPLATES].sort());
    assert.equal(report.origin, "packaged");
    assert.deepEqual(
        report.rules.map((rule) => rule.path),
        [
            join(fixture.projectRoot, ".env"),
            join(fixture.projectRoot, ".env.local"),
            join(fixture.projectRoot, ".git/hooks"),
        ],
    );
});

test("the override appears only after a rule changes, and holds the templates as typed", () => {
    const fixture = harness("override-on-change");
    fixture.manager.load();
    assert.equal(existsSync(fixture.overridePath), false);

    fixture.manager.add("build/artifacts");

    assert.equal(existsSync(fixture.overridePath), true);
    assert.deepEqual(JSON.parse(readFileSync(fixture.overridePath, "utf8")), {
        version: DENY_RULES_FORMAT_VERSION,
        denyWrite: [".env", ".env.local", ".git/hooks", "build/artifacts"],
    });
});

test("a relative rule is stored as a template and denies the same relative path in every project", () => {
    const first = harness("cross-project-first");
    first.manager.load();
    first.manager.add("build/artifacts");

    // A second project, same global agent directory: same template, different
    // absolute path.
    const secondProject = directory("cross-project-second");
    const seams: DenyRuleSeams = { home: () => first.home, agentDir: () => first.agentDir };
    const controller = new ForegroundSandboxController(seams);
    controller.beginSession(secondProject);
    const manager = new DenyRuleManager({ controller, onStateChange: () => {}, seams });

    const report = manager.load();

    assert.deepEqual([...report.templates], [".env", ".env.local", ".git/hooks", "build/artifacts"]);
    assert.ok(report.rules.some((rule) => rule.path === join(secondProject, "build/artifacts")));
    assert.ok(controller.status().denyWrite.includes(join(secondProject, "build/artifacts")));
});

test("an absolute rule denies that one path, wherever pi is launched from", () => {
    const fixture = harness("absolute-rule");
    const target = join(directory("absolute-target"), "keys");
    fixture.manager.load();

    const report = fixture.manager.add(target);

    assert.ok(report.templates.includes(target));
    assert.ok(report.rules.some((rule) => rule.template === target && rule.path === target));
});

test("a ~ rule resolves against the home directory and is stored with its tilde", () => {
    const fixture = harness("tilde-rule");
    fixture.manager.load();

    const report = fixture.manager.add("~/.aws");

    assert.ok(report.templates.includes(`~${sep}.aws`));
    assert.ok(report.rules.some((rule) => rule.path === join(fixture.home, ".aws")));
    assert.ok(fixture.controller.status().denyWrite.includes(join(fixture.home, ".aws")));
});

test("a rule for a file that does not exist yet still resolves and is enforced", () => {
    const fixture = harness("not-yet-created");
    fixture.manager.load();

    const report = fixture.manager.add("config/production.env");

    const expected = join(fixture.projectRoot, "config/production.env");
    assert.equal(existsSync(expected), false);
    assert.ok(report.rules.some((rule) => rule.path === expected));
    assert.ok(fixture.controller.status().denyWrite.includes(expected));
});

test("the displayed path is always canonical, even when the project is reached through a symlink", () => {
    const real = directory("canonical-real");
    const alias = join(fixtures, `canonical-alias-${(counter += 1)}`);
    symlinkSync(real, alias);
    const fixture = harness("canonical", { projectRoot: alias });
    fixture.manager.load();

    const report = fixture.manager.add("secrets");

    assert.ok(report.rules.some((rule) => rule.path === join(real, "secrets")));
    assert.equal(
        report.rules.some((rule) => rule.path.startsWith(alias + sep)),
        false,
        "no displayed path may keep the symlinked spelling",
    );
});

test("a duplicate is refused however it is spelled, including through a symlink alias", () => {
    const fixture = harness("duplicates");
    writeFileSync(join(fixture.projectRoot, ".env"), "SECRET=1\n");
    symlinkSync(join(fixture.projectRoot, ".env"), join(fixture.projectRoot, "alias.env"));
    fixture.manager.load();

    for (const spelling of [".env", "./.env", ".env/", join(fixture.projectRoot, ".env"), "alias.env"]) {
        assert.throws(
            () => fixture.manager.add(spelling),
            (error: unknown) =>
                error instanceof DenyRuleError &&
                error.kind === "duplicate" &&
                /already/.test(error.message),
            `adding ${spelling} again must be refused`,
        );
    }
    assert.equal(existsSync(fixture.overridePath), false, "a refused change writes nothing");
});

test("a rule already covered by a denied directory is refused as redundant", () => {
    const fixture = harness("covered");
    fixture.manager.load();

    assert.throws(
        () => fixture.manager.add(".git/hooks/pre-commit"),
        (error: unknown) =>
            error instanceof DenyRuleError &&
            error.kind === "overlapping" &&
            /already inside the write-denied directory/.test(error.message),
    );
});

test("a rule that would swallow a narrower rule names it instead of retiring it silently", () => {
    const fixture = harness("covering");
    fixture.manager.load();

    assert.throws(
        () => fixture.manager.add(".git"),
        (error: unknown) =>
            error instanceof DenyRuleError &&
            error.kind === "overlapping" &&
            /Remove that rule first with \/sandbox deny remove \.git\/hooks/.test(error.message),
    );
    // The narrower rule is still there, untouched.
    assert.ok(
        fixture.manager.report().rules.some((rule) => rule.template === ".git/hooks"),
    );
});

test("malformed entries are refused with a message that says what is wrong", () => {
    const fixture = harness("malformed");
    fixture.manager.load();

    const cases: Array<[string, RegExp]> = [
        ["   ", /may not be empty/],
        ["a\nb", /line breaks or null bytes/],
        ["*.pem", /concrete paths, not patterns/],
        ["src/**/secret", /concrete paths, not patterns/],
    ];
    for (const [entry, expected] of cases) {
        assert.throws(
            () => fixture.manager.add(entry),
            (error: unknown) =>
                error instanceof DenyRuleError && error.kind === "malformed" && expected.test(error.message),
            `${JSON.stringify(entry)} must be refused`,
        );
    }
});

test("a rule that would deny the whole project root is refused as unsafe", () => {
    const projectRoot = join(directory("unsafe-parent"), "work");
    mkdirSync(projectRoot, { recursive: true });
    const fixture = harness("unsafe", { projectRoot });
    fixture.manager.load();

    for (const entry of [".", "./", "..", sep, join(projectRoot, "..")]) {
        assert.throws(
            () => fixture.manager.add(entry),
            (error: unknown) =>
                error instanceof DenyRuleError &&
                error.kind === "unsafe" &&
                /would make every write in the project fail/.test(error.message),
            `${entry} must be refused`,
        );
    }
});

test("~ is refused when the project lives under home, because it would deny everything", () => {
    const home = directory("home-with-project");
    const projectRoot = join(home, "work");
    mkdirSync(projectRoot, { recursive: true });
    const fixture = harness("tilde-unsafe", { projectRoot, home });
    fixture.manager.load();

    assert.throws(
        () => fixture.manager.add("~"),
        (error: unknown) => error instanceof DenyRuleError && error.kind === "unsafe",
    );
});

test("a rule can be removed by its template or by the absolute path the UI shows", () => {
    const fixture = harness("remove-spellings");
    fixture.manager.load();

    const byTemplate = fixture.manager.remove(".env.local");
    assert.equal(
        byTemplate.rules.some((rule) => rule.template === ".env.local"),
        false,
    );

    const byPath = fixture.manager.remove(join(fixture.projectRoot, ".env"));
    assert.deepEqual([...byPath.templates], [".git/hooks"]);
    assert.deepEqual(fixture.controller.status().denyWrite, [
        join(fixture.projectRoot, ".git/hooks"),
    ]);
});

test("removing a packaged default creates the override without it", () => {
    const fixture = harness("remove-default");
    fixture.manager.load();
    assert.equal(existsSync(fixture.overridePath), false);

    fixture.manager.remove(".env");

    assert.deepEqual(JSON.parse(readFileSync(fixture.overridePath, "utf8")), {
        version: DENY_RULES_FORMAT_VERSION,
        denyWrite: [".env.local", ".git/hooks"],
    });
});

test("removing something that is not a rule says so and lists what is", () => {
    const fixture = harness("remove-unknown");
    fixture.manager.load();

    assert.throws(
        () => fixture.manager.remove("nowhere/at/all"),
        (error: unknown) =>
            error instanceof DenyRuleError &&
            error.kind === "unknown" &&
            /Current rules: \.env, \.env\.local, \.git\/hooks/.test(error.message),
    );
});

test("reset deletes the override and restores the defaults the installed package ships", () => {
    const fixture = harness("reset");
    fixture.manager.load();
    fixture.manager.remove(".env");
    fixture.manager.add("build/artifacts");
    assert.equal(existsSync(fixture.overridePath), true);

    const report = fixture.manager.reset();

    assert.equal(existsSync(fixture.overridePath), false);
    assert.equal(report.origin, "packaged");
    assert.deepEqual([...report.templates], [...PACKAGED_DENY_WRITE_TEMPLATES].sort());
    assert.deepEqual(fixture.controller.status().denyWrite, [
        join(fixture.projectRoot, ".env"),
        join(fixture.projectRoot, ".env.local"),
        join(fixture.projectRoot, ".git/hooks"),
    ]);
});

test("reset with no override changes nothing and still creates no file", () => {
    const fixture = harness("reset-noop");
    fixture.manager.load();

    const report = fixture.manager.reset();

    assert.match(report.summary, /no write-deny override/);
    assert.equal(existsSync(fixture.overridePath), false);
    assert.deepEqual([...report.templates], [...PACKAGED_DENY_WRITE_TEMPLATES].sort());
});

test("a broken override keeps the packaged defaults in force and is not overwritten", () => {
    const fixture = harness("broken-override");
    mkdirSync(join(fixture.agentDir, "extensions"), { recursive: true });
    writeFileSync(fixture.overridePath, "{ not json");

    const report = fixture.manager.load();

    assert.equal(report.origin, "packaged");
    assert.match(report.overrideProblem ?? "", /is not valid JSON/);
    assert.deepEqual([...report.templates], [...PACKAGED_DENY_WRITE_TEMPLATES].sort());

    // Changing a rule would have to rewrite the file, so it is refused with the
    // way out rather than clobbering whatever the human was editing.
    assert.throws(
        () => fixture.manager.add("build"),
        (error: unknown) =>
            error instanceof DenyRuleError &&
            error.kind === "unreadable-override" &&
            /\/sandbox deny reset/.test(error.message),
    );
    assert.equal(readFileSync(fixture.overridePath, "utf8"), "{ not json");

    fixture.manager.reset();
    assert.equal(existsSync(fixture.overridePath), false);
});

test("an override whose denyWrite is not a list of strings is reported, not guessed at", () => {
    const fixture = harness("wrong-shape");
    mkdirSync(join(fixture.agentDir, "extensions"), { recursive: true });
    writeFileSync(fixture.overridePath, JSON.stringify({ version: 1, denyWrite: [".env", 7] }));

    const report = fixture.manager.load();

    assert.match(report.overrideProblem ?? "", /must contain a "denyWrite" array of path strings/);
    assert.deepEqual([...report.templates], [...PACKAGED_DENY_WRITE_TEMPLATES].sort());
});

test("a global rule that would deny this project's root is held out and reported", () => {
    const home = directory("inert-home");
    const projectRoot = join(home, "work");
    mkdirSync(projectRoot, { recursive: true });
    const fixture = harness("inert", { projectRoot, home });
    mkdirSync(join(fixture.agentDir, "extensions"), { recursive: true });
    // Legitimately added while a different project was open; here it is an
    // ancestor of the project root.
    writeFileSync(
        fixture.overridePath,
        JSON.stringify({ version: 1, denyWrite: [".env", home] }),
    );

    const report = fixture.manager.load();

    assert.deepEqual(
        report.inert.map((rule) => rule.template),
        [home],
    );
    assert.match(report.inert[0]?.reason ?? "", /contains this project root/);
    // Still stored — it applies in the projects it was meant for.
    assert.ok(report.templates.includes(home));
    // But not in force here.
    assert.deepEqual(fixture.controller.status().denyWrite, [join(projectRoot, ".env")]);
});

test("every change is applied to the controller and announced exactly once", () => {
    const fixture = harness("announce");
    fixture.manager.load();
    const afterLoad = fixture.announced.length;

    const report = fixture.manager.add("build/artifacts");

    assert.equal(fixture.announced.length, afterLoad + 1);
    const announced = fixture.announced.at(-1);
    assert.deepEqual(announced, report.status, "the announced status is the one reported back");
    assert.ok(announced?.denyWrite.includes(join(fixture.projectRoot, "build/artifacts")));
});

test("a rule set is rendered with its canonical paths and the template behind each one", () => {
    const fixture = harness("rendering");
    fixture.manager.load();

    const rendered = formatDenyRuleReport(fixture.manager.report());

    assert.match(rendered, /no override has been created/);
    assert.match(rendered, new RegExp(`${fixture.projectRoot}/\\.env {3}\\[\\.env\\]`));
});

test("normalization collapses the spellings of one path into one template", () => {
    assert.equal(normalizeDenyRuleTemplate("  .git/hooks/  "), ".git/hooks");
    assert.equal(normalizeDenyRuleTemplate("./.git//hooks"), ".git/hooks");
    assert.equal(normalizeDenyRuleTemplate("~/"), "~");
    assert.equal(normalizeDenyRuleTemplate("~/.aws/"), `~${sep}.aws`);
    assert.equal(normalizeDenyRuleTemplate("/etc/hosts/"), "/etc/hosts");
    assert.equal(normalizeDenyRuleTemplate("/"), sep);
});

test("the planning functions are pure: they neither read nor write the override", () => {
    const fixture = harness("pure-planning");
    const templates = [...PACKAGED_DENY_WRITE_TEMPLATES];

    const added = planDenyRuleAddition("build", templates, fixture.projectRoot, fixture.seams);
    const removed = planDenyRuleRemoval(".env", templates, fixture.projectRoot, fixture.seams);

    assert.deepEqual(added.templates, [".env", ".env.local", ".git/hooks", "build"]);
    assert.deepEqual(removed.templates, [".env.local", ".git/hooks"]);
    assert.deepEqual(templates, [...PACKAGED_DENY_WRITE_TEMPLATES], "the input set is untouched");
    assert.equal(existsSync(fixture.overridePath), false);
    assert.equal(readDenyRuleOverride(fixture.seams), undefined);
});

test("describing and partitioning agree on which rules apply here", () => {
    const home = directory("partition-home");
    const projectRoot = join(home, "work");
    mkdirSync(projectRoot, { recursive: true });
    const seams: DenyRuleSeams = { home: () => home };
    const templates = [".env", home, "~/.aws"];

    const partition = partitionDenyRules(templates, projectRoot, seams);
    const described = describeDenyRules(partition.applicable, projectRoot, seams);

    assert.deepEqual(partition.applicable, [".env", "~/.aws"]);
    assert.deepEqual(
        partition.inert.map((rule) => rule.template),
        [home],
    );
    assert.deepEqual(
        described.map((rule) => rule.path),
        [join(projectRoot, ".env"), join(home, ".aws")].sort(),
    );
});

test("a mutation already past its check is not refused by a rule added mid-write", async () => {
    const fixture = harness("mid-write-rule");
    fixture.manager.load();

    // A filesystem backend that stalls between the guard's decision and the
    // write, so a rule can change inside that window.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let written: string | undefined;
    const operations = createSandboxedWriteOperations(fixture.controller, {
        ...fixture.seams,
        localOperations: {
            async mkdir() {},
            async writeFile(path) {
                await gate;
                written = path;
            },
        },
    });

    const target = join(fixture.projectRoot, "reports", "summary.txt");
    const pending = operations.writeFile(target, "done\n");
    fixture.manager.add("reports");
    release();
    await pending;

    assert.equal(written, target, "the checked mutation completes on the path it was checked for");
    // The next one, started after the change, is refused.
    await assert.rejects(
        () => operations.writeFile(join(fixture.projectRoot, "reports", "next.txt"), "no\n"),
        /is a write-denied path/,
    );
});
