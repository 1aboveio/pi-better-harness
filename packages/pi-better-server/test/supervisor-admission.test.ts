import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SupervisorAdmission } from "../src/runtime/supervisor-admission.ts";

test("only the admitting session may finish a live diagnostic and disabled scenarios revoke delivery", () => {
  let enabled = true;
  let clock = 0;
  const service = new SupervisorAdmission(() => enabled, () => clock);
  const ask = (owner: string, action: string, token?: string) =>
    service.request(owner, { scenario: "scope-review", action, token });
  const first = ask("owner", "begin");
  assert.ok(first.token);
  assert.equal(ask("other", "finish", first.token).status, "stale");
  assert.equal(ask("other", "begin").status, "busy");
  enabled = false;
  assert.equal(ask("owner", "finish", first.token).status, "disabled");
  enabled = true;
  assert.equal(ask("owner", "finish", first.token).status, "stale");
  const second = ask("other", "begin");
  clock += 45_001;
  assert.equal(ask("other", "finish", second.token).status, "stale");
  const third = ask("owner", "begin");
  assert.equal(ask("owner", "finish", third.token).status, "admitted");
  assert.equal(ask("owner", "finish", third.token).status, "stale");
});
