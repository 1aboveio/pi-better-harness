/**
 * TUI display folding for subagent_result.
 *
 * The model-facing tool payload stays complete in `content`; only the
 * interactive renderResult surface folds by default and expands on demand.
 *
 * // @covers subagent.result-display
 * // @level unit
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeMeta, runDir, logPathFor } from "../registry.ts";
import { buildSubagentResultText } from "../finalization.ts";
import { subagentResultTool } from "../tools.ts";

const THIS_PID = process.pid;
const diskIds = [];
function trackDisk(id) {
    diskIds.push(id);
    return id;
}

after(() => {
    for (const id of diskIds) {
        try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

const theme = {
    fg: (color, text) => `<${color}>${text}</>`,
};

function textOf(result) {
    return result.content.map((c) => c.text ?? "").join("\n");
}

function plain(lines) {
    return lines.join("\n").replace(/<\/?[a-zA-Z][\w-]*>/g, "").replace(/<\/>/g, "");
}

function writeTerminalRunWithLongResult(id, status = "completed", finalText = undefined) {
    writeMeta({
        id,
        name: "reviewer",
        status,
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "display fold",
        startedAt: 1,
        endedAt: 2,
        exitCode: 0,
        logPath: logPathFor(id),
        sessionId: id,
    });
    mkdirSync(runDir(id), { recursive: true });
    const resultText = finalText ?? Array.from({ length: 18 }, (_, i) => `result-line-${String(i + 1).padStart(2, "0")}`).join("\n");
    writeFileSync(logPathFor(id), [
        JSON.stringify({
            type: "message_end",
            message: {
                role: "assistant",
                content: [{ type: "text", text: resultText }],
                usage: { input: 10, output: 20, total: 30, cost: { total: 0.01 } },
            },
        }),
        JSON.stringify({ type: "agent_end" }),
    ].join("\n") + "\n");
}

describe("subagent_result folded TUI display", () => {
    // @covers subagent.result-display
    // @level unit
    it("keeps full content for the model while folding the default TUI rendering", async () => {
        const id = trackDisk(`sa_result_display_${Date.now()}`);
        writeTerminalRunWithLongResult(id);
        const tool = subagentResultTool(TypeStub);

        const result = await tool.execute("tc", { id });
        const full = textOf(result);
        assert.equal(full, buildSubagentResultText(id), "model-facing content must equal the bounded result formatter output");
        assert.match(full, /result-line-18/, "model-facing content must keep the full bounded result");
        assert.equal(result.details?.kind, "subagent-result-display");

        const compactComponent = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
        const compact = plain(compactComponent.render(80));
        assert.match(compact, /subagent_result/);
        assert.match(compact, /Click or expand for full result/);
        assert.doesNotMatch(compact, /result-line-18/, "compact display must not dump the full result");

        const defaultComponent = tool.renderResult(result, undefined, theme, {});
        const defaultRendered = plain(defaultComponent.render(80));
        assert.doesNotMatch(defaultRendered, /result-line-18/, "omitted render options must stay compact by default");

        const expandedComponent = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {});
        const expanded = plain(expandedComponent.render(80));
        assert.match(expanded, /result-line-18/, "expanded display must show the full result content");
    });

    // @covers subagent.result-display
    // @level unit
    it("keeps rendered lines within the requested width", async () => {
        const id = trackDisk(`sa_result_display_width_${Date.now()}`);
        writeTerminalRunWithLongResult(id);
        const tool = subagentResultTool(TypeStub);
        const result = await tool.execute("tc", { id });

        for (const width of [24, 40, 80]) {
            const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
            for (const line of component.render(width)) {
                const visible = line.replace(/<\/?[a-zA-Z][\w-]*>/g, "").replace(/<\/>/g, "");
                assert.ok(visible.length <= width, `line exceeds ${width}: ${JSON.stringify(visible)}`);
            }
        }
    });

    // @covers subagent.result-display
    // @level unit
    it("wraps expanded long lines without dropping result text", async () => {
        const id = trackDisk(`sa_result_display_long_line_${Date.now()}`);
        const longLine = `long-line-${"x".repeat(96)}-end`;
        writeTerminalRunWithLongResult(id, "completed", longLine);
        const tool = subagentResultTool(TypeStub);
        const result = await tool.execute("tc", { id });

        const expandedComponent = tool.renderResult(result, { expanded: true, isPartial: false }, theme, {});
        const renderedLines = expandedComponent.render(32);
        for (const line of renderedLines) {
            const visible = line.replace(/<\/?[a-zA-Z][\w-]*>/g, "").replace(/<\/>/g, "");
            assert.ok(visible.length <= 32, `line exceeds width: ${JSON.stringify(visible)}`);
        }
        assert.ok(plain(renderedLines).replace(/\n/g, "").includes(longLine));
    });

    // @covers subagent.result-display
    // @level unit
    it("uses documented TUI theme colors for terminal failure statuses", async () => {
        const id = trackDisk(`sa_result_display_failed_${Date.now()}`);
        writeTerminalRunWithLongResult(id, "failed");
        const tool = subagentResultTool(TypeStub);
        const result = await tool.execute("tc", { id });

        const compactComponent = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
        const compact = compactComponent.render(80).join("\n");
        assert.match(compact, /<error>failed<\/>/);
    });

    // @covers subagent.result-display
    // @level unit
    it("is wired through the registered extension tool definition", () => {
        const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
        const toolsSource = readFileSync(new URL("../tools.ts", import.meta.url), "utf8");

        assert.match(indexSource, /pi\.registerTool\(subagentResultTool\(Type\)\)/);
        assert.match(toolsSource, /renderResult\(result: unknown, options: unknown, theme: unknown\)/);
        assert.match(toolsSource, /renderSubagentResultDisplay\(result, options, theme\)/);
    });
});
