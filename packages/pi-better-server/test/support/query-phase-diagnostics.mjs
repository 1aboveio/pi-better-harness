// Temporary #805 CI evidence. Shared memory never publishes liveness or replies.
const capacity = 48;
const header = 16;
export const queryPhase = {
  workerStart: 1, dispatch: 2, callerDeadline: 3, replyReceived: 4, fixtureReady: 5,
  moduleEntered: 6, modelImportBegin: 7, modelImportEnd: 8, modelConstructBegin: 9,
  modelConstructEnd: 10, handlerInstalled: 11, queryReceived: 12, handlerEntered: 13,
  snapshotBegin: 14, snapshotEnd: 15, replyBegin: 16, replyPosted: 17, cancelReceived: 18,
  fixtureHeld: 19, releaseSent: 20, fixtureReleased: 21, bootstrapHandoff: 22,
  inventoryBegin: 23, inventoryEnd: 24, watchBegin: 25, watchEnd: 26,
  checkpointBegin: 27, checkpointEnd: 28, backgroundBegin: 29, backgroundEnd: 30,
  sourceReady: 31, watchdogFired: 32,
};
export function createQueryPhaseBuffer() {
  return new SharedArrayBuffer((header + capacity * 4) * BigInt64Array.BYTES_PER_ELEMENT);
}
export function recordQuerySample(buffer, kind) {
  if (!buffer) return;
  const slot = { accepted: 2, sent: 4, consumed: 6, response: 8, watchdog: 10, bootstrapSent: 12, bootstrapConsumed: 14 }[kind];
  const words = new BigInt64Array(buffer);
  Atomics.add(words, slot, 1n);
  Atomics.store(words, slot + 1, process.hrtime.bigint());
}
export function recordQueryPhase(buffer, phase, id = 0, generation = 0) {
  if (!buffer || id > 2) return;
  const words = new BigInt64Array(buffer);
  const index = Number(Atomics.add(words, 0, 1n));
  if (index >= capacity) { Atomics.add(words, 1, 1n); return; }
  const offset = header + index * 4;
  words[offset + 1] = BigInt(id);
  words[offset + 2] = BigInt(phase);
  words[offset + 3] = BigInt(generation);
  Atomics.store(words, offset, process.hrtime.bigint());
}
export function readQueryPhases(buffer) {
  const words = new BigInt64Array(buffer);
  const total = Number(Atomics.load(words, 0));
  const names = Object.fromEntries(Object.entries(queryPhase).map(([name, value]) => [value, name]));
  const records = [];
  for (let index = 0; index < Math.min(total, capacity); index++) {
    const offset = header + index * 4;
    const at = Atomics.load(words, offset);
    if (at === 0n) continue;
    records.push({ atNs: String(at), id: Number(words[offset + 1]),
      phase: names[Number(words[offset + 2])], generation: Number(words[offset + 3]) });
  }
  const samples = {};
  for (const [kind, slot] of Object.entries({ accepted: 2, sent: 4, consumed: 6, response: 8, watchdog: 10, bootstrapSent: 12, bootstrapConsumed: 14 }))
    samples[kind] = { count: Number(Atomics.load(words, slot)), lastNs: String(Atomics.load(words, slot + 1)) };
  return { capacity, total, dropped: Number(Atomics.load(words, 1)), samples, records };
}
