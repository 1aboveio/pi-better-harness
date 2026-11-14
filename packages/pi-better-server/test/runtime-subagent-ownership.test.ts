import test from "node:test";
import assert from "node:assert/strict";

test("management handoff refuses live legacy managers and unknown writers, and isolates other roots", async () => {
  const domain = "../src/runtime/domain/subagents/";
  const { assertSubagentHandoff } = await import(domain + "managed-launch-ownership.ts");
  // Only OS observations are substituted; the production handoff decision runs unchanged.
  const starts = new Map<number, string | undefined>([[10, "manager"], [20, "worker"]]);
  const probe = { pidExists: (pid: number) => starts.has(pid), startToken: (pid: number) => starts.get(pid) };
  const meta = { id: "sa_owner_1", status: "running", spawnPid: 10, spawnPidStartTime: "manager", pid: 20, pidStartTime: "worker" };
  assert.throws(() => assertSubagentHandoff([meta], "/root", probe), /legacy-manager-live-or-unknown/);
  starts.delete(10);
  assert.throws(() => assertSubagentHandoff([meta], "/root", probe), /legacy-writer-live-or-unknown/);
  const managed = { ...meta, management: { root: "/root", instance: "old", epoch: 1 } };
  assertSubagentHandoff([managed], "/root", probe);
  starts.set(20, undefined);
  assert.throws(() => assertSubagentHandoff([managed], "/root", probe), /writer-identity-unknown/);
  assertSubagentHandoff([managed], "/different-root", probe);
  starts.delete(20);
  assertSubagentHandoff([meta], "/root", probe);
  starts.set(10, "recycled-pid");
  assertSubagentHandoff([meta], "/root", probe);
  starts.set(10, undefined);
  assert.throws(() => assertSubagentHandoff([meta], "/root", probe), /legacy-manager-live-or-unknown/);
});

test("capacity remains independent per original owner/start and shares reservations within one owner", async () => {
  const module = "../src/runtime/domain/subagents/capacity.mjs";
  const { createOwnerCapacityGates } = await import(module);
  const running = new Map<string, number>();
  const forOwner = createOwnerCapacityGates((owner: any) => running.get(JSON.stringify([owner.pid, owner.start])) ?? 0);
  const first = { pid: 10, start: "first" }, second = { pid: 20, start: "second" }, recycled = { pid: 10, start: "later" };
  const a = forOwner(first), b = forOwner(second);
  assert.equal(a.tryReserve(1, 1), true);
  assert.equal(forOwner(first).tryReserve(1, 1), false);
  assert.equal(b.tryReserve(1, 1), true);
  assert.equal(forOwner(recycled).tryReserve(1, 1), true);
  running.set(JSON.stringify([first.pid, first.start]), 1); a.commit();
  assert.equal(a.tryReserve(1, 1), false);
  b.release(); assert.equal(b.tryReserve(1, 1), true); b.release();
  running.delete(JSON.stringify([first.pid, first.start]));
  assert.equal(a.tryReserve(1, 1), true); a.release();
});
