import assert from "node:assert/strict";
import { test } from "node:test";
import { onlyStatusProbeRemains } from "./support/runtime-status.ts";

test("connection-removal observation allows its own status dispatch but no other obligation", () => {
  const probe = { kind: "transport-request", id: 3, connection: 2 };
  const status = { livenessReasons: [probe], transportRequests: [{ ...probe }] };
  assert.equal(onlyStatusProbeRemains(status), true, "a passive probe must not count itself as a remaining connection");
  for (const reason of [
    { kind: "connection", id: 1, connection: 1 },
    { kind: "runner", id: 1, connection: 1 },
    { kind: "transport-request", id: 2, connection: 1 },
  ]) {
    assert.equal(onlyStatusProbeRemains({ ...status, livenessReasons: [reason, probe] }), false);
  }
  assert.equal(onlyStatusProbeRemains({ ...status, transportRequests: [probe, { ...probe, id: 4 }] }), false);
  assert.equal(onlyStatusProbeRemains({ ...status, transportRequests: [{ ...probe, connection: 99 }] }), false);
  assert.equal(onlyStatusProbeRemains({ ...status, transportRequests: [{ ...probe, id: 99 }] }), false);
  assert.equal(onlyStatusProbeRemains({ ...status, livenessReasons: [{ ...probe, kind: "connection" }] }), false);
});
