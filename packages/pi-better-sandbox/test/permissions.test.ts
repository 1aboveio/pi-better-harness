import assert from "node:assert/strict";
import test from "node:test";
import { defaultSandboxPermissions, describeLoosening, parseSandboxPermissions } from "../permissions.ts";

test("fresh permission defaults start all sandbox switches Off with independent profiles", () => {
    const settings = defaultSandboxPermissions();
    assert.equal(settings.main.enabled, false);
    assert.equal(settings.subagents.enabled, false);
    assert.equal(settings.background.enabled, false);
    assert.deepEqual(settings.background, settings.main);
    settings.background.enabled = true;
    settings.background.outsideProject = "off";
    assert.equal(settings.main.enabled, false);
    assert.equal(settings.main.outsideProject, "read");
    assert.equal(settings.subagents.enabled, false);
    assert.deepEqual(settings.subagents, { ...settings.main, outsideProject: "write", storedCredentials: "read-write" });
    assert.equal(settings.main.processAccess, "read");
    assert.equal(settings.subagents.processAccess, "read");
    settings.main.processAccess = "off";
    assert.equal(settings.subagents.processAccess, "read");
    assert.equal(settings.main.storedCredentials, "read");
    settings.main.storedCredentials = "off";
    assert.equal(settings.subagents.storedCredentials, "read-write");
    settings.main.outsideProject = "read-write";
    assert.equal(settings.subagents.outsideProject, "write");
    assert.equal(defaultSandboxPermissions().main.outsideProject, "read");
});

test("decoding preserves explicitly saved credential restrictions instead of applying new defaults", () => {
    for (const storedCredentials of ["off", "read", "read-write"] as const) {
        const settings = defaultSandboxPermissions();
        settings.subagents.storedCredentials = storedCredentials;
        const decoded = parseSandboxPermissions(settings);
        assert.equal(decoded.subagents.storedCredentials, storedCredentials);
        assert.equal(decoded.main.storedCredentials, "read");
    }
});

test("decoding accepts Write for file rows only and keeps saved read-write as Write & delete", () => {
    const settings = defaultSandboxPermissions();
    settings.main.projectFiles = "write";
    settings.subagents.outsideProject = "read-write";
    assert.deepEqual(parseSandboxPermissions(settings), settings);
    assert.throws(() => parseSandboxPermissions({ ...settings, main: { ...settings.main, storedCredentials: "write" } }),
        /explicit permission values/);
});

test("legacy profiles keep Process access Off and malformed values fail closed", () => {
    const settings = defaultSandboxPermissions();
    const { processAccess: _main, ...main } = settings.main;
    const { processAccess: _child, ...subagents } = settings.subagents;
    const decoded = parseSandboxPermissions({ ...settings, main, subagents });
    assert.equal(decoded.main.processAccess, "off");
    assert.equal(decoded.subagents.processAccess, "off");
    assert.throws(() => parseSandboxPermissions({ ...settings, subagents: { ...settings.subagents, processAccess: "write" } }), /explicit permission values/);
    settings.main.processAccess = "off";
    settings.subagents.processAccess = "off";
    assert.equal(parseSandboxPermissions(settings).main.processAccess, "off");
    assert.equal(parseSandboxPermissions(settings).subagents.processAccess, "off");
    settings.subagents.processAccess = "read";
    assert.equal(parseSandboxPermissions(settings).subagents.processAccess, "read");
    assert.deepEqual(describeLoosening(decoded, settings), ["Subagents: processAccess off → read"]);
});

test("describes only the changes that grant more", () => {
    const before = defaultSandboxPermissions();
    before.subagents.enabled = true;
    const after = structuredClone(before);
    after.subagents.outsideProject = "read-write";
    after.main.network = false;
    after.subagents.projectFiles = "write";
    assert.deepEqual(describeLoosening(before, after), ["Subagents: outsideProject write → read-write"]);
    const disabled = structuredClone(before);
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

test("missing Background profiles inherit every Main value once, while malformed profiles are rejected", () => {
    const settings = defaultSandboxPermissions();
    const main = { ...settings.main, enabled: true, projectFiles: "write" as const,
        outsideProject: "off" as const, storedCredentials: "off" as const,
        network: false, commands: false, processAccess: "off" as const };
    const { background: _background, ...legacy } = { ...settings, main };
    const migrated = parseSandboxPermissions(legacy);
    assert.deepEqual(migrated.background, main);
    migrated.main.enabled = false;
    migrated.main.network = true;
    assert.equal(migrated.background.enabled, true);
    assert.equal(migrated.background.network, false);
    assert.deepEqual(parseSandboxPermissions(migrated).background, main);
    for (const background of [null, {}, { ...main, network: "on" }, { ...main, storedCredentials: "write" }]) {
        assert.throws(() => parseSandboxPermissions({ ...legacy, background }), /Background tasks profile/);
    }
});

test("Background loosening names only Background tasks capabilities", () => {
    const before = defaultSandboxPermissions();
    Object.assign(before.background, { enabled: true, commands: false, network: false, processAccess: "off" });
    const next = structuredClone(before);
    Object.assign(next.background, { enabled: false, commands: true, network: true,
        outsideProject: "write", storedCredentials: "read-write", processAccess: "read" });
    assert.deepEqual(describeLoosening(before, next), [
        "Background tasks: sandbox off", "Background tasks: outsideProject read → write",
        "Background tasks: storedCredentials read → read-write", "Background tasks: commands on",
        "Background tasks: network on", "Background tasks: processAccess off → read",
    ]);
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
