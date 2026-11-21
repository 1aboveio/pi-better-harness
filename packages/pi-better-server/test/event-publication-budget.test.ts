import test from "node:test";
import assert from "node:assert/strict";
const { publicationBudgetDiagnostic } = await import(new URL("../scripts/event-publication/measure.mjs", import.meta.url).href);

test("delivered late publication captures component state without replacing timing or retrying", async () => {
  const observation = { commit: 0, recipients: Array.from({ length: 10 }, (_, subscriber) => ({ subscriber,
    latencyMs: 1369.472208 + subscriber * 0.04, completionDeltaMs: 1368.413416 + subscriber * 0.04 })) };
  const before = structuredClone(observation);
  let reads = 0;
  const metrics = { scheduling: { maxQueueAgeMs: 7 }, sourceSubscriptions: { allocated: 7 } };
  assert.deepEqual(await publicationBudgetDiagnostic(observation, async () => { reads++; return metrics; }), { component: metrics });
  assert.equal(reads, 1);
  assert.deepEqual(observation, before, "a diagnostic cannot reset the original late sample");
  assert.ok(Math.max(...observation.recipients.map(recipient => recipient.latencyMs)) > 1000,
    "the original unchanged acceptance assertion must still reject this observation");
});

test("healthy publications do not sample extra state and diagnostic refusal stays explicit", async () => {
  let reads = 0;
  assert.equal(await publicationBudgetDiagnostic({ recipients: [{ latencyMs: 1000 }] }, () => { reads++; }), undefined);
  assert.equal(reads, 0);
  assert.deepEqual(await publicationBudgetDiagnostic({ recipients: [{ latencyMs: 1000.1 }] }, () => { throw new Error("reader unavailable"); }),
    { diagnosticError: "Error: reader unavailable" });
});
