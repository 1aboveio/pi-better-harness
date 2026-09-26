import assert from "node:assert/strict";
import test from "node:test";
import { defaultSandboxPermissions, parseSandboxPermissions } from "../permissions.ts";

test("permission defaults preserve independent Main and Subagents columns", () => {
    const settings = defaultSandboxPermissions();
    assert.equal(settings.main.enabled, false);
    assert.equal(settings.subagents.enabled, true);
    assert.deepEqual(settings.subagents, { ...settings.main, enabled: true });
    settings.main.outsideProject = "read-write";
    assert.equal(settings.subagents.outsideProject, "read");
    assert.equal(defaultSandboxPermissions().main.outsideProject, "read");
});

test("strict decoding rejects incomplete and invalid profiles", () => {
    for (const value of [null, {}, { main: defaultSandboxPermissions().main }, {
        ...defaultSandboxPermissions(), subagents: { ...defaultSandboxPermissions().subagents, storedCredentials: "all" },
    }]) assert.throws(() => parseSandboxPermissions(value));
});

test("decoding copies policy and preserves inactive values", () => {
    const settings = defaultSandboxPermissions();
    settings.main.network = false;
    const decoded = parseSandboxPermissions(settings);
    assert.equal(decoded.main.enabled, false);
    assert.equal(decoded.main.network, false);
    settings.main.network = true;
    assert.equal(decoded.main.network, false);
});
