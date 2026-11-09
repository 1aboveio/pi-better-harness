import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    currentSandboxPermissions, observeSandboxPermissions, resolveSubagentPermissions,
    SANDBOX_POLICY_CHANNEL, SANDBOX_POLICY_REQUEST_CHANNEL,
} from "../permission-policy.ts";
import { maybeBuildSandboxCommand } from "../sandbox.ts";
import { defaultSubagentTools } from "../shared-task-tools.ts";
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
    it("defaults off without a publisher, while honoring explicit true and false", () => {
        for (const pi of [{}, { events: new EventEmitter() }]) {
            for (const requested of [undefined, false, true]) {
                assert.deepEqual(resolveSubagentPermissions(pi, requested), {
                    sandboxEnabled: requested === true, enforced: false, tools: defaultSubagentTools(),
                });
            }
        }
    });

    it("defaults off when published settings omit the Subagents profile", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main });
        assert.equal(resolveSubagentPermissions(pi, undefined).sandboxEnabled, false);
        assert.equal(resolveSubagentPermissions(pi, true).sandboxEnabled, true);
    });

    it("honors an explicitly disabled profile unless true requests confinement", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, enabled: false } });
        for (const requested of [undefined, false]) {
            assert.equal(resolveSubagentPermissions(pi, requested).sandboxEnabled, false);
        }
        const plan = resolveSubagentPermissions(pi, true);
        assert.equal(plan.sandboxEnabled, true);
        assert.equal(plan.enforced, true);
        assert.deepEqual(plan.permissions, {
            projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: true, network: true,
        });
    });

    it("carries published subagent tools and rejects a malformed tool list", () => {
        const { pi, publish } = fixture(true);
        const tools = { applyPatch: false, trusted: [{ name: "web_fetch", package: "npm:other-web" }] };
        publish({ state: "disabled", permissions: main, subagentPermissions: child, subagentTools: tools });
        assert.deepEqual(resolveSubagentPermissions(pi, undefined).tools, tools);
        publish({ state: "disabled", permissions: main, subagentPermissions: child, subagentTools: { applyPatch: true, trusted: [{ name: "apply_patch", package: "npm:x" }] } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /cannot be a trusted tool/);
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

    it("passes the Write levels through and rejects Write for stored credentials", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, outsideProject: "write", projectFiles: "write" } });
        assert.deepEqual(resolveSubagentPermissions(pi, undefined).permissions, {
            projectFiles: "write", outsideProject: "write", storedCredentials: "read", commands: true, network: true,
        });
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, storedCredentials: "write" } });
        assert.throws(() => currentSandboxPermissions(pi), /Invalid sandbox permission profile/);
    });

    it("captures Process access per launch and rejects unsupported process levels", () => {
        const { pi, publish } = fixture();
        publish({ state: "enabled", permissions: main, subagentPermissions: { ...child, processAccess: "read" } });
        const readPlan = resolveSubagentPermissions(pi, undefined);
        assert.equal(readPlan.permissions.processAccess, "read");
        publish({ state: "enabled", permissions: main, subagentPermissions: { ...child, processAccess: "off" } });
        assert.equal(resolveSubagentPermissions(pi, undefined).permissions.processAccess, "off");
        assert.equal(readPlan.permissions.processAccess, "read", "a launched policy cannot change retroactively");
        publish({ state: "enabled", permissions: main, subagentPermissions: { ...child, processAccess: "write" } });
        assert.throws(() => resolveSubagentPermissions(pi, undefined), /Invalid sandbox permission profile/);
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

    it("retains task restrictions while allowing trusted Pi startup", () => {
        const { pi, publish } = fixture();
        publish({ state: "disabled", permissions: main, subagentPermissions: { ...child, commands: false, network: false } });
        const plan = resolveSubagentPermissions(pi, undefined);
        assert.equal(plan.sandboxEnabled, true);
        assert.equal(plan.enforced, true);
        assert.equal(plan.permissions.commands, false);
        assert.equal(plan.permissions.network, false);
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
