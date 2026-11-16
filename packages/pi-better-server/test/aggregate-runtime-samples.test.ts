import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCohort, summarizeCohorts, type ProcessSample } from '../scripts/measure-full-runtime/aggregate-samples.mjs';

// Controlled arithmetic specimens only; never load measurements or native evidence.
const identities = [{ pid: 101, start: 'first-start' }, { pid: 202, start: 'second-start' }];
const options = { required: identities.map(identity => ({ identity })), generation: 'generation-1' };
function frame(at: number, sequence: number, cpu: number[], rss: number[]): ProcessSample[] {
  return identities.map((identity, i) => ({ identity: { ...identity }, generation: 'generation-1', at, sequence,
    cpu: { user: cpu[i]!, system: 0 }, rss: rss[i]! }));
}
const frames = () => [frame(0, 1, [0, 0], [100, 300]), frame(250, 2, [100000, 0], [300, 100]), frame(500, 3, [100000, 100000], [100, 300])];

test('controlled common-time cohorts aggregate CPU/RSS, not the sum of separate peaks', () => {
  const result = summarizeCohorts(frames(), options, { startedAt: 0, endedAt: 500 });
  assert.equal(result.qualified, true, JSON.stringify(result.issues));
  assert.equal(result.samples, 2);
  assert.equal(result.cpuPercent, 40, 'opposing per-process 40% intervals must not become an 80% aggregate peak');
  assert.equal(result.rssBytes, 400, 'opposing 300-byte process peaks must not become a 600-byte cohort peak');
  assert.deepEqual(result.intervals.map(value => [value.fromAt, value.at]), [[0, 250], [250, 500]]);
});

test('baseline RSS and repeated atomic-file reads are accounted without inventing CPU intervals', () => {
  const data = frames(); data[0]![0]!.rss = 1000;
  const result = summarizeCohorts([data[0]!, structuredClone(data[0]!), data[1]!, data[2]!], options, { startedAt: 0, endedAt: 500 });
  assert.equal(result.qualified, true); assert.equal(result.samples, 2); assert.equal(result.rssBytes, 1300);
  const one = summarizeCohorts([data[0]!], options, { startedAt: 0, endedAt: 500 });
  assert.equal(one.qualified, false); assert.equal(one.cpuPercent, null); assert.ok(one.issues.includes('missing-cpu-intervals'));
});

test('controlled CPU arithmetic includes system time and permits multi-core aggregate percentages', () => {
  const data = frames();
  data[1]![0]!.cpu = { user: 500000, system: 100000 };
  data[1]![1]!.cpu = { user: 300000, system: 100000 };
  assert.equal(aggregateCohort(data[0]!, data[1]!, options).cpuPercent, 400);
});

for (const [name, change, issue] of [
  ['missing process', (r: ProcessSample[]) => { r.pop(); }, 'current:process-coverage'],
  ['extra process', (r: ProcessSample[]) => { r.push({ ...structuredClone(r[0]!), identity: { pid: 303, start: 'extra' } }); }, 'current:process-coverage'],
  ['PID reuse', (r: ProcessSample[]) => { r[0]!.identity.start = 'reused'; }, 'current:process-coverage'],
  ['duplicate process', (r: ProcessSample[]) => { r[1]!.identity = { ...r[0]!.identity }; }, 'current:duplicate-process'],
  ['generation change', (r: ProcessSample[]) => { r[0]!.generation = 'generation-2'; }, 'current:generation'],
  ['mixed capture timestamp', (r: ProcessSample[]) => { r[0]!.at++; }, 'current:mixed-timestamps'],
  ['missing sample sequence', (r: ProcessSample[]) => { r[0]!.sequence++; }, 'missing-or-replayed-sample'],
  ['replayed sample sequence', (r: ProcessSample[]) => { r[0]!.sequence--; }, 'missing-or-replayed-sample'],
  ['negative CPU', (r: ProcessSample[]) => { r[0]!.cpu.user = -1; }, 'current:invalid-counter'],
  ['missing RSS', (r: ProcessSample[]) => { delete (r[0] as any).rss; }, 'current:invalid-counter'],
  ['NaN CPU', (r: ProcessSample[]) => { r[0]!.cpu.user = NaN; }, 'current:invalid-counter'],
  ['clock reversal', (r: ProcessSample[]) => { for (const sample of r) sample.at = 0; }, 'non-increasing-timestamp'],
  ['whole missing cohort', (r: ProcessSample[]) => { for (const sample of r) sample.at = 501; }, 'missing-cohort-interval'],
] as const) test(`controlled cohort rejects ${name}`, () => {
  const data = frames(); change(data[1]!);
  const result = aggregateCohort(data[0]!, data[1]!, options);
  assert.equal(result.qualified, false); assert.equal(result.cpuPercent, null); assert.equal(result.rssBytes, null);
  assert.ok(result.issues.includes(issue), JSON.stringify(result.issues));
});

test('counter resets, changed bytes under replayed sequence and missing boundaries cannot qualify', () => {
  const data = frames();
  data[2]![0]!.cpu.user = 1;
  assert.ok(aggregateCohort(data[1]!, data[2]!, options).issues.includes('reset-cpu-counter'));
  const replay = structuredClone(data[0]!); replay[0]!.rss++;
  const result = summarizeCohorts([data[0]!, replay, data[1]!], options, { startedAt: 0, endedAt: 500 });
  assert.equal(result.qualified, false); assert.equal(result.cpuPercent, null);
  assert.ok(result.issues.includes('missing-or-replayed-sample'));
  assert.ok(result.issues.includes('incomplete-window-coverage'));
});

test('gaps are retained after subsequent aligned samples and deltas never bridge them', () => {
  const data = frames(), bad = structuredClone(data[1]!); bad.pop();
  const result = summarizeCohorts([data[0]!, bad, data[1]!, data[2]!], options, { startedAt: 0, endedAt: 500 });
  assert.equal(result.qualified, false); assert.equal(result.cpuPercent, null); assert.equal(result.rssBytes, null);
  assert.deepEqual(result.intervals.map(value => value.fromAt), [250]);
  assert.ok(result.issues.includes('current:process-coverage'));
});

test('malformed or absent sample/cohort identity input is rejected, not filled with zero', () => {
  for (const required of [[], [{ identity: { pid: 0, start: '' } }], [options.required[0]!, options.required[0]!],
    [options.required[0]!, { identity: { pid: identities[0]!.pid, start: 'impossible-concurrent-incarnation' } }]]) {
    assert.equal(summarizeCohorts(frames(), { ...options, required }, { startedAt: 0, endedAt: 500 }).qualified, false);
  }
  for (const current of [[], [null], undefined] as any[]) {
    const result = summarizeCohorts([current], options, { startedAt: 0, endedAt: 500 });
    assert.equal(result.qualified, false); assert.equal(result.cpuPercent, null);
  }
});
