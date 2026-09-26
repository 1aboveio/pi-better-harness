import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultSandboxPermissions } from "../permissions.ts";
import { writeSandboxDefault } from "../preferences.ts";
import { permissionSettingsPath, readPermissionSettings, writePermissionSettings } from "../permission-settings.ts";

test("permission storage migrates activation and round-trips inactive values", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-permission-settings-"));
    const seams = { agentDir: () => root };
    try {
        assert.deepEqual(readPermissionSettings(seams), defaultSandboxPermissions());
        writeSandboxDefault("on", seams);
        assert.equal(readPermissionSettings(seams).main.enabled, true);
        const settings = defaultSandboxPermissions();
        settings.main.outsideProject = "off";
        settings.subagents.network = false;
        writePermissionSettings(settings, seams);
        assert.deepEqual(readPermissionSettings(seams), settings);
        assert.equal(JSON.parse(readFileSync(permissionSettingsPath(seams), "utf8")).version, 1);
        writeFileSync(permissionSettingsPath(seams), '{"version":1,"permissions":{}}');
        assert.throws(() => readPermissionSettings(seams), /require Main and Subagents/);
        writeFileSync(permissionSettingsPath(seams), '{"version":2}');
        assert.throws(() => readPermissionSettings(seams), /Unsupported/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
