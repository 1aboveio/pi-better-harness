import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverTrustedTools, toolPackage } from "./tools.ts";

test("file-backed builtin provenance is display metadata, not a package identity", (t) => {
    const base = mkdtempSync(join(tmpdir(), "tool-provenance-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    writeFileSync(join(base, "package.json"), "{}");
    const builtin = { name: "bundled_tool", sourceInfo: { path: join(base, "index.ts"), source: "builtin", baseDir: base } };
    assert.deepEqual(toolPackage(builtin), { name: "bundled_tool", package: base, root: base });
    assert.deepEqual(discoverTrustedTools([builtin]), [{ name: "bundled_tool", package: base, root: base, source: "builtin" }]);

    const extensions = join(base, "extensions");
    mkdirSync(extensions);
    const file = join(extensions, "standalone.ts");
    const standalone = { name: "standalone", sourceInfo: { path: file, source: "builtin", baseDir: extensions } };
    assert.deepEqual(discoverTrustedTools([standalone]), [{ name: "standalone", package: file, root: file, source: "builtin" }],
        "a manifest-less extension still loads and admits only its own file");
});

test("dot package paths do not establish builtin provenance and synthetic sources stay excluded", () => {
    const path = join(process.cwd(), "extension.ts");
    assert.deepEqual(discoverTrustedTools([
        { name: "bundled_tool", sourceInfo: { path, source: "builtin", baseDir: "." } },
        { name: "local_tool", sourceInfo: { path, source: ".", baseDir: "." } },
        { name: "unknown_tool", sourceInfo: { path, baseDir: "." } },
        { name: "core_tool", sourceInfo: { path: "<builtin:core_tool>", source: "builtin", baseDir: "." } },
        { name: "inline_tool", sourceInfo: { path: "<inline>" } },
        { name: "no_source" },
    ]), [
        { name: "bundled_tool", package: ".", root: ".", source: "builtin" },
        { name: "local_tool", package: ".", root: "." },
        { name: "unknown_tool", package: ".", root: "." },
    ]);
});

test("only the supported SSH tools are offered from harness packages, including local installs", (t) => {
    const base = mkdtempSync(join(tmpdir(), "ssh-discovery-"));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const ssh = join(base, "pi-better-ssh");
    const harness = join(base, "pi-better-harness");
    for (const dir of [ssh, harness]) {
        mkdirSync(dir);
        writeFileSync(join(dir, "package.json"), "{}");
    }
    const tool = (name: string, root: string, source: string) => ({ name,
        sourceInfo: { path: join(root, "index.ts"), baseDir: root, source } });
    assert.deepEqual(discoverTrustedTools([
        tool("ssh_profile", ssh, ssh),
        tool("future_tool", ssh, "npm:pi-better-ssh"),
        tool("subagent_spawn", harness, "npm:pi-better-harness"),
        tool("remote_bash", harness, "npm:pi-better-ssh"),
        tool("ssh_mux", ssh, "npm:pi-better-harness"),
    ]), [{ name: "ssh_profile", package: ssh, root: ssh }]);
});
