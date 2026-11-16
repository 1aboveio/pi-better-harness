const LIMIT = 128;
const records = [];
let sequence = 0;

// This recorder is imported only by the resource fixture and its loader.
export function recordRecoveryTrace(record) {
  const bounded = JSON.parse(JSON.stringify(record, (_key, value) => typeof value === 'string' ? value.slice(0, 256) : value));
  const entry = { sequence: ++sequence, at: Date.now(), ...bounded };
  if (Buffer.byteLength(JSON.stringify(entry)) > 4096) throw new Error('Resource recovery trace entry exceeds its test-only bound');
  records.push(entry);
  if (records.length > LIMIT) records.shift();
}

export function recoveryTraceSnapshot() {
  return { total: sequence, dropped: sequence - records.length, records: [...records] };
}
