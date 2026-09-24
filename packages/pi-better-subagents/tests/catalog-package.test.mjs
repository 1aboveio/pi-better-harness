import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "../..");

function selectPackedResult(packOutput) {
    const parsed = JSON.parse(packOutput);
    if (Array.isArray(parsed)) return parsed[0];
    if (parsed?.filename) return parsed;
    return Object.values(parsed).find((value) => value?.filename);
}

describe("catalog package", () => {
    it("publishes the YAML runtime dependency and bundled role files", () => {
        const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
        assert.equal(manifest.dependencies.yaml, "^2.9.1");
        assert.ok(manifest.files.includes("roles/**/*.md"));
        assert.ok(manifest.files.includes("docs/agent-catalog.md"));
        const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
            cwd: packageDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, npm_config_cache: "/tmp/npm-cache-289" },
        });
        const packed = selectPackedResult(stdout).files.map((file) => file.path);
        for (const role of [
            "roles/role.researcher.md",
            "roles/role.explorer.md",
            "roles/role.product-manager.md",
            "roles/role.developer.md",
            "roles/role.reviewer.md",
            "roles/role.architect.md",
        ]) {
            assert.ok(packed.includes(role), `pack is missing ${role}`);
        }
        for (const moduleName of ["catalog-schema.ts", "catalog-store.ts", "catalog-resolver.ts", "docs/agent-catalog.md"]) {
            assert.ok(packed.includes(moduleName), `pack is missing ${moduleName}`);
        }
        assert.equal(JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")).packages["packages/pi-better-subagents"].dependencies.yaml, "^2.9.1");
    });
});
