// Exercise the launch-time import/allocator path concurrently; import spelling
// cannot prove that the registry is initialized when parallel launches arrive.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";

it("parallel direct-role preparations allocate independent durable labels", async () => {
    const root = mkdtempSync(join(tmpdir(), "catalog-import-race-"));
    try {
        const { loadLaunchSnapshot, prepareCatalogJob } = await import("../catalog-runtime.ts");
        const host = {
            cwd: root, userRoot: join(root, "agent"), registryDir: join(root, "registry"),
            projectTrusted: true, hasUI: false, foregroundModel: "test/model",
            registry: { getAvailable: () => [{ provider: "test", id: "model", reasoning: true }] },
        };
        mkdirSync(host.userRoot);
        const snapshot = loadLaunchSnapshot(host);
        const jobs = Array.from({ length: 8 }, (_, index) => ({
            role: "role.developer", prompt: `Build task ${index}`, model: "test/model", thinking: "low",
        }));
        const prepared = await Promise.all(jobs.map((job) => prepareCatalogJob(snapshot, job, host)));
        for (const [index, result] of prepared.entries()) {
            assert.equal(result.status, "ready", result.message);
            assert.match(result.assign.prompt, new RegExp(`Build task ${index}`));
            assert.match(result.assign.name, /^developer-\d+$/);
        }
        const names = prepared.map((result) => result.assign.name);
        assert.equal(new Set(names).size, jobs.length);
        const next = await prepareCatalogJob(snapshot, jobs[0], host);
        assert.equal(next.status, "ready", next.message);
        assert.equal(names.includes(next.assign.name), false, "later launch must honor reservations");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
