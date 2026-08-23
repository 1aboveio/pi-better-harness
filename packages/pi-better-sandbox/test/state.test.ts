import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
    ForegroundSandboxBlockedError,
    ForegroundSandboxController,
    type ForegroundSandboxSeams,
} from "../state.ts";

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-state-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

function project(name: string): string {
    const root = join(fixtures, name);
    mkdirSync(root, { recursive: true });
    return root;
}

const home = project("home");
const profiles = project("profiles");

/** A platform that resolves a backend, without touching this machine's PATH. */
function macos(overrides: ForegroundSandboxSeams = {}): ForegroundSandboxSeams {
    return {
        platform: () => "darwin",
        home: () => home,
        createProfileDir: () => profiles,
        ...overrides,
    };
}

test("a fresh controller blocks protected operations until a session captures a root", () => {
    const controller = new ForegroundSandboxController(macos());
    const status = controller.status();

    assert.equal(status.state, "failed");
    assert.equal(status.projectRoot, undefined);
    assert.throws(() => controller.requireLaunchPlan(), ForegroundSandboxBlockedError);
});

for (const reason of ["startup", "new", "resume", "fork", "reload"] as const) {
    test(`the sandbox is enabled after a ${reason} session start, even after a prior /sandbox off`, () => {
        const controller = new ForegroundSandboxController(macos());
        const root = project(`lifecycle-${reason}`);

        controller.beginSession(root);
        controller.disable();
        assert.equal(controller.status().state, "disabled");

        // The next session start of any kind re-arms protection: nothing about
        // the off state is carried across, because nothing persists it.
        const restarted = controller.beginSession(root);
        assert.equal(restarted.state, "enabled");
        assert.equal(controller.isUserEnabled(), true);
    });
}

test("the canonical launch directory is the sole writable root, even when reached through a symlink", () => {
    const controller = new ForegroundSandboxController(macos());
    const real = project("canonical-project");
    const alias = join(fixtures, "canonical-alias");
    rmSync(alias, { force: true });
    symlinkSync(real, alias);

    const status = controller.beginSession(alias);

    assert.equal(status.state, "enabled");
    assert.equal(status.writableRoot, real);
    assert.equal(status.projectRoot, real);
});

test("packaged deny defaults land under the captured project root", () => {
    const controller = new ForegroundSandboxController(macos());
    const root = project("deny-defaults");

    const status = controller.beginSession(root);

    assert.deepEqual(
        [...status.denyWrite],
        [join(root, ".env"), join(root, ".env.local"), join(root, ".git/hooks")],
    );
});

test("an unsafe launch root fails closed with actionable guidance instead of granting it", () => {
    const controller = new ForegroundSandboxController(macos());

    const status = controller.beginSession(home);

    assert.equal(status.state, "failed");
    assert.equal(status.writableRoot, undefined);
    assert.match(status.reason, /Relaunch pi from the directory you are actually working in/);
    assert.throws(() => controller.requireLaunchPlan(), ForegroundSandboxBlockedError);
});

test("an unsupported platform reports unavailable and blocks protected operations", () => {
    const controller = new ForegroundSandboxController(macos({ platform: () => "win32" }));
    controller.beginSession(project("unsupported"));

    const status = controller.status();
    assert.equal(status.state, "unavailable");
    assert.equal(status.backend, undefined);
    assert.match(status.reason, /unsupported on win32/);
    assert.throws(() => controller.requireLaunchPlan(), ForegroundSandboxBlockedError);
});

test("a Linux host without bubblewrap reports unavailable and blocks protected operations", () => {
    const controller = new ForegroundSandboxController(
        macos({ platform: () => "linux", lookupExecutable: () => undefined }),
    );
    controller.beginSession(project("no-bwrap"));

    const status = controller.status();
    assert.equal(status.state, "unavailable");
    assert.match(status.reason, /bubblewrap/);
    assert.throws(() => controller.requireLaunchPlan(), ForegroundSandboxBlockedError);
});

test("status reports the backend that was actually resolved, not a configured intent", () => {
    const controller = new ForegroundSandboxController(
        macos({ platform: () => "linux", lookupExecutable: () => "/opt/custom/bin/bwrap" }),
    );
    controller.beginSession(project("resolved-backend"));

    const status = controller.status();
    assert.equal(status.state, "enabled");
    assert.equal(status.backend, "linux-bubblewrap");
    assert.equal(status.executable, "/opt/custom/bin/bwrap");
    assert.equal(status.platform, "linux");
});

test("disabling yields an unconfined plan and re-enabling restores the confined one", () => {
    const controller = new ForegroundSandboxController(macos());
    const root = project("toggle");
    controller.beginSession(root);

    assert.equal(controller.requireLaunchPlan().confined, true);

    controller.disable();
    assert.deepEqual(controller.requireLaunchPlan(), { confined: false });

    const restored = controller.enable();
    assert.equal(restored.state, "enabled");
    const plan = controller.requireLaunchPlan();
    assert.equal(plan.confined, true);
    if (plan.confined) {
        assert.equal(plan.policy.writableRoot, root);
        assert.equal(plan.policy.home, home);
        assert.equal(plan.profilePath.startsWith(join(profiles, "foreground-")), true);
        assert.equal(plan.profilePath.endsWith(".sb"), true);
    }
});

test("reads and network are reported as unrestricted in every state", () => {
    const controller = new ForegroundSandboxController(macos());
    for (const status of [
        controller.status(),
        controller.beginSession(project("read-policy")),
        controller.disable(),
    ]) {
        assert.equal(status.readPolicy, "unrestricted");
        assert.equal(status.networkPolicy, "unrestricted");
    }
});

test("a published status cannot be mutated by whoever receives it", () => {
    const controller = new ForegroundSandboxController(macos());
    const status = controller.beginSession(project("frozen"));

    assert.throws(() => {
        (status as { state: string }).state = "disabled";
    });
    assert.throws(() => {
        (status.denyWrite as string[]).push("/etc/passwd");
    });
});

test("replacing the deny templates recompiles them against the current project root", () => {
    const controller = new ForegroundSandboxController(macos());
    const root = project("deny-replacement");
    controller.beginSession(root);

    const status = controller.setDenyWriteTemplates(["secrets", "~/vault"]);

    assert.deepEqual([...status.denyWrite].sort(), [join(home, "vault"), join(root, "secrets")].sort());
    assert.deepEqual([...controller.denyWriteTemplates()], ["secrets", "~/vault"]);
});

test("the profile path is a pure function of the policy it encodes", () => {
    const controller = new ForegroundSandboxController(macos());
    const root = project("profile-naming");
    controller.beginSession(root);

    const first = controller.requireLaunchPlan();
    const second = controller.requireLaunchPlan();
    controller.setDenyWriteTemplates([".env"]);
    const afterChange = controller.requireLaunchPlan();

    assert.equal(first.confined && second.confined && afterChange.confined, true);
    if (!first.confined || !second.confined || !afterChange.confined) return;
    assert.equal(first.profilePath, second.profilePath);
    assert.notEqual(first.profilePath, afterChange.profilePath);
});
