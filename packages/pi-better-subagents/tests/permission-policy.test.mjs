import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    currentSandboxPermissions, observeSandboxPermissions, resolveSubagentPermissions,
    SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL,
} from "../permission-policy.ts";
import { maybeBuildSandboxCommand } from "../sandbox.ts";
import { compileWritePolicy } from "../shared-sandbox-core.ts";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = { enabled: false, projectFiles: "read-write", outsideProject: "read",
    storedCredentials: "read", commands: true, network: true };
const child = { ...main, enabled: true };
function fixture(before = false) {
    const events = new EventEmitter();
    const pi = { events };
    let snapshot = { state: "disabled", permissions: main, subagentPermissions: child };
    events.on(SANDBOX_POLICY_REQUEST_CHANNEL, () => events.emit(SANDBOX_POLICY_CHANNEL, snapshot));
    if (before) events.emit(SANDBOX_POLICY_CHANNEL, snapshot);
    return { pi, events, publish(next) { snapshot = next; events.emit(SANDBOX_POLICY_CHANNEL, next); } };
}

describe("subagent permission policy", () => {
    it("preserves legacy behavior when there is no publisher or event bus", () => {
        assert.deepEqual(resolveSubagentPermissions({}, undefined), { sandboxEnabled: true, enforced: false });
        const pi = { events: new EventEmitter() };
        assert.deepEqual(resolveSubagentPermissions(pi, false), { sandboxEnabled: false, enforced: false });
    });

    it("requests current settings on late subscription and captures changes per bus", () => {
        const { pi, publish } = fixture(true);
        observeSandboxPermissions(pi);
        assert.equal(currentSandboxPermissions(pi).subagentPermissions.enabled, true);
        const plan = resolveSubagentPermissions(pi, undefined);
        assert.deepEqual(plan.permissions, {
            projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
            commands: true, network: true,
        });
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, enabled: false } });
        assert.equal(resolveSubagentPermissions(pi, undefined).sandboxEnabled, false);
        assert.equal(plan.sandboxEnabled, true);
        assert.equal(resolveSubagentPermissions(pi, true).enforced, true);
    });

    it("does not allow a tool opt-out to bypass the human-enabled profile", () => {
        const { pi } = fixture();
        assert.throws(() => resolveSubagentPermissions(pi, false), /sandbox:false cannot bypass/);
    });

    it("blocks Main commands even if the Subagents profile is disabled", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: { ...main, enabled: true, commands: false },
            subagentPermissions: { ...child, enabled: false } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Main sandbox profile disables commands/);
    });

    it("blocks child commands and network before allocating a run", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, commands: false } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Subagents profile disables commands/);
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, network: false } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /model requests.*provider isolation/);
    });

    it("never silently drops a selected capability profile in the adapter", () => {
        const dir = mkdtempSync(join(tmpdir(), "subagent-permission-"));
        const args = { profilePath: join(dir, "profile.sb"), writableDir: dir, home: dir,
            piBin: "/usr/bin/true", piArgs: [],
            permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
                commands: true, network: false } };
        try {
            const supportsPermissions = "permissions" in compileWritePolicy({ writableRoot: dir, home: dir, permissions: args.permissions });
            if (!supportsPermissions) {
                assert.throws(() => maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true }),
                    /Permission-aware sandbox core is unavailable/);
            } else if (process.platform === "darwin") {
                maybeBuildSandboxCommand(args, { sandboxEnabled: true, explicitSandbox: true });
                assert.match(readFileSync(args.profilePath, "utf8"), /deny network\*/);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails closed on malformed published permissions, without affecting other sessions", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, storedCredentials: "all" } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Invalid sandbox permission profile/);
        assert.equal(resolveSubagentPermissions(fixture().pi, undefined).sandboxEnabled, true);
    });
});
