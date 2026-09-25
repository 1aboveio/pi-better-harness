/**
 * The parallel tool-call race imported catalog-identity dynamically while Pi
 * was still evaluating it, so allocateCatalogLabel saw an uninitialized
 * registry binding and threw reading baseDir. The launch path must keep a
 * static import and still allocate under concurrent callers.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateCatalogLabel } from "../catalog-identity.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(here, "../catalog-runtime.ts");

describe("catalog identity import", () => {
    it("keeps allocateCatalogLabel statically bound in the launch runtime", () => {
        const source = readFileSync(runtimePath, "utf8");
        const start = source.indexOf("async function allocateDirectRoleLabel");
        const end = source.indexOf("export function roleSlug");
        assert.ok(start >= 0 && end > start, "allocateDirectRoleLabel must stay in catalog-runtime.ts");
        const body = source.slice(start, end);
        assert.match(source, /import\s+\{\s*allocateCatalogLabel\s*\}\s+from\s+"\.\/catalog-identity\.ts"/);
        assert.doesNotMatch(body, /import\s*\(/);
        assert.match(body, /allocateCatalogLabel\(/);
    });

    it("allocates distinct labels from the statically imported allocator", () => {
        const registryDir = mkdtempSync(join(tmpdir(), "catalog-identity-static-"));
        try {
            const labels = Array.from({ length: 8 }, () => allocateCatalogLabel({
                roleId: "role.developer",
                roleName: "Developer",
                registryDir,
            }));
            assert.equal(new Set(labels).size, labels.length);
            for (const label of labels) assert.match(label, /^developer-\d+$/);
        } finally {
            rmSync(registryDir, { recursive: true, force: true });
        }
    });
});
