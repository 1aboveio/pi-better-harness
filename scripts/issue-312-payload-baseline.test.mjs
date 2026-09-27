/**
 * Harness mechanics for issue #312 AC13.
 *
 * This is not a product regression pin. It does not freeze current payload
 * sizes, tool-history text, or proposed-budget overruns as correct.
 *
 * // @covers issue-312.payload-baseline
 * // @level unit
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, describe, it } from "node:test";
import { isolateHarnessEnv } from "./issue-312-payload-baseline/isolate.mjs";
import { REQUIRED_FAMILIES, SYNTHETIC_MARKER } from "./issue-312-payload-baseline/fixtures.mjs";

const env = isolateHarnessEnv();
after(() => env.restore());

const { collectBaseline, serializeReport } = await import("./issue-312-payload-baseline/run.mjs");

describe("issue-312 payload baseline harness", () => {
    it("measures registered-tool UTF-8 content for every required family", async () => {
        const report = await collectBaseline({ phase: "before" });
        const families = new Set(report.cases.map((item) => item.family));
        for (const family of REQUIRED_FAMILIES) {
            assert.ok(families.has(family), `missing family ${family}`);
        }

        for (const name of ["bg_task_status", "bg_status", "bg_task", "bg_task_log", "bg_task_list"]) {
            assert.ok(report.registeredTools.background.includes(name), `missing registered tool ${name}`);
        }
        for (const name of ["subagent_list", "subagent_output", "subagent_result"]) {
            assert.ok(report.registeredTools.subagent.includes(name), `missing registered tool ${name}`);
        }

        for (const item of report.cases) {
            assert.equal(
                item.utf8Bytes,
                Buffer.byteLength(item.content, "utf8"),
                `${item.id} utf8Bytes must be Buffer.byteLength of the measured content`,
            );
            assert.equal(
                item.sha256,
                createHash("sha256").update(item.content, "utf8").digest("hex"),
                `${item.id} sha256 must be of the measured UTF-8 content`,
            );
            assert.ok(item.utf8Bytes > 0, `${item.id} produced empty model-facing content`);
            assert.equal(item.facts.utf16CodeUnits, item.content.length);
            assert.match(item.invokePath, /packages\/|callback-batcher/);
        }

        const unicode = report.cases.filter((item) => item.family === "unicode-long-line-json");
        assert.ok(unicode.length >= 2);
        assert.ok(
            unicode.some((item) => item.facts.utf8GreaterThanUtf16 && item.facts.containsNonAscii),
            "Unicode JSON case must show UTF-8 bytes > UTF-16 units",
        );
        const success = report.cases.find((item) => item.id === "subagent.success.result");
        assert.ok(success.content.includes(`${SYNTHETIC_MARKER} review complete.`));
        assert.equal(
            success.facts.utf8BytesExcludingIsolatedTmpdir,
            Buffer.byteLength(success.content.split(process.env.TMPDIR).join("$TMPDIR"), "utf8"),
        );

        const serialized = serializeReport(report, {
            git: { branch: "test", sha: "0".repeat(40), dirty: false },
            measuredAt: "1970-01-01T00:00:00.000Z",
            model: { id: "test/none", effort: "none" },
        });
        assert.equal(
            JSON.stringify(serialized).includes("AKIA"),
            false,
            "serialized report must not contain credential-like markers",
        );
        assert.ok(serialized.cases.every((item) => item.content === undefined));
        assert.ok(serialized.cases.every((item) => item.excerpt.includes("…") || item.excerpt.length <= 240));
    });
});
