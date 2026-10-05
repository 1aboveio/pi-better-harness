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
