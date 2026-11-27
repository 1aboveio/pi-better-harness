import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WorkReadModel } from "../src/runtime/read-model.ts";

for (const boundary of ["before-receive", "after-receive", "before-apply", "after-apply"]) test(`real reader exit at ${boundary} preserves source and recovers derived coverage`, async () => {
  const root = mkdtempSync(join(tmpdir(), "assignment-crash-"));
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", new URL("./support/assignment-observation-crash.ts", import.meta.url).pathname, root, boundary], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 23, `${boundary}: ${child.error ?? child.stderr}`);
    const inbox = new DatabaseSync(join(root, "runtime-read-repair", "assignments.sqlite"), { readOnly: true });
    const pending = inbox.prepare("SELECT count(*) AS n FROM pending").get()!.n;
    inbox.close();
    assert.equal(pending, boundary === "before-receive" ? 0 : 1);
    const model = new WorkReadModel(root, "replacement-reader", { baseDir: root, durableDir: join(root, "archive"), intervalMs: 60000 });
    try {
      assert.equal(model.snapshot().status, "rebuilding");
      await model.reconcile();
      assert.equal(model.snapshot().status, "ready");
      assert.equal(model.snapshot({ id: "attempt" }).rows[0]!.recipientPending, false);
      assert.equal(model.metrics.assignments.pending, 0);
      const source = new DatabaseSync(join(root, "operation-coordinator.sqlite"), { readOnly: true });
      try {
        const record = JSON.parse(String(source.prepare("SELECT record_json FROM assignment_outcomes").get()!.record_json));
        assert.equal(record.deliveryReceipt.entryId, "receipt");
        assert.equal(record.disposition, null, "recovery cannot consume the domain result");
        assert.equal(source.prepare("SELECT count(*) AS n FROM outbox_events").get()!.n, 1);
      } finally { source.close(); }
    } finally { await model.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
