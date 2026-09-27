import assert from "node:assert/strict";
import test from "node:test";
import { defaultSandboxPermissions, describeLoosening, parseSandboxPermissions } from "../permissions.ts";

test("permission defaults preserve independent Main and Subagents columns", () => {
    const settings = defaultSandboxPermissions();
    assert.equal(settings.main.enabled, false);
    assert.equal(settings.subagents.enabled, true);
    // Subagents default to Outside project = Write; Main keeps Read.
    assert.deepEqual(settings.subagents, { ...settings.main, enabled: true, outsideProject: "write" });
    settings.main.outsideProject = "read-write";
    assert.equal(settings.subagents.outsideProject, "write");
    assert.equal(defaultSandboxPermissions().main.outsideProject, "read");
});

test("decoding accepts Write for file rows only and keeps saved Read / write as Write & delete", () => {
    const settings = defaultSandboxPermissions();
    settings.main.projectFiles = "write";
    settings.subagents.outsideProject = "read-write";
    assert.deepEqual(parseSandboxPermissions(settings), settings);
    assert.throws(() => parseSandboxPermissions({ ...settings, main: { ...settings.main, storedCredentials: "write" } }),
        /explicit permission values/);
});

test("describes only the changes that grant more", () => {
    const before = defaultSandboxPermissions();
    const after = defaultSandboxPermissions();
    after.subagents.outsideProject = "read-write";
    after.main.network = false;
    after.subagents.projectFiles = "write";
    assert.deepEqual(describeLoosening(before, after), ["Subagents: outsideProject write → read-write"]);
    const disabled = defaultSandboxPermissions();
    disabled.subagents.enabled = false;
    assert.deepEqual(describeLoosening(before, disabled), ["Subagents: sandbox off"]);
});

test("strict decoding rejects incomplete and invalid profiles", () => {
    for (const [value, message] of [
        [null, /Invalid sandbox permission settings/],
        [{}, /require Main and Subagents/],
        [{ main: defaultSandboxPermissions().main }, /require Main and Subagents/],
        [{ ...defaultSandboxPermissions(), subagents: { ...defaultSandboxPermissions().subagents, storedCredentials: "all" } },
            /explicit permission values/],
    ] as const) assert.throws(() => parseSandboxPermissions(value), message);
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
