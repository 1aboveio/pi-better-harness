import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBatchCapture, platformCapture } from '../scripts/measure-full-runtime/batch-capture.mjs';
import { summarizeCohorts } from '../scripts/measure-full-runtime/aggregate-samples.mjs';
import { controlOwnedExecutor, bindOwnedModel, distribution } from '../scripts/measure-full-runtime/owned-fixture.mjs';
import { runCampaign } from '../scripts/measure-full-runtime/campaign.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { WorkReadModel } from '../src/runtime/read-model.ts';
const ns = (ms: number) => String(ms * 1000000);

test('fresh platform batch composition retains independent observed times and qualifies compatible source cohorts', () => {
  let time = 1000;
  const capture = createBatchCapture({ pids: [11,22], generation: '1', capture: pids => ({ captureStartedAt: time - 2, capturedAt: time,
    captureStartedContinuousNs: ns(time - 2), capturedContinuousNs: ns(time),
    source: { kind: 'injected-external-OS-boundary', platform: 'darwin', clock: 'mach-continuous' }, records: pids.map((pid,i) => ({ identity: { pid, start: `birth-${pid}` },
      observedAt: time - i, observedContinuousNs: ns(time - 1 + i), cpu: { totalMicros: time * pid }, rss: pid * 100 })) }) });
  const first = capture(); time += 200; const second = capture();
  assert.notEqual(first[0]!.sourceCohort.id, second[0]!.sourceCohort.id);
  assert.equal(second[1]!.observedAt, 1199);
  assert.equal(second[1]!.at, second[0]!.at);
  const result = summarizeCohorts([first,second], { required: first, generation: '1' }, { startedAt: 1000, endedAt: 1200, startedContinuousNs: ns(1000), endedContinuousNs: ns(1200) });
  assert.equal(result.qualified, true, result.issues.join(',')); assert.equal(result.cpuPercent, 3.3);
  assert.equal(result.rssBytes, 3300);
});

test('batch owner refuses changed birth identity, missing PID and malformed platform output', () => {
  let rows = [{ identity: { pid: 11, start: 'a' }, observedAt: 1, observedContinuousNs: ns(1), cpu: { totalMicros: 1 }, rss: 2 }];
  const capture = createBatchCapture({ pids: [11], generation: '1', capture: () => ({ captureStartedAt: 1, capturedAt: 2,
    captureStartedContinuousNs: ns(1), capturedContinuousNs: ns(2), records: rows }) });
  capture(); rows = [{ ...rows[0]!, identity: { pid: 11, start: 'b' } }]; assert.throws(capture, /start identity/);
  rows = []; assert.throws(capture, /PID set/);
  assert.throws(() => platformCapture([11], { platform: 'darwin', now: () => 1 }), /binding required/);
});

test('batch producer cannot relabel previously timestamped independent records as a new capture', () => {
  const capture = createBatchCapture({ pids: [11], generation: '1', capture: () => ({ captureStartedAt: 1000, capturedAt: 1002,
    captureStartedContinuousNs: ns(1000), capturedContinuousNs: ns(1002), source: { kind: 'old-independent-probe' },
    records: [{ identity: { pid: 11, start: 'a' }, at: 999, observedAt: 999, observedContinuousNs: ns(999), cpu: { totalMicros: 1 }, rss: 2 }] }) });
  assert.throws(capture, /independent|timestamp/i);
});

test('batch producer rejects observations outside the acquisition and fences native binding changes', () => {
  let time = 1000, observedAt = 999, nativeBindingId = 'first-binding';
  const capture = createBatchCapture({ pids: [11], generation: '1', capture: () => ({
    captureStartedAt: time, capturedAt: time + 2,
    captureStartedContinuousNs: ns(time), capturedContinuousNs: ns(time + 2),
    source: { kind: 'darwin-libproc-batch', platform: 'darwin', clock: 'mach-continuous', nativeBindingId, cpuResolutionMs: .000041 },
    records: [{ identity: { pid: 11, start: 'kernel-birth' }, observedAt, observedContinuousNs: ns(observedAt), cpu: { totalMicros: time }, rss: 100 }],
  }) });
  assert.throws(capture, /outside actual acquisition span/);
  observedAt = 1003;
  assert.throws(capture, /outside actual acquisition span/);
  observedAt = 1001;
  const first = capture();
  time = 1200; observedAt = 1201; nativeBindingId = 'replacement-binding';
  const second = capture();
  const result = summarizeCohorts([first, second], { required: first, generation: '1' }, { startedAt: 1002, endedAt: 1202, startedContinuousNs: ns(1002), endedContinuousNs: ns(1202) });
  assert.equal(result.qualified, false);
  assert.ok(result.issues.includes('changed-counter-source'));
  assert.equal(result.cpuPercent, null);
  assert.equal(result.rssBytes, null);
});

test('Darwin in-process boundary preserves native batch and accounts for an absent helper process, never a PS fallback', () => {
  let calls = 0;
  const result = platformCapture([11], { platform: 'darwin', now: () => 1000,
    run: () => { throw Error('A per-capture helper process must not be launched'); },
    nativeCapture: pids => { calls++; return { captureStartedAt:1000,capturedAt:1002,cpuResolutionMs:.000041,
      captureStartedContinuousNs: ns(1000), capturedContinuousNs: ns(1002),
      records:pids.map(pid=>({identity:{pid,start:'kernel-birth',boot:'boot-time'},cpu:{totalMicros:62500000},rss:43008,observedAt:1001, observedContinuousNs:ns(1001)})) }; } });
  assert.equal(calls, 1); assert.deepEqual(result.records[0]!.cpu, { totalMicros: 62500000 });
  assert.equal(result.records[0]!.rss, 43008);
  assert.equal(result.records[0]!.observedAt,1001); assert.equal(result.capturedAt,1002);
  assert.equal(result.source.diagnosticCost.coverage,'complete-no-child-process');
  assert.equal(result.source.diagnosticCost.childCpuMicros,0);
});

test('owned executor controls use only its captured physical worker, acknowledge real cache clearing and reject unbound ownership', async () => {
  const worker = new EventEmitter() as any, port = new EventEmitter() as any;
  const model = { parseStates: new Map([['a',1]]), healthStates: new Map([['a',1]]),
    get metrics() { return { checkpoints: { hotDisplay: this.parseStates.size, hotHealth: this.healthStates.size } }; } };
  port.postMessage = (reply: any) => worker.emit('message',reply);
  worker.postMessage = (request: any) => port.emit('message',request);
  // External thread port is injected. These are component compositions, NOT a live executor qualification.
  bindOwnedModel(model,port);
  const executor = { worker, snapshot: async () => model.metrics, metrics: () => ({ executor: { worker: 'running' } }), observation: () => ({ status: 'ready' }) };
  const eviction = await controlOwnedExecutor(executor,'evict');
  assert.equal(eviction.action,'evict'); assert.equal(model.parseStates.size,0); assert.equal(model.healthStates.size,0);
  let terminated = 0; worker.terminate = async () => { terminated++; executor.worker = new EventEmitter(); };
  const restart = await controlOwnedExecutor(executor,'restart');
  assert.equal(restart.scope,'runtime'); assert.equal(terminated,1); assert.notEqual(executor.worker,worker);
  await assert.rejects(controlOwnedExecutor(undefined,'restart'), /Missing live/);
  await assert.rejects(controlOwnedExecutor(executor,'foreign-action'), /Unsupported/);
  assert.throws(() => distribution([]), /Missing actual/);
});

test('Linux batch owner retains kernel birth/tick/page units and individual acquisition observations', () => {
  let time = 1000, elapsed = 100;
  const fields = ['S', ...Array(21).fill('0')]; fields[11] = '10'; fields[12] = '5'; fields[19] = '777'; fields[21] = '3';
  const result = platformCapture([11,22], { platform: 'linux', now: () => time++, continuousNs: () => ns(elapsed++), units: { ticks: 100, pageBytes: 4096 },
    run: () => { throw Error('No external process permitted in this component test'); },
    read: path => path.endsWith('boot_id') ? 'boot-observation' : `${path.includes('/11/') ? 11 : 22} (name with spaces) ${fields.join(' ')}` });
  assert.equal(result.records[0]!.cpu.totalMicros,150000); assert.equal(result.records[0]!.rss,12288);
  assert.equal(result.records[1]!.identity.start,'777'); assert.equal(result.records[1]!.identity.boot,'boot-observation');
  assert.notEqual(result.records[0]!.observedAt,result.records[1]!.observedAt); assert.equal(result.capturedAt,1003);
  assert.deepEqual(result.records.map(value => value.observedContinuousNs), [ns(101), ns(102)]);
  assert.equal(result.capturedContinuousNs, ns(103));
});

test('campaign retains required workload duration and original baseline applicability; missing observations fail closed', async () => {
  const calls: any[] = [], states: any[] = [];
  const before = {head:'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8',sourceSha256:'a'.repeat(64),artifactContentId:'b'.repeat(64)};
  await assert.rejects(runCampaign({ driver: { checkout: 'driver' }, outputDirectory: 'unit-output', approved: { driver: { head: 'e'.repeat(40), sourceSha256: 'f'.repeat(64) }, fixedHostId: 'owned', fixtureSha256:'c'.repeat(64), before, after:{...before,head:'d'.repeat(40)} }, before: { checkout: 'before', artifactRoot: 'before-artifact' } }, {
    save: (_path,value) => states.push(structuredClone(value)), run: async value => { calls.push(value); throw Error('baseline capture unavailable'); },
  }), /baseline capture unavailable/);
  assert.equal(calls.length,1); assert.equal(calls[0].durationMs,600000);
  assert.deepEqual(calls[0].workload,{history:4416,clients:1,group:48});
  assert.equal(states.at(-1).steps[0].status,'failed');
});

test('default campaign requests every paired workload but cannot qualify injected incomplete reports', async () => {
  const before = {head:'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8',sourceSha256:'a'.repeat(64),artifactContentId:'b'.repeat(64)};
  const approved = { driver: { head: 'e'.repeat(40), sourceSha256: 'f'.repeat(64) }, fixedHostId:'component-host',fixtureSha256:'c'.repeat(64),before,after:{...before,head:'d'.repeat(40)} };
  const calls: any[] = [], states: any[] = [];
  await assert.rejects(runCampaign({driver:{checkout:'driver'},approved,outputDirectory:'unit',before:{checkout:'before',artifactRoot:'before-artifact'},after:{checkout:'after',artifactRoot:'after-artifact'}},{
    save: (_path,value) => states.push(structuredClone(value)), run: async value => {
      calls.push(value); return {driver:{head:approved.driver.head,manifest:{sha256:approved.driver.sourceSha256}},incremental:{...value.workload,durationMs:value.durationMs},source:{head:approved[value.side].head,manifest:{sha256:approved[value.side].sourceSha256}},
        measurement:{artifact:{contentId:approved[value.side].artifactContentId},fixtureSha256:approved.fixtureSha256}};
    },
  }), /unchanged qualification/);
  assert.equal(calls.length,36); assert.equal(new Set(calls.map(value => `${value.side}/${value.workload.history}/${value.workload.clients}/${value.workload.group}`)).size,36);
  assert.ok(calls.every(value => value.durationMs === 600000));
  assert.equal(states.at(-1).status,'unqualified'); assert.equal(states.at(-1).comparison.cpuComparison,null);
});

test('real executor and model compose through injected external thread boundary for eviction and recovery', async () => {
  const root = mkdtempSync(join(tmpdir(),'owned-binding-'));
  mkdirSync(join(root,'runs','task'),{recursive:true});
  writeFileSync(join(root,'runs','task','output.log'),'');
  writeFileSync(join(root,'runs','task','meta.json'),JSON.stringify({id:'task',cwd:root,status:'completed',startedAt:1}));
  const threads = createRequire(import.meta.url)('node:worker_threads'), Original = threads.Worker;
  let births = 0;
  class ThreadBoundary extends EventEmitter {
    model; port = new EventEmitter() as any; initial; dead = false;
    constructor(_url: URL, options: any) {
      super();
      births++;
      this.model = new WorkReadModel(root,options.workerData.instanceId,options.workerData.modelOptions);
      this.port.postMessage = (reply: any) => this.emit('message',reply); bindOwnedModel(this.model,this.port);
      this.initial = this.model.reconcile().then(() => this.emit('message',{type:'revision',metrics:this.model.metrics,observation:this.model.observation()}));
    }
    postMessage(message: any) {
      if (message.type === 'resource-fixture-evict') this.port.emit('message',message);
      if (message.type === 'query') void this.initial.then(() => this.emit('message',{type:'reply',id:message.id,
        json:JSON.stringify(this.model.snapshot(message.command.scope)),metrics:this.model.metrics}));
    }
    async terminate() { if (this.dead) return 0; this.dead = true; await this.model.close(); this.emit('exit',0); return 0; }
    unref() {}
  }
  threads.Worker = ThreadBoundary; syncBuiltinESMExports();
  let executor;
  try {
    const { WorkQueryExecutor } = await import('../src/runtime/query-executor.ts');
    executor = new WorkQueryExecutor(root,'owned-executor',{modelOptions:{baseDir:root,durableDir:join(root,'archive'),intervalMs:60000}});
    const stream = Object.assign(new EventEmitter(),{destroyed:false,writableLength:0,write:()=>true});
    executor.connect(stream as any);
    const before = await executor.snapshot({limit:1});
    const oldHandle = (executor as any).worker;
    assert.ok((executor.metrics() as any).checkpoints.hotDisplay > 0);
    await controlOwnedExecutor(executor,'evict');
    assert.equal((executor.metrics() as any).checkpoints.hotDisplay,0);
    await controlOwnedExecutor(executor,'restart');
    assert.notEqual((executor as any).worker,oldHandle); assert.equal(births,2);
    const after = await executor.snapshot({limit:1});
    assert.notEqual(after.instanceId,before.instanceId); assert.equal(after.status,'ready');
    assert.equal(after.rows[0].meta.id,'task');
    assert.ok((executor.metrics() as any).checkpoints.restores > 0, 'Owned replacement reader restores actual durable parser progress');
  } finally {
    await executor?.close(); threads.Worker = Original; syncBuiltinESMExports(); rmSync(root,{recursive:true,force:true});
  }
});
