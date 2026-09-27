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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { isolateHarnessEnv } from "./issue-312-payload-baseline/isolate.mjs";
import { MULTI_PAGE_ANSWER, REQUIRED_FAMILIES, SYNTHETIC_MARKER } from "./issue-312-payload-baseline/fixtures.mjs";

const env = isolateHarnessEnv();
after(() => env.restore());

const { BASELINE_DIR, collectBaseline, renderMarkdown, serializeReport } = await import("./issue-312-payload-baseline/run.mjs");
const repoRoot = resolve(import.meta.dirname, "..");

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

        const multi = report.cases.find((item) => item.id === "subagent.multi_page.result");
        assert.ok(multi, "multi-page answer case must be measured");
        assert.ok(multi.facts.pageCount >= 3, `answer must span at least 3 pages, got ${multi.facts.pageCount}`);
        assert.equal(multi.facts.answerUtf8Bytes, Buffer.byteLength(MULTI_PAGE_ANSWER, "utf8"));
        assert.equal(multi.facts.reconstructedExactly, true, "pages must concatenate to the seeded answer byte for byte");
        assert.equal(multi.facts.reconstructedUtf8Bytes, multi.facts.answerUtf8Bytes);
        assert.ok(
            multi.facts.pageUtf8Bytes.every((bytes) => bytes <= report.policyBudgetsBytes.subagent_result),
            `every page must fit the answer budget: ${multi.facts.pageUtf8Bytes}`,
        );
        assert.match(multi.content, /hasMore=true/);

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

describe("issue-312 payload baseline artifacts", () => {
    it("live under docs/tests/issue-312-payload-baseline, not the docs/ root", () => {
        assert.equal(BASELINE_DIR, "docs/tests/issue-312-payload-baseline");
        for (const name of ["before.json", "before.md", "after.json", "after.md"]) {
            assert.ok(existsSync(resolve(repoRoot, BASELINE_DIR, name)), `${BASELINE_DIR}/${name} missing`);
        }
        const strays = readdirSync(resolve(repoRoot, "docs")).filter((name) => /^issue-312-payload-baseline/.test(name));
        assert.deepEqual(strays, [], "generated baseline files must not return to the docs/ root");
    });

    it("the committed AFTER capture includes the multi-page answer case", () => {
        const after = JSON.parse(readFileSync(resolve(repoRoot, BASELINE_DIR, "after.json"), "utf8"));
        const multi = after.cases.find((item) => item.id === "subagent.multi_page.result");
        assert.ok(multi, "regenerate after.json with --phase after");
        assert.ok(multi.facts.pageCount >= 3);
        assert.equal(multi.facts.reconstructedExactly, true);
    });

    it("rerun instructions and docs point at the moved files", () => {
        const md = renderMarkdown({ phase: "after", cases: [], proposedBudgetsBytes: {}, limitations: [] });
        assert.match(md, /--json-out docs\/tests\/issue-312-payload-baseline\/after\.json/);
        for (const path of ["docs/issue-312-output.md", "scripts/issue-312-payload-baseline.mjs", `${BASELINE_DIR}/before.md`, `${BASELINE_DIR}/after.md`]) {
            const text = readFileSync(resolve(repoRoot, path), "utf8");
            assert.doesNotMatch(text, /docs\/issue-312-payload-baseline/, `${path} still names the old docs/ root location`);
        }
    });
});
