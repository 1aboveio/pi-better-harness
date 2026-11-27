import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
    FOREGROUND_SANDBOX_POLICY_CHANNEL,
    freezePolicy,
    publishForegroundSandboxPolicy,
    type ForegroundSandboxPolicyEvent,
} from "../events.ts";
import { defaultSandboxPermissions } from "../permissions.ts";
import { ForegroundSandboxController } from "../state.ts";

function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-background-policy-")));
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    return { root, home, project };
}

test("publication carries independent frozen Background policy and unchanged Main fields", () => {
    const f = fixture();
    try {
        const controller = new ForegroundSandboxController({ platform: () => "darwin", home: () => f.home });
        controller.beginSession(f.project);
        const settings = defaultSandboxPermissions();
        Object.assign(settings.background, { enabled: true, network: false, outsideProject: "off", storedCredentials: "off" });
        controller.setPermissionSettings(settings);
        controller.protectRuntimePaths([join(f.project, "extension-code")]);
        controller.setDenyWriteTemplates(["secrets"]);
        const events = createEventBus();
        const seen: ForegroundSandboxPolicyEvent[] = [];
        events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (value) => seen.push(value as ForegroundSandboxPolicyEvent));
        const main = controller.status();
        const payload = publishForegroundSandboxPolicy(events, main, controller.backgroundStatus());
        const { background, ...foreground } = payload;
        assert.deepEqual(foreground, { ...main, state: "disabled" });
        assert.deepEqual(seen, [payload]);
        assert.deepEqual(background, {
            state: "enabled", writableRoot: f.project, denyWrite: main.denyWrite,
            reason: controller.backgroundStatus().reason, permissions: settings.background,
        });
        assert.ok(background.denyWrite.includes(join(f.project, "secrets")));
        assert.ok(background.denyWrite.includes(join(f.project, "extension-code")));
        assert.ok(background.denyWrite.includes(join(f.project, ".pi")));
        assert.throws(() => { (background as { state: string }).state = "disabled"; }, TypeError);
        assert.throws(() => { (background.denyWrite as string[]).push("/extra"); }, TypeError);
        assert.throws(() => { (background.permissions as { network: boolean }).network = true; }, TypeError);

        settings.background.enabled = false;
        settings.background.network = true;
        settings.main.enabled = true;
        controller.setPermissionSettings(settings);
        const next = freezePolicy(controller.status(), controller.backgroundStatus());
        assert.equal(next.state, "enabled");
        assert.equal(next.background.state, "disabled");
        assert.equal(next.background.writableRoot, undefined);
        assert.deepEqual(next.background.permissions, settings.background);
        assert.equal(payload.background.state, "enabled", "a launch snapshot survives later edits");
        assert.equal(payload.background.permissions?.network, false);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("Background runtime-alias safety uses Background permissions rather than Main permissions", () => {
    const f = fixture();
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        const runtime = join(f.root, "runtime");
        mkdirSync(runtime);
        const alias = join(f.project, "runtime-link");
        symlinkSync(runtime, alias);
        process.env.PI_CODING_AGENT_DIR = alias;
        const controller = new ForegroundSandboxController({ platform: () => "darwin", home: () => f.home });
        controller.beginSession(f.project);
        const settings = defaultSandboxPermissions();
        settings.background.enabled = true;
        settings.background.projectFiles = "read";
        controller.setPermissionSettings(settings);
        assert.equal(controller.backgroundStatus().state, "enabled", "a read-only alias cannot be replaced by the task");
        settings.background.projectFiles = "read-write";
        controller.setPermissionSettings(settings);
        assert.equal(controller.status().state, "disabled");
        assert.equal(controller.backgroundStatus().state, "failed");
        assert.match(controller.backgroundStatus().reason, /task-writable symlink/);
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(f.root, { recursive: true, force: true });
    }
});

test("enabled Background fails closed without Main opt-in; disabled Background ignores missing backends", () => {
    const f = fixture();
    try {
        for (const [platform, project, expected, reason] of [
            ["win32", f.project, "unavailable", /unsupported on win32/],
            ["linux", f.project, "unavailable", /bubblewrap/],
            ["darwin", f.home, "failed", /Relaunch pi/],
        ] as const) {
            const controller = new ForegroundSandboxController({
                platform: () => platform, home: () => f.home, lookupExecutable: () => undefined,
            });
            controller.beginSession(project);
            const settings = defaultSandboxPermissions();
            settings.background.enabled = true;
            controller.setPermissionSettings(settings);
            assert.equal(controller.status().state, "disabled");
            assert.equal(controller.backgroundStatus().state, expected);
            assert.equal(controller.backgroundStatus().writableRoot, undefined);
            assert.match(controller.backgroundStatus().reason, reason);
            settings.background.enabled = false;
            controller.setPermissionSettings(settings);
            assert.equal(controller.backgroundStatus().state, "disabled");
        }
        const controller = new ForegroundSandboxController({ platform: () => "darwin", home: () => f.home });
        assert.equal(controller.backgroundStatus().state, "failed", "no session cannot grant a launch root");
        controller.beginSession(f.project);
        const settings = defaultSandboxPermissions();
        settings.background.enabled = true;
        controller.setPermissionSettings(settings);
        controller.block("Invalid stored policy");
        assert.equal(controller.backgroundStatus().state, "failed");
        assert.equal(controller.backgroundStatus().reason, "Invalid stored policy");
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
