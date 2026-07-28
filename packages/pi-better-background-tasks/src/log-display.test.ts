import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { logPathFor, taskDir, writeMeta } from "./registry.js";
import { renderBackgroundTaskLogDisplay, registerTools } from "./tools.js";

const createdIds: string[] = [];

const TypeStub = {
  Object: (value: unknown) => value,
  String: (value?: unknown) => value ?? {},
  Number: (value?: unknown) => value ?? {},
  Boolean: (value?: unknown) => value ?? {},
  Array: (value: unknown) => value,
  Optional: (value: unknown) => value,
  Union: (value: unknown) => value,
  Literal: (value: unknown) => value,
  Record: (key: unknown, value: unknown) => ({ key, value }),
  Any: () => ({}),
};

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
};

function plain(lines: string[]): string {
  return lines.join("\n").replace(/<\/?[a-zA-Z][\w-]*>/g, "").replace(/<\/>/g, "");
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function makeCompletedTask(id: string, logLines: string[]): void {
  createdIds.push(id);
  mkdirSync(taskDir(id), { recursive: true });
  writeFileSync(logPathFor(id), `${logLines.join("\n")}\n`);
  writeMeta({
    id,
    name: "log display",
    kind: "process",
    status: "succeeded",
    startedAt: 1,
    endedAt: 2,
    logPath: logPathFor(id),
    cwd: "/tmp",
    shell: true,
    spawnPid: process.pid,
  });
}

afterEach(() => {
  for (const id of createdIds.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

describe("background task log folded display", () => {
  it("keeps full log content for the model while folding the default TUI rendering", async () => {
    const id = `bg_log_display_${Date.now()}`;
    makeCompletedTask(id, Array.from({ length: 18 }, (_, index) => `log-line-${String(index + 1).padStart(2, "0")}`));
    const tools: Record<string, any> = {};
    registerTools({
      on() {},
      registerTool(tool: any) { tools[tool.name] = tool; },
    } as any);

    const result = await tools.bg_task_log.execute("tc", { id });
    const full = textOf(result);
    expect(full).toContain("log-line-18");
    expect(result.details?.kind).toBe("background-task-log-display");

    const compact = plain(tools.bg_task_log.renderResult(result, { expanded: false }, theme).render(80));
    expect(compact).toContain("bg_task_log");
    expect(compact).toContain("Click or expand for the requested log payload");
    expect(compact).not.toContain("log-line-18");

    const expanded = plain(tools.bg_task_log.renderResult(result, { expanded: true }, theme).render(80));
    expect(expanded).toContain("log-line-18");
  });

  it("folds wrapper action log results too", async () => {
    const id = `bg_log_wrapper_${Date.now()}`;
    makeCompletedTask(id, Array.from({ length: 12 }, (_, index) => `wrapper-line-${index + 1}`));
    const tools: Record<string, any> = {};
    registerTools({
      on() {},
      registerTool(tool: any) { tools[tool.name] = tool; },
    } as any);
    const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } };

    const result = await tools.bg_task.execute("tc", { action: "log", id }, undefined, undefined, ctx);
    expect(textOf(result)).toContain("wrapper-line-12");
    expect(result.details?.kind).toBe("background-task-log-display");
    const compact = plain(tools.bg_task.renderResult(result, { expanded: false }, theme).render(80));
    expect(compact).not.toContain("wrapper-line-12");
  });

  it("defaults model-facing log reads to a bounded tail and keeps full log explicit", async () => {
    const id = `bg_log_default_tail_${Date.now()}`;
    makeCompletedTask(id, Array.from({ length: 25 }, (_, index) => `tail-line-${String(index + 1).padStart(2, "0")}`));
    const tools: Record<string, any> = {};
    registerTools({
      on() {},
      registerTool(tool: any) { tools[tool.name] = tool; },
    } as any);

    const defaultText = textOf(await tools.bg_task_log.execute("tc", { id }));
    expect(defaultText).toContain("[showing tail of");
    expect(defaultText).not.toContain("tail-line-01");
    expect(defaultText).toContain("tail-line-25");

    const fullText = textOf(await tools.bg_task_log.execute("tc", { id, tail_lines: 0 }));
    expect(fullText).toContain("tail-line-01");
    expect(fullText).toContain("tail-line-25");
  });

  it("keeps rendered lines within the requested width", () => {
    const result = {
      content: [{ type: "text", text: `[log]\n${"x".repeat(96)}-end` }],
      details: { kind: "background-task-log-display", head: "[log]", fullLineCount: 2, compactLines: [`${"x".repeat(96)}-end`], foldedLineCount: 0 },
    };
    const component = renderBackgroundTaskLogDisplay(result, { expanded: false }, theme);
    for (const line of component.render(32)) {
      expect(plain([line]).length).toBeLessThanOrEqual(32);
    }
  });
});
