import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

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

test("launch permission resolution keeps the captured child profile below the manager's main profile", async () => {
  const domain = "../src/runtime/domain/subagents/";
  const { resolveSubagentPermissions, currentSandboxPermissions } = await import(domain + "permission-policy.domain.mjs");
  const { assertAssignmentPermissionScope } = await import(domain + "worker-waits.domain.mjs");
  const events = new EventEmitter();
  const full = { enabled: true, projectFiles: "read-write", outsideProject: "read-write", storedCredentials: "read-write", commands: true, network: true };
  const child = { enabled: true, projectFiles: "read", outsideProject: "off", storedCredentials: "off", commands: false, network: false };
  let policy: any = { state: "enabled", permissions: full, subagentPermissions: child };
  events.on("pi-better-sandbox:policy-request", () => events.emit("pi-better-sandbox:policy", policy));
  const api = { events };
  const captured = currentSandboxPermissions(api);
  const launch = resolveSubagentPermissions(api, undefined);
  assert.equal(launch.sandboxEnabled, true); assert.equal(launch.enforced, true);
  assert.equal(launch.permissions.commands, false); assert.equal(launch.permissions.network, false);
  assert.equal(launch.permissions.outsideProject, "off");
  assert.throws(() => resolveSubagentPermissions(api, false), /cannot bypass/);
  policy = { state: "enabled", permissions: { ...full, commands: false }, subagentPermissions: child };
  assert.throws(() => resolveSubagentPermissions(api, true), /Main sandbox profile disables commands/);
  policy = { state: "inactive" };
  assert.equal(resolveSubagentPermissions(api, undefined).enforced, false);
  assert.throws(() => assertAssignmentPermissionScope({ sandbox: { root: "/workspace", permissions: captured.subagentPermissions }, mandatoryPermissions: true },
    { sandbox: null, mandatoryPermissions: false }), /authority is unavailable/);
  assert.equal(captured.subagentPermissions.network, false, "later host policy publications cannot rewrite captured authority");
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
