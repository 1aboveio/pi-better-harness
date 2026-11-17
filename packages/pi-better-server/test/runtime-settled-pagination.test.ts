import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";

// Controlled registered-handler witness from 804/1efd0cf8 and 8d53f9b4.
for (const missingLogs of [true, false]) test(`registered list paging ${missingLogs ? "rejects its stale cursor after missing-log observations" : "stays stable after complete source publication"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "settled-pages-"));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const base = join(root, "pi-better-subagents"), runs = join(base, "runs"), agent = join(root, "agent");
  mkdirSync(agent);
  for (let i = 0; i < 50; i++) {
    const id = `sa_shared_${i}`, directory = join(runs, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id, cwd: root, sessionId: `worker-${i}`,
      status: "completed", startedAt: i, endedAt: 100, callbackOrigin: { cwd: root, sessionId: "parent" } }));
    if (!missingLogs) writeFileSync(join(directory, "output.log"), JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
  }
  const log = join(runs, "sa_shared_0/output.log");
  writeFileSync(log, [
    { type: "tool_execution_start", toolCallId: "first", toolName: "bash", at: 1 },
    { type: "agent_end", messages: [] },
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const model = new WorkReadModel(agent, "settled-pages", { baseDir: base, durableDir: join(root, "durable"), intervalMs: 60000 });
  try {
    await model.reconcile();
    appendFileSync(log, JSON.stringify({ type: "tool_execution_start", toolCallId: "new-tool", toolName: "read", at: 2 }) + "\n");
    await model.reconcile();
    assert.equal((model.snapshot({ id: "sa_shared_0" }).rows[0] as any).display.tool, "read", "the exact new log row is already published before paging");
    const path = new URL("../../pi-better-subagents/tools.ts", import.meta.url).href;
    const { subagentListTool } = await import(path);
    const Type = Object.fromEntries(["Object", "String", "Number", "Boolean", "Array", "Optional"].map(key => [key, (value: unknown) => value]));
    const list = subagentListTool(Type, { observeList: async (scope: any) => model.snapshot(scope) });
    const params = { all: true, limit: 2, max_bytes: 4096, status: ["completed"] };
    const failures = join(runs, "sa_shared_49/failures.jsonl");
    assert.equal(existsSync(failures), false);
    const page = await list.execute("list", params);
    assert.equal(existsSync(failures), missingLogs, "the first page discovers missing terminal log evidence");
    const before = page.details.snapshot;
    const cursor = page.content[0].text.match(/nextCursor=(\S+)/)[1];
    await model.reconcile(); // Import the real files the first handler wrote.
    const after = model.snapshot({ statuses: ["completed"], limit: 2 });
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.rows[0]!.meta.id, "sa_shared_49");
    assert.equal(after.rows[0]!.assignment.revision, before.rows[0].assignment.revision);
    if (missingLogs) {
      assert.notEqual(after.rows[0]!.sourceRevision, before.rows[0].sourceRevision);
      await assert.rejects(list.execute("list-next", { ...params, cursor }), /resync_required: cursor snapshot changed/);
    } else {
      assert.equal(after.rows[0]!.sourceRevision, before.rows[0].sourceRevision);
      const next = await list.execute("list-next", { ...params, cursor });
      assert.equal(existsSync(failures), false);
      assert.notEqual(next.details.snapshot.rows[0].meta.id, before.rows[0].meta.id);
    }
  } finally {
    await model.close();
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
    rmSync(root, { recursive: true, force: true });
  }
});
