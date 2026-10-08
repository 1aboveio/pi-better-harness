import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, preload, runChild, scratch, summarize } from './benchmark.mjs';

function ownFixture(t) {
  const root = mkdtempSync(join(scratch, '.test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return fixture(root);
}

test('statistics compute an independent median/range without mutating samples', () => {
  const odd = [90, 10, 50, 30, 70];
  assert.deepEqual(summarize(odd), { n: 5, medianMs: 50, minMs: 10, maxMs: 90 });
  assert.deepEqual(odd, [90, 10, 50, 30, 70]);
  assert.deepEqual(summarize([12, 2, 8, 4]), { n: 4, medianMs: 6, minMs: 2, maxMs: 12 });
  for (const invalid of [[], [NaN], [-1], [Infinity]]) assert.throws(() => summarize(invalid), assert.AssertionError);
});

test('RPC transport waits for matching get_state, supports chunking, and closes stdin', async (t) => {
  const f = ownFixture(t);
  const script = `let input=''; process.stdin.on('data', d => {
    input+=d; if(!input.includes('\\n')) return;
    const command=JSON.parse(input);
    process.stdout.write(JSON.stringify({type:'response', command:'get_state', id:'unrelated', success:true})+'\\n');
    const row=JSON.stringify({type:'response',command:'get_state',id:command.id,success:true,data:{messageCount:0,isStreaming:false}})+'\\n';
    process.stdout.write(row.slice(0,13)); setImmediate(()=>process.stdout.write(row.slice(13)));
  }); process.stdin.on('end',()=>{});`;
  const result = await runChild(['--require', preload, '-e', script], f, { rpc: true });
  assert.equal(result.stdoutRecords.at(-1).id, 'startup');
  assert.ok(result.exitWallMs >= result.readyWallMs);
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});

test('no readiness response is a failure even for a successful process exit', async (t) => {
  const f = ownFixture(t);
  await assert.rejects(runChild(['--require', preload, '-e', ''], f), /No session readiness response/);
});

test('unsuccessful RPC readiness is rejected, not timed as success', async (t) => {
  const f = ownFixture(t);
  const script = `process.stdin.once('data',()=>process.stdout.write(JSON.stringify({type:'response',command:'get_state',id:'startup',success:false,error:'fixture failure'})+'\\n'));`;
  await assert.rejects(runChild(['--require', preload, '-e', script], f, { rpc: true }), assert.AssertionError);
});

test('a stuck child is killed and reaped on the deadline', async (t) => {
  const f = ownFixture(t);
  await assert.rejects(runChild(['--require', preload, '-e', 'setInterval(()=>{},1000)'], f,
    { timeoutMs: 200 }), /Readiness deadline exceeded; child \d+ killed and reaped/);
});

test('network preload blocks actual API attempts before any connection', async (t) => {
  const f = ownFixture(t);
  await assert.rejects(runChild(['--require', preload, '-e',
    "try { fetch('https://example.invalid'); } catch {}"], f), /benchmark_network_audit.*fetch/s);
});
