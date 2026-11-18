import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { createCallbackBatcher } = await import(new URL("../../pi-better-subagents/shared-callback-batcher.ts", import.meta.url).href);
const { completionCallbackFields } = await import(new URL("../../pi-better-subagents/callback-fields.ts", import.meta.url).href);

test("an older asynchronous batch cannot acknowledge later superseding child-exit evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "terminal-callback-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const { finalizeRun } = await import(new URL("../../pi-better-subagents/finalization.ts", import.meta.url).href);
  const { readMeta, writeMeta, runDir, logPathFor, onMetaChanged } = await import(new URL("../../pi-better-subagents/registry.ts", import.meta.url).href);
  const { collectRunFailures } = await import(new URL("../../pi-better-subagents/failures.ts", import.meta.url).href);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: any[] = [];
  const batcher = createCallbackBatcher({ sendMessage: async (message: any) => {
    if (!sent.length) await blocked;
    sent.push(message);
  } });
  const id = "sa_superseding_exit";
  let olderBoundary: Promise<boolean> | undefined;
  const stop = onMetaChanged(() => {
    if (!olderBoundary && readMeta(id)?.status === "completed") olderBoundary = batcher.flush();
  });
  try {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
    writeMeta({ id, status: "lost", pid: 4194304, cwd: root, sessionId: id,
      startedAt: 1, callback: true, logPath: logPathFor(id), promptPreview: "work" });
    batcher.enqueue({ source: "subagent", id: "earlier", label: "earlier", status: "completed" });
    const earlier = batcher.flush();
    const final = finalizeRun(id, 0, { sendMessage: () => {
      const meta = readMeta(id)!;
      batcher.enqueue({ ...completionCallbackFields(meta, collectRunFailures(id, root, true)),
        onDelivered: (at: number) => writeMeta({ ...readMeta(id)!, completionCallbackSentAt: at }) });
    } });
    assert.equal(final.applied, true);
    assert.equal(readMeta(id)?.status, "completed", "real terminal evidence supersedes provisional lost");
    assert.ok(olderBoundary, "metadata visibility can precede the newer callback handoff");
    release();
    assert.equal(await earlier, true);
    assert.equal(await olderBoundary, true);
    assert.equal(sent.some(message => message.content.includes(id)), false, "an earlier successful flush is not this outcome's receipt");
    assert.equal(batcher.pendingCount(), 1, "the later exact completion remains owed, not dropped");
    assert.equal(await batcher.flush(), true);
    assert.equal(sent.filter(message => message.content.includes(id)).length, 1);
    assert.ok(readMeta(id)?.completionCallbackSentAt);
    assert.equal(finalizeRun(id, 0).applied, false, "a true terminal winner is never rewritten");
  } finally {
    release(); stop(); batcher.cancel();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
