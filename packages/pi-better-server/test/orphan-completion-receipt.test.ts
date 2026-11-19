import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createCallbackBatcher } = await import(new URL("../../pi-better-subagents/shared-callback-batcher.ts", import.meta.url).href);
const { completionCallbackFields } = await import(new URL("../../pi-better-subagents/callback-fields.ts", import.meta.url).href);

test("coherent orphan cleanup retains its named completion across an older asynchronous batch", async t => {
  const root = mkdtempSync(join(tmpdir(), "orphan-named-receipt-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const { stopRun } = await import(new URL("../../pi-better-subagents/stop.ts", import.meta.url).href);
  const { readMeta, writeMeta, runDir, logPathFor } = await import(new URL("../../pi-better-subagents/registry.ts", import.meta.url).href);
  const { collectRunFailures } = await import(new URL("../../pi-better-subagents/failures.ts", import.meta.url).href);
  const id = "sa_coherent_orphan_receipt", recipient = { cwd: root, sessionId: "cleanup-session" };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: any[] = [];
  const receipts: { id: string; at: number }[] = [];
  const batcher = createCallbackBatcher({ sendMessage: async (message: any) => {
    if (!sent.length) await blocked;
    sent.push(message);
  } });
  try {
    mkdirSync(runDir(id), { recursive: true });
    writeMeta({ id, status: "orphaned", pid: 4194304, pgid: 4194304, spawnPid: 4194304,
      supervisionInterruptedAt: 119000, cwd: root, callbackOrigin: recipient, promptPreview: "orphan",
      startedAt: 1, orphanedAt: 60000, logPath: logPathFor(id), sessionId: id, callback: true });
    writeFileSync(logPathFor(id), [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_end", messages: [] },
    ].map(event => JSON.stringify(event)).join("\n") + "\n");
    batcher.enqueue({ source: "subagent", id: "earlier", label: "earlier", status: "completed", detailTool: "subagent_result" });
    const earlier = batcher.flush();
    // Only the external OS liveness boundary is replaced; orphan classification,
    // log parsing and the durable completion obligation execute normally.
    assert.deepEqual(stopRun(id, { probe: { groupAlive: () => false } as any, now: () => 120000 }),
      { action: "finalized", id, status: "completed" });
    const terminal = readMeta(id)!;
    assert.equal(terminal.completionCallbackPendingAt, 120000);
    assert.deepEqual(terminal.callbackOrigin, recipient);
    assert.equal(terminal.sessionId, id);
    assert.equal(terminal.assignment, undefined, "the original orphan is legacy, not an immutable assignment outcome");
    const fields = completionCallbackFields(terminal, collectRunFailures(id, root, true));
    assert.equal(fields.id, id);
    assert.equal(batcher.enqueue({ ...fields, onDelivered: (at: number) => receipts.push({ id, at }) }), true);
    const otherFlush = batcher.flush();
    release();
    assert.equal(await earlier, true);
    assert.equal(await otherFlush, true);
    assert.equal(receipts.length, 0, "successful older flush is not the named completion receipt");
    assert.equal(sent.some(message => message.content.includes(`id=${id} `)), false);
    assert.equal(batcher.pendingCount(), 1, "the named obligation remains queued, not dropped");
    assert.equal(await batcher.flush(), true);
    assert.equal(sent.filter(message => message.content.includes(`id=${id} `)).length, 1);
    assert.equal(receipts.length, 1);
    const receipt = receipts[0];
    assert.ok(receipt);
    assert.equal(receipt.id, id);
    assert.ok(receipt.at > 0);
    await batcher.flush();
    assert.equal(receipts.length, 1, "the batcher acknowledges that named event exactly once");
    assert.equal(readMeta(id)?.completionCallbackSentAt, undefined, "a component callback is not the native recipient's durable receipt");
    assert.equal(readMeta(id)?.completionCallbackPendingAt, terminal.completionCallbackPendingAt);
    assert.equal(stopRun(id).action, "not-running", "terminal cleanup is not rewritten");
    t.diagnostic(JSON.stringify({ id, recipient, workerConversation: id, status: terminal.status,
      pendingAt: terminal.completionCallbackPendingAt, olderFlushNamedReceipts: 0,
      finalNamedBatchRows: 1, batcherReceiptCount: receipts.length, nativeDurableReceipt: "not exercised" }));
  } finally {
    release(); batcher.cancel();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
