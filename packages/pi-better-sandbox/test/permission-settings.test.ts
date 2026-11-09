import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSandboxPermissions } from "../permissions.ts";
import { sandboxPreferencesPath, writeSandboxDefault } from "../preferences.ts";
import { denyRuleOverridePath, readDenyRuleOverride, writeDenyRuleOverride, clearDenyRuleOverride } from "../deny-rules.ts";
import { permissionSettingsPath, readPermissionSettings, writePermissionSettings } from "../permission-settings.ts";

test("permission storage migrates activation and round-trips inactive values", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-permission-settings-"));
    const seams = { agentDir: () => root };
    try {
        const fresh = readPermissionSettings(seams);
        assert.deepEqual([fresh.main.enabled, fresh.subagents.enabled, fresh.background.enabled], [false, false, false]);
        assert.deepEqual(fresh, defaultSandboxPermissions());
        writeSandboxDefault("on", seams);
        assert.equal(readPermissionSettings(seams).main.enabled, true);
        assert.equal(readPermissionSettings(seams).background.enabled, true);
        const settings = defaultSandboxPermissions();
        settings.main.outsideProject = "off";
        settings.subagents.network = false;
        writePermissionSettings(settings, seams);
        assert.deepEqual(readPermissionSettings(seams), settings);
        const stored = JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8"));
        assert.equal(permissionSettingsPath(seams), join(root, "settings.json"));
        assert.equal(stored.piBetterHarness.sandboxPermissions.version, 1);
        assert.deepEqual(stored.piBetterHarness.sandbox, { version: 1, default: "on" });
        writeFileSync(permissionSettingsPath(seams), '{"piBetterHarness":{"sandboxPermissions":{"version":1,"permissions":{}}}}');
        assert.throws(() => readPermissionSettings(seams), /require Main and Subagents/);
        writeFileSync(permissionSettingsPath(seams), '{"piBetterHarness":{"sandboxPermissions":{"version":2}}}');
        assert.throws(() => readPermissionSettings(seams), /Unsupported/);
        writeFileSync(permissionSettingsPath(seams), '{"piBetterHarness":{"sandboxPermissions":null}}');
        assert.throws(() => readPermissionSettings(seams), /Unsupported/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("v1 settings add shell and command timeout without changing the storage envelope", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-command-settings-"));
    const seams = { agentDir: () => root };
    try {
        const settings = defaultSandboxPermissions();
        settings.main.enabled = true;
        settings.main.shell = false;
        settings.main.commandTimeoutSeconds = 600;
        settings.background.commandTimeoutSeconds = 1800;
        writePermissionSettings(settings, seams);
        assert.deepEqual(readPermissionSettings(seams), settings);
        const stored = JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8"));
        assert.equal(stored.piBetterHarness.sandboxPermissions.version, 1);
        assert.equal(stored.piBetterHarness.sandboxPermissions.permissions.main.shell, false);
        assert.equal(stored.piBetterHarness.sandboxPermissions.permissions.main.commandTimeoutSeconds, 600);
        assert.equal(stored.piBetterHarness.sandboxPermissions.permissions.background.commandTimeoutSeconds, 1800);

        // A file written before Shell scripts and Command time limit existed.
        const legacy = defaultSandboxPermissions();
        const strip = ({ shell: _shell, commandTimeoutSeconds: _timeout, ...profile }: typeof legacy.main) => profile;
        writeFileSync(permissionSettingsPath(seams), JSON.stringify({ piBetterHarness: { sandboxPermissions: {
            version: 1, permissions: { ...legacy, main: strip(legacy.main), subagents: strip(legacy.subagents),
                background: strip(legacy.background) },
        } } }));
        const migrated = readPermissionSettings(seams);
        assert.equal(migrated.main.shell, true);
        assert.equal(migrated.main.commandTimeoutSeconds, null);
        assert.equal(migrated.background.shell, true);
        assert.equal(migrated.background.commandTimeoutSeconds, null);
        writePermissionSettings(migrated, seams);
        const normalized = JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8"));
        assert.equal(normalized.piBetterHarness.sandboxPermissions.version, 1);
        assert.equal(normalized.piBetterHarness.sandboxPermissions.permissions.main.shell, true);
        assert.equal(normalized.piBetterHarness.sandboxPermissions.permissions.main.commandTimeoutSeconds, null);

        for (const main of [
            { ...legacy.main, shell: "yes" },
            { ...legacy.main, commandTimeoutSeconds: 0 },
            { ...legacy.main, commandTimeoutSeconds: 2147484 },
            { ...legacy.main, commandTimeoutSeconds: "60" },
        ]) {
            writeFileSync(permissionSettingsPath(seams), JSON.stringify({ piBetterHarness: { sandboxPermissions: {
                version: 1, permissions: { ...legacy, main },
            } } }));
            assert.throws(() => readPermissionSettings(seams), /explicit permission values/);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("old global and legacy files migrate Background from Main and save it independently", () => {
    for (const location of ["global", "legacy"] as const) {
        const root = mkdtempSync(join(tmpdir(), "sandbox-background-migration-"));
        const seams = { agentDir: () => root };
        try {
            const settings = defaultSandboxPermissions();
            Object.assign(settings.main, { enabled: true, projectFiles: "read", outsideProject: "off",
                storedCredentials: "off", commands: false, network: false, processAccess: "off" });
            Object.assign(settings.subagents, { enabled: true, outsideProject: "off", storedCredentials: "off" });
            const { background: _background, ...permissions } = settings;
            const old = { version: 1, permissions };
            mkdirSync(join(root, "extensions"));
            const source = location === "global" ? permissionSettingsPath(seams)
                : join(root, "extensions", "pi-better-sandbox-permissions.json");
            const original = JSON.stringify(location === "global" ? { piBetterHarness: { sandboxPermissions: old } } : old);
            writeFileSync(source, original);
            const migrated = readPermissionSettings(seams);
            assert.deepEqual(migrated.background, settings.main);
            assert.deepEqual(migrated.subagents, settings.subagents);
            assert.equal(readFileSync(source, "utf8"), original, "reading leaves the original profile untouched");
            migrated.main.enabled = false;
            migrated.main.network = true;
            migrated.background.projectFiles = "off";
            writePermissionSettings(migrated, seams);
            const restored = readPermissionSettings(seams);
            assert.deepEqual(restored, migrated);
            assert.equal(restored.background.enabled, true);
            assert.equal(restored.background.network, false);
            assert.equal(restored.background.projectFiles, "off");
            if (location === "legacy") assert.equal(readFileSync(source, "utf8"), original);
            const stored = JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8"));
            stored.piBetterHarness.sandboxPermissions.permissions.background = null;
            writeFileSync(permissionSettingsPath(seams), JSON.stringify(stored));
            assert.throws(() => readPermissionSettings(seams), /Background tasks profile/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});

test("all sandbox stores share global settings and updates or reset preserve sibling keys", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-shared-settings-"));
    const seams = { agentDir: () => root };
    try {
        const path = join(root, "settings.json");
        assert.equal(sandboxPreferencesPath(seams), path);
        assert.equal(permissionSettingsPath(seams), path);
        assert.equal(denyRuleOverridePath(seams), path);
        const unrelated = { theme: "light", defaultModel: "test-model", piBetterHarness: { goal: { enabled: true } } };
        writeFileSync(path, JSON.stringify(unrelated));
        const permissions = defaultSandboxPermissions();
        permissions.main.network = false;
        writePermissionSettings(permissions, seams);
        writeDenyRuleOverride(["secrets"], seams);
        writeSandboxDefault("on", seams);
        assert.deepEqual(readPermissionSettings(seams), permissions);
        assert.deepEqual(readDenyRuleOverride(seams), ["secrets"]);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
            ...unrelated, piBetterHarness: {
                ...unrelated.piBetterHarness,
                sandboxPermissions: { version: 1, permissions },
                sandboxDenyRules: { version: 1, denyWrite: ["secrets"] },
                sandbox: { version: 1, default: "on" },
            },
        });
        assert.equal(clearDenyRuleOverride(seams), true);
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
            ...unrelated, piBetterHarness: {
                ...unrelated.piBetterHarness,
                sandboxPermissions: { version: 1, permissions },
                sandboxDenyRules: null,
                sandbox: { version: 1, default: "on" },
            },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("subagent tools persist with the permissions; older files get the default tool set", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-permission-tools-"));
    const seams = { agentDir: () => root };
    try {
        const settings = defaultSandboxPermissions();
        assert.deepEqual(settings.subagentTools, {
            applyPatch: true,
            trusted: [{ name: "web_fetch", package: "npm:@juicesharp/rpiv-web-tools" }, { name: "web_search", package: "npm:@juicesharp/rpiv-web-tools" }],
        });
        settings.subagentTools = { applyPatch: false, trusted: [{ name: "ask_user_question", package: "npm:@juicesharp/rpiv-ask-user-question" }] };
        writePermissionSettings(settings, seams);
        assert.deepEqual(JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8")).piBetterHarness.sandboxPermissions.permissions.subagentTools, settings.subagentTools);
        assert.deepEqual(readPermissionSettings(seams), settings);
        // A file written before the Tools section existed.
        const legacy = defaultSandboxPermissions();
        writeFileSync(permissionSettingsPath(seams), JSON.stringify({ piBetterHarness: { sandboxPermissions: { version: 1, permissions: { main: legacy.main, subagents: legacy.subagents } } } }));
        assert.deepEqual(readPermissionSettings(seams).subagentTools, defaultSandboxPermissions().subagentTools);
        writeFileSync(permissionSettingsPath(seams), JSON.stringify({ piBetterHarness: { sandboxPermissions: { version: 1, permissions: { ...legacy, subagentTools: { applyPatch: "yes", trusted: [] } } } } }));
        assert.throws(() => readPermissionSettings(seams), /Invalid subagent tool settings/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("legacy permissions migrate without altering either legacy data or unrelated global settings", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-permission-migration-"));
    const seams = { agentDir: () => root };
    try {
        const legacyPath = join(root, "extensions", "pi-better-sandbox-permissions.json");
        mkdirSync(join(root, "extensions"));
        const permissions = defaultSandboxPermissions();
        permissions.main.network = false;
        permissions.subagents.enabled = true;
        const legacy = JSON.stringify({ version: 1, permissions });
        writeFileSync(legacyPath, legacy);
        const other = { theme: "light", piBetterHarness: { sandbox: { version: 1, default: "on" }, goal: { enabled: true } } };
        writeFileSync(permissionSettingsPath(seams), JSON.stringify(other));
        assert.deepEqual(readPermissionSettings(seams), permissions, "the profile wins over activation fallback");
        assert.equal(readFileSync(legacyPath, "utf8"), legacy);
        permissions.subagents.enabled = false;
        writePermissionSettings(permissions, seams);
        writeFileSync(legacyPath, "{ broken legacy");
        assert.deepEqual(readPermissionSettings(seams), permissions);
        assert.deepEqual(JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8")), {
            ...other, piBetterHarness: { ...other.piBetterHarness, sandboxPermissions: { version: 1, permissions } },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("invalid legacy permissions are not migrated or overwritten", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-permission-invalid-legacy-"));
    const seams = { agentDir: () => root };
    try {
        const legacyPath = join(root, "extensions", "pi-better-sandbox-permissions.json");
        mkdirSync(join(root, "extensions"));
        writeFileSync(legacyPath, '{"version":1,"permissions":{}}');
        const original = '{"theme":"keep-me"}';
        writeFileSync(permissionSettingsPath(seams), original);
        assert.throws(() => readPermissionSettings(seams), /require Main and Subagents/);
        assert.equal(readFileSync(permissionSettingsPath(seams), "utf8"), original);
        assert.equal(readFileSync(legacyPath, "utf8"), '{"version":1,"permissions":{}}');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("legacy activation feeds Main and Background tasks only when no permission profile exists", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-legacy-activation-"));
    const seams = { agentDir: () => root };
    try {
        mkdirSync(join(root, "extensions"));
        const legacyPath = join(root, "extensions", "pi-better-sandbox-preferences.json");
        const legacy = '{"version":1,"default":"on"}';
        writeFileSync(legacyPath, legacy);
        const permissions = readPermissionSettings(seams);
        const expected = defaultSandboxPermissions();
        expected.main.enabled = true;
        expected.background.enabled = true;
        assert.deepEqual(permissions, expected);
        assert.deepEqual(JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8")), {
            piBetterHarness: { sandbox: { version: 1, default: "on" } },
        }, "reading activation must not materialize a permission profile");
        assert.equal(readFileSync(legacyPath, "utf8"), legacy);
        writePermissionSettings(defaultSandboxPermissions(), seams);
        assert.equal(readPermissionSettings(seams).main.enabled, false, "saved profiles remain authoritative");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
