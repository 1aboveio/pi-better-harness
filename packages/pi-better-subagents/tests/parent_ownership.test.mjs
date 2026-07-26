// @covers parent-ownership
// @level unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ownedByThisParent } from "../registry.ts";

const thisParentPid = 41001;
const foreignParentPid = 41002;
const ownRunningMeta = { id: "sa_owned", spawnPid: thisParentPid, status: "running" };
const foreignRunningMeta = { id: "sa_foreign", spawnPid: foreignParentPid, status: "running" };

describe("parent ownership", () => {
  it("matches only metas launched by the supplied parent PID", () => {
    assert.equal(ownedByThisParent(ownRunningMeta, thisParentPid), true);
    assert.equal(ownedByThisParent(foreignRunningMeta, thisParentPid), false);
  });
  it("filters a running list to this parent and excludes foreign spawn PIDs", () => {
    const metas = [ownRunningMeta, foreignRunningMeta, { id: "sa_owned_done", spawnPid: thisParentPid, status: "completed" }];
    const ownedRunning = metas.filter((meta) => ownedByThisParent(meta, thisParentPid) && meta.status === "running");
    assert.deepEqual(ownedRunning.map((m) => m.id), ["sa_owned"]);
  });
  it("does not scope explicit id lookups, which remain global for recovery", () => {
    const metasById = new Map([[ownRunningMeta.id, ownRunningMeta], [foreignRunningMeta.id, foreignRunningMeta]]);
    assert.equal(metasById.get("sa_foreign"), foreignRunningMeta);
  });

  it("default list filter keeps only this parent; all:true keeps foreign pids", () => {
    const metas = [ownRunningMeta, foreignRunningMeta];
    const def = metas.filter((meta) => ownedByThisParent(meta, thisParentPid));
    const all = metas; // all:true path
    assert.deepEqual(def.map((m) => m.id), ["sa_owned"]);
    assert.deepEqual(all.map((m) => m.id), ["sa_owned", "sa_foreign"]);
  });
});
