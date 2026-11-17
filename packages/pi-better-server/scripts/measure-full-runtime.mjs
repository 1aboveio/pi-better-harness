import assert from 'node:assert/strict';
import { sourceProvenance } from './source-provenance.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { cpus, totalmem, release, arch, tmpdir, hostname } from 'node:os';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { inspectDaemonOwner, processMatchesStart } from '../src/daemon-owner.ts';
import { WorkClient } from '../src/runtime/work-client.mjs';
import { DaemonClient } from '../src/client.ts';
import { RemoteClientSession } from '../src/remote-client/session.ts';
import { workloadSettings, seedWorkload, reconcileWorkload, workloadTransport, workloadCounterDelta } from './measure-full-runtime/incremental-workload.mjs';
import { checkStartupAdmission, startupIntentFromEnv } from '../src/startup/admission.ts';
import { readOwnBuild } from '../src/startup/artifact.ts';
import { summarizeCohorts } from './measure-full-runtime/aggregate-samples.mjs';
import { runMutationSequence } from './measure-full-runtime/mutation-sequence.mjs';
import { createBatchCapture, platformCapture } from './measure-full-runtime/batch-capture.mjs';
import { distribution } from './measure-full-runtime/owned-fixture.mjs';
import { measureEventPublication } from './event-publication/measure.mjs';
import { readLifecycleConfig } from '../src/lifecycle-config.ts';
import { createRequire } from 'node:module';
import { buildDarwinCapture } from './measure-full-runtime/build-darwin-capture.mjs';
if (process.argv.includes('--campaign') || (!process.argv.includes('--smoke') && process.env.PI_INCREMENTAL_WORKLOAD !== '1' && !process.env.PI_FULL_RUNTIME_MATRIX_ONLY)) {
  const { runCampaign } = await import('./measure-full-runtime/campaign.mjs');
  const configPath = process.argv.includes('--campaign') ? process.argv[process.argv.indexOf('--campaign') + 1] : process.env.PI_FULL_RUNTIME_CAMPAIGN_APPROVAL;
  assert.ok(configPath, 'Complete campaign requires approved fixed-host/source/artifact config; --smoke retains the nonqualifying CI resource fixture');
  await runCampaign(JSON.parse(readFileSync(configPath, 'utf8')));
  process.exit(0);
}
const incremental = workloadSettings();
const root = realpathSync(mkdtempSync(join(tmpdir(), 'p751-full-'))), agent = join(root, 'agent'), cwd = join(root, 'workspace'), samples = join(root, 'samples');
const { directory: transport, socketPath } = workloadTransport(root);
for (const path of [agent, transport, cwd, samples, join(agent, 'agents/roles')]) mkdirSync(path, { recursive: true });
const sessionFile=join(root,'resource-session.jsonl');
writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:randomUUID(),timestamp:new Date().toISOString(),cwd})+'\n');
const probe = new URL('./measure-full-runtime/probe.mjs', import.meta.url).href;
const execPath = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath;
process.env.PI_RESOURCE_REPORT_DIR=samples;let fixtureControl, nativeCapture;
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root, TMP: root, TEMP: root, PI_RESOURCE_REPORT_DIR: samples,
  BACKGROUND_SESSION_FILE:sessionFile,NODE_OPTIONS: `--import ${probe}`, LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: join(cwd, 'entered'), LAUNCH_RELEASE: join(cwd, 'release'), PI_OFFLINE: '1' };
const workload = incremental ? seedWorkload({ root, agent, cwd, settings: incremental }) : undefined;
if (workload) env.PI_SUBAGENT_DURABLE_DIR = workload.durable;
mkdirSync(join(agent,'extensions'),{recursive:true});
writeFileSync(join(agent,'extensions','resource-hosted.ts'),`export { default } from ${JSON.stringify(fileURLToPath(new URL('./measure-full-runtime/hosted-extension.ts',import.meta.url)))};\n`);
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'offline-fixture' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ piBetterHarness: { subagents: { providerExtensions: { openai: fileURLToPath(new URL('../test/support/subagent-offline-model.ts', import.meta.url)) }, defaultTools: 'read', maxConcurrent: 1 } } }));
writeFileSync(join(agent, 'agents/roles/fixture.md'), '---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4.1\n---\nOffline resource fixture.\n');
let errors = '', seq = 0; const children = [], clients = [];
const report = { root, transport, socketPath, socketBytes: Buffer.byteLength(socketPath), mode: process.env.PI_FULL_RUNTIME_MATRIX_ONLY ? "mixed-adapter-smoke-not-performance" : incremental ? "resource-matrix" : "resource-smoke-not-qualified", platform: process.platform, node: process.version, machine:{release:release(),arch:arch(),cpus:cpus().length,cpuModel:cpus()[0]?.model,totalMemory:totalmem()}, source:sourceProvenance(fileURLToPath(new URL('../../..', import.meta.url))), scope: 'Actual guardian, server, SDK Pi clients, managed worker, Background runner/command, two real RemoteClientSession adapters over loopback Unix transport with HostedSessions (not cross-machine SSH); sampler overhead included', scenarios: [] };
const output = process.env.PI_FULL_RUNTIME_REPORT ?? join(root, 'report.json');
report.measurement = { schemaVersion: 1, fixedHostId: process.env.PI_FULL_RUNTIME_HOST_ID ?? null, hostname: hostname(),
  artifact: readOwnBuild() ?? null,
  fixtureSha256: createHash('sha256').update(JSON.stringify([
    './measure-full-runtime.mjs', './measure-full-runtime/frontend.ts', './measure-full-runtime/hosted-extension.ts',
    './measure-full-runtime/probe.mjs', './measure-full-runtime/recovery-trace.mjs', './measure-full-runtime/recovery-trace-loader.mjs',
    './measure-full-runtime/incremental-workload.mjs', './event-publication/writer.mjs', './event-publication/commit.mjs',
    './measure-full-runtime/aggregate-samples.mjs',
    './measure-full-runtime/mutation-sequence.mjs',
    './measure-full-runtime/batch-capture.mjs', './measure-full-runtime/owned-fixture.mjs', './measure-full-runtime/owned-query-worker.mjs',
    './measure-full-runtime/darwin-capture.cc', './measure-full-runtime/build-darwin-capture.mjs',
    '../test/support/subagent-offline-model.ts',
  ].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex') })))).digest('hex'),
  diagnosticBudget: { samplerIntervalMs: 250, controlIntervalMs: 100 },
  activeWorkload: { subagents: 1, durableCommands: 2, legacyCommands: 2, hostedSessions: 2, offline: true },
  coverage: { workerGc: false, aggregatePeak: false, queueAge: false, eventLatency: false, recovery: false, exit: false } };
if (incremental) Object.assign(report, { incremental, workload: structuredClone(workload), qualification: 'notRun', missing: ['fault matrix', 'scope/UI matrix', 'native dual-platform runs', 'paired fixed-host comparison'] });
function start(url, args = []) { const child = fork(url, args, { execPath, execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child); child.stdout.resume(); child.stderr.on('data', d => { errors += d; }); return child; }
async function until(label, fn, timeout = 30000) { const deadline = Date.now()+timeout; while (Date.now()<deadline) { const value = await fn(); if (value) return value; await delay(25); } throw new Error(`${label} timed out: ${errors.slice(-4000)}`); }
function message(child, predicate) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error(`IPC timeout: ${errors.slice(-2000)}`)); }, 30000); const on = value => { if (predicate(value)) { cleanup(); resolve(value); } }; const exit = () => { cleanup(); reject(new Error(`Child exited: ${errors}`)); }; function cleanup() { clearTimeout(timer); child.off('message', on); child.off('exit', exit); } child.on('message', on); child.once('exit', exit); }); }
async function call(child, tool, params, key = `resource-${++seq}`) { const id = ++seq, pending = message(child, m => m.id === id); child.send({ id, key, tool, params }); const reply = await pending; assert.equal(reply.error, undefined, reply.stack); return reply.result; }
function diagnosticSamples() { return readdirSync(samples).filter(name => name.endsWith('.json')).flatMap(name => { try { const value = JSON.parse(readFileSync(join(samples,name),'utf8')); return value && typeof value === 'object' ? [value] : []; } catch { return []; } }); }
function observed() { return diagnosticSamples().filter(value => value.identity && processMatchesStart(value.identity.pid,value.identity.start)); }
let guardian, work; const hostedClients=[], remotes=[];
try {
  report.phase = 'startup-admission-preflight';
  const intent = startupIntentFromEnv(env);
  report.startup = { intent: intent.kind, inheritedGuardedChild: Boolean(env.PI_SERVER_GUARDED_CHILD), inheritedRebind: Boolean(env.PI_SERVER_GUARDIAN_REBIND) };
  checkStartupAdmission({ canonicalServerDir: transport, agentDir: agent, build: readOwnBuild(), intent });
  assert.ok(!env.PI_SERVER_GUARDED_CHILD && !env.PI_SERVER_GUARDIAN_REBIND, 'Primary workload requires its own legitimate guardian bootstrap; inherited guardian authority cannot be reused');
  if (process.platform === 'darwin') {
    const built = buildDarwinCapture(samples);
    const binding = createRequire(import.meta.url)(built.path);
    report.measurement.nativeCapture = { sourceSha256: built.sourceSha256, binarySha256: built.binarySha256, napiVersion: built.napiVersion };
    nativeCapture = pids => platformCapture(pids, { nativeCapture: binding.capture, nativeBindingId: built.binarySha256 });
  }
  ({ fixtureControl } = await import(probe));
  report.phase = 'start-primary-guardian';
  guardian = start(new URL('../src/cli.ts', import.meta.url));
  const owner = await until('server owner', () => { const v = inspectDaemonOwner(transport); return v.status === 'live' && v.owner; });
  await until('socket', async () => { try { work = new WorkClient(join(transport,'pi-server.sock'), agent); await work.ready; return true; } catch { work?.close(); return false; } });
  writeFileSync(join(agent,'server-registration-v1.json'), JSON.stringify({ version:1, agentDir:agent, serverDir:transport }));
  for (let i=0;i<2;i++) {
    const client=await DaemonClient.connect(join(transport,'pi-server.sock'));hostedClients.push(client);
    const result=await client.call({type:'create_session',cwd,model:{provider:'openai',modelId:'gpt-4.1'}});assert.ok(result.sessionId);
    const remote=await RemoteClientSession.connect(client,result.sessionId);remotes.push(remote);
    assert.equal(remote.extensionRunner.hasHandlers(),false);assert.deepEqual(remote.resourceLoader.getExtensions().extensions,[]);
  }
  await remotes[0].prompt('/resource_background');
  const remoteProof=await until('remote adapter hosted tool proof',()=>remotes[0].sessionManager.getBranch().find(entry=>entry.type==='custom_message'&&entry.customType==='remote-resource-proof'));
  const remoteLaunch=remoteProof.details;
  assert.ok(remoteLaunch?.operationId,JSON.stringify(remoteProof));
  report.mixed={transport:'loopback Unix RemoteClientSession, not cross-machine SSH',recipient:remotes[0].sessionId,otherRecipient:remotes[1].sessionId,operationId:remoteLaunch.operationId,localExtensionHandlers:false};
  const first = start(new URL('./measure-full-runtime/frontend.ts', import.meta.url)); await message(first,m=>m.ready); clients.push(first);
  const launch = await call(first,'subagent_spawn',{ prompt:'Execute fixture',role:'fixture',model:'openai/gpt-4.1',callback:false,tools:'read',skills:[] });
  assert.equal(launch.details.launched,true,JSON.stringify(launch));
  const metaPath = join(root,'pi-better-subagents/runs',launch.details.runId,'meta.json');
  const worker = JSON.parse(readFileSync(metaPath,'utf8'));
  assert.equal(worker.management.root,agent);assert.equal(remoteLaunch.owner.sessionId,remotes[0].sessionId);
  Object.assign(report.mixed,{canonicalRoot:agent,localWorker:worker.id,serverInstance:owner.token});
  await until('worker entered', () => { try { return JSON.parse(readFileSync(env.LAUNCH_ENTERED,'utf8')); } catch { return false; } });
  const bg = await call(first,'bg_task_spawn',{ shell:false,callback:true,argv:[execPath,'-e',`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(cwd,'command-pid'))},String(process.pid));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(cwd,'finish'))})){clearInterval(t);console.log('done')}},50)`] });
  assert.ok(bg.details?.id,JSON.stringify(bg));
  const db = new (await import('node:sqlite')).DatabaseSync(join(agent,'operation-coordinator.sqlite'),{readOnly:true});
  const grant = JSON.parse(db.prepare("SELECT value FROM coordinator_state WHERE key=?").get(`result-supervision-v1:${bg.details.operationId}`).value);
  const remoteGrant=JSON.parse(db.prepare("SELECT value FROM coordinator_state WHERE key=?").get(`result-supervision-v1:${remoteLaunch.operationId}`).value);
  const remoteClaim=await until('remote runner claim',()=>{try{return JSON.parse(readFileSync(join(remoteGrant.directory,'tasks',remoteLaunch.id,'claim.json'),'utf8'));}catch{return false;}});
  const claim = await until('runner claim', () => { try { return JSON.parse(readFileSync(join(grant.directory,'tasks',bg.details.id,'claim.json'),'utf8')); } catch { return false; } });
  db.close();
  const legacy=await call(first,'bg_task_spawn_batch',{jobs:[0,1].map(index=>({shell:false,callback:false,argv:[execPath,'-e',`const fs=require('node:fs');setImmediate(()=>{console.log('resource-ready');fs.writeFileSync(${JSON.stringify(join(cwd,'legacy-pid-'))}+${index},String(process.pid))});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(cwd,'finish'))})){clearInterval(timer)}},50)`]}))});
  assert.equal(legacy.details.launched.length,2,JSON.stringify(legacy));
  await until('legacy commands',()=>[0,1].every(index=>{try{return Number(readFileSync(join(cwd,`legacy-pid-${index}`),'utf8'))>0;}catch{return false;}}));
  await work.request('runtime_cancellation_status');
  for (const count of (incremental ? [incremental.clients] : process.env.PI_FULL_RUNTIME_MATRIX_ONLY?[1]:[1,5,10])) {
    while(clients.length<count) { const child=start(new URL('./measure-full-runtime/frontend.ts',import.meta.url)); await message(child,m=>m.ready); clients.push(child); }
    await work.get({cwd,active:true});
    const warmup=[];
    (report.warmups??=[]).push({clients:count,observations:warmup});
    await until('all native projections completed at stable Background revision',async()=>{
      const scope={background:true,cwd,sessionId:JSON.parse(readFileSync(sessionFile,'utf8').split('\n')[0]).id};
      const before=await work.get(scope);
      await Promise.all(clients.map(async child=>{const id=++seq,pending=message(child,m=>m.id===id);child.send({id,barrier:true});const reply=await pending;assert.equal(reply.error,undefined,reply.stack);}));
      const after=await work.get(scope), management=(await work.request('runtime_get_status')).backgroundManagement;
      const legacyReady=after.rows.filter(row=>!row.meta.durable).map(row=>{
        const meta=row.meta;
        try {const mtimeMs=Math.trunc(statSync(meta.logPath).mtimeMs);return {id:meta.id,mtimeMs,lastProgressAt:meta.lastProgressAt,ready:readFileSync(meta.logPath,'utf8').includes('resource-ready')&&(meta.lastProgressAt??meta.startedAt)>=mtimeMs};}
        catch{return {id:meta.id,ready:false};}
      });
      warmup.push({before:before.scopeRevision,after:after.scopeRevision,management,legacyReady});
      return before.status==='ready'&&after.status==='ready'&&before.scopeRevision===after.scopeRevision
        &&legacyReady.length===2&&legacyReady.every(row=>row.ready)&&after.rows.some(row=>row.meta.id===bg.details.id);
    });
    const observedLegacy=await work.get({background:true,cwd,sessionId:JSON.parse(readFileSync(sessionFile,'utf8').split('\n')[0]).id});
    assert.equal(observedLegacy.rows.filter(row=>!row.meta.durable).length,2);
    const managementBefore=(await work.request('runtime_get_status')).backgroundManagement;
    writeFileSync(join(samples, 'generation'), String(count));
    const commandPid = Number(readFileSync(join(cwd,'command-pid'),'utf8'));
    const legacyPids=[0,1].map(index=>Number(readFileSync(join(cwd,`legacy-pid-${index}`),'utf8')));
    const remoteCommandPid=Number(readFileSync(join(cwd,'remote-command-pid'),'utf8'));
    const required=[process.pid,...legacyPids,remoteClaim.pid,remoteCommandPid,owner.pid,guardian.pid,worker.pid,claim.pid,commandPid,...clients.map(c=>c.pid)];
    const sampleAll=(afterAt = 0)=>until('all actual processes sampled in this measurement generation',()=>{const values=observed();return required.every(pid=>values.some(value=>value.identity.pid===pid&&value.generation===String(count)&&value.at>=afterAt
      && (!incremental || (value.gcThreads?.complete && value.gcThreads.records.every(record => record.observedAt >= afterAt)))))?values:false;});
    let before=await sampleAll();
    const role = pid => pid===process.pid?'remote-adapters-and-measurement':pid===remoteClaim.pid?'remote-runner':pid===remoteCommandPid?'remote-command':pid===owner.pid ? 'server' : pid===guardian.pid ? 'guardian' : pid===worker.pid ? 'worker' : pid===claim.pid ? 'runner' : pid===commandPid ? 'command' : legacyPids.includes(pid)?'legacy-command':'pi';
    for(const pid of required) assert.ok(before.some(v=>v.identity.pid===pid),`Missing instrumented actual process ${pid}`);
    const workloadBefore = workload ? await reconcileWorkload(work, cwd, workload) : undefined;
    const countersBefore = await work.request('runtime_get_metrics');
    before = await sampleAll();
    const batchCapture = createBatchCapture({ pids: required, generation: String(count), ...(nativeCapture ? { capture: nativeCapture } : {}) });
    const aggregateCohorts = [batchCapture()];
    const requiredProcesses = aggregateCohorts[0].map(row => ({ identity: row.identity, role: role(row.identity.pid) }));
    const batchIdentity = value => ({ ...value, observedIdentity: value.identity, observedAt: value.at,
      identity: requiredProcesses.find(row => row.identity.pid === value.identity.pid).identity });
    before = before.map(batchIdentity);
    const captureCohort = () => {
      aggregateCohorts.push(batchCapture());
    };
    const startedAt = Date.now();
    const measurementStart=performance.now(), latencies=[], queueAges=[]; const duration=incremental?.durationMs ?? (process.env.PI_FULL_RUNTIME_MATRIX_ONLY?100:count===10?60000:3000);
    while(performance.now()-measurementStart<duration) { const began=performance.now(); await work.request('runtime_get_status'); latencies.push(performance.now()-began);
      const actual = await work.request('runtime_get_metrics');
      if (Number.isFinite(actual.executor?.oldestQueuedAgeMs)) queueAges.push(actual.executor.oldestQueuedAgeMs);
      captureCohort(); await delay(100); }
    const elapsedMs = performance.now() - measurementStart, endedAt = Date.now();
    captureCohort();
    const after=(await sampleAll(endedAt)).map(batchIdentity), metrics=await work.request('runtime_get_metrics'), status=await work.request('runtime_get_status');
    const aggregatePeak = summarizeCohorts(aggregateCohorts, { required: requiredProcesses, generation: String(count) }, { startedAt, endedAt });
    const workloadAfter = workload ? await reconcileWorkload(work, cwd, workload) : undefined;
    if (workload) {
      assert.deepEqual(workloadAfter, workloadBefore, 'Exact authoritative fixture results must survive the observation window');
      assert.equal(metrics.projections, countersBefore.projections, 'Unchanged work must not be reprojected');
      assert.equal(metrics.logReads.bytes, countersBefore.logReads.bytes, 'Ordinary observation must not reread unchanged logs');
      (report.incrementalWindows ??= []).push({ clients: count, countersBefore, countersAfter: metrics, delta: workloadCounterDelta(countersBefore, metrics), workloadBefore, workloadAfter });
    }
    assert.equal(status.hostedSessions,2); assert.equal(inspectDaemonOwner(transport).owner.pid,owner.pid);
    const resources=after.map(value=>{ const prior=before.find(v=>v.identity.pid===value.identity.pid); assert.ok(prior,'Unexpected process appeared during steady measurement'); assert.deepEqual(value.observedIdentity, prior.observedIdentity, 'Independent probe process identity changed'); return { ...value, role: role(value.identity.pid), cpuMs:((value.cpu.user-prior.cpu.user)+(value.cpu.system-prior.cpu.system))/1000,fsRead:value.usage.fsRead-prior.usage.fsRead,fsWrite:value.usage.fsWrite-prior.usage.fsWrite }; });
    for(const client of clients) assert.equal(resources.find(value=>value.identity.pid===client.pid).connections.coordinator,0,'ordinary native frontends must not open coordinator stores');
    const mainConnections=resources.reduce((sum,v)=>sum+v.connections.coordinator,0), derivedMain=resources.reduce((sum,v)=>sum+v.connections.derived,0);
    const derivedWorker=metrics.indexConnections, coordinatorWorker=metrics.sqlite.active-derivedWorker;
    const connections={coordinator:mainConnections+coordinatorWorker,derived:derivedMain+derivedWorker};
    const managementAfter=status.backgroundManagement;
    const backgroundAfter=await work.get({background:true,cwd,sessionId:JSON.parse(readFileSync(sessionFile,'utf8').split('\n')[0]).id});
    const managementDelta=Object.fromEntries(['scopeRefreshes','reconciles'].map(key=>[key,managementAfter[key]-managementBefore[key]]));
    const registryDelta=Object.fromEntries(Object.keys(managementAfter.registry).map(key=>[key,managementAfter.registry[key]-managementBefore.registry[key]]));
    report.scenarios.push({warmup,backgroundBefore:observedLegacy,backgroundAfter,managementBefore,managementAfter,managementDelta,registryDelta,legacyRows:2,clients:count,startedAt,endedAt,elapsedMs,
      requiredProcesses, resourceBefore: before, aggregateCohorts, aggregatePeak,
      resources,connections,metrics,countersBefore,totalCpuMs:resources.reduce((s,v)=>s+v.cpuMs,0),totalRss:resources.reduce((s,v)=>s+v.rss,0),rpcMs:{p50:latencies.sort((a,b)=>a-b)[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],p99:latencies[Math.floor(latencies.length*.99)]}});
    report.measurement.coverage.aggregatePeak = report.scenarios.every(scenario => scenario.aggregatePeak.qualified);
    const scenario = report.scenarios.at(-1);
    const workerGc = resources.map(value => {
      const prior = before.find(row => row.identity.pid === value.identity.pid);
      const startThreads = prior.gcThreads, endThreads = value.gcThreads;
      const complete = startThreads?.complete && endThreads?.complete && JSON.stringify(startThreads.lifecycle) === JSON.stringify(endThreads.lifecycle)
        && JSON.stringify(startThreads.expected.slice().sort()) === JSON.stringify(endThreads.expected.slice().sort());
      if (!complete) return null;
      let gcCount = value.window.gc.count - prior.window.gc.count, durationMs = value.window.gc.durationMs - prior.window.gc.durationMs;
      for (const record of endThreads.records) {
        const start = startThreads.records.find(item => item.thread === record.thread);
        if (!start || start.startedAt !== record.startedAt || record.count < start.count || record.durationMs < start.durationMs) return null;
        gcCount += record.count - start.count; durationMs += record.durationMs - start.durationMs;
      }
      if (![gcCount,durationMs].every(value => Number.isFinite(value) && value >= 0)) return null;
      return { identity: value.identity, count: gcCount, durationMs };
    });
    scenario.workerGc = { threadCoverage: workerGc.every(Boolean) ? 'all' : 'incomplete', processes: workerGc.filter(Boolean) };
    report.measurement.coverage.workerGc = report.scenarios.every(value => value.workerGc.threadCoverage === 'all');
    if (queueAges.length) scenario.queueAge = distribution(queueAges);
    report.measurement.coverage.queueAge = report.scenarios.every(value => value.queueAge?.samples > 0);
    if (workload) {
      const publication = await measureEventPublication({ socketPath, agentDir: agent, scope: { cwd, limit: workload.group },
        metaPath: join(workload.runs, workload.tasks[0].id, 'meta.json'), taskId: workload.tasks[0].id, subscribers: count });
      scenario.eventLatency = publication.ms;
      scenario.eventPublication = publication;
      report.measurement.coverage.eventLatency = report.scenarios.every(value => value.eventLatency.samples > 0);
    }
    writeFileSync(output,JSON.stringify(report,null,2));
    assert.equal(backgroundAfter.scopeRevision,observedLegacy.scopeRevision,'Workload changed during unchanged-window measurement');
    assert.equal(managementDelta.reconciles,0,'Unchanged same-owner foregrounds must not multiply canonical reconciliation');
    assert.equal(registryDelta.fullDirectoryReads,0);assert.equal(registryDelta.terminalMetadataFileReads,0);
    assert.ok(connections.coordinator<=2,`Root coordinator budget exceeded: ${JSON.stringify(connections)}`); assert.ok(connections.derived<=2);
  }
  if (workload && process.env.PI_INCREMENTAL_MUTATIONS === '1') {
    const manifestPath = join(root, 'mutation-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(workload));
    const writer = start(new URL('./event-publication/writer.mjs', import.meta.url), [manifestPath, '--incremental-workload']);
    await message(writer, value => value.ready);
    let capabilities;
    try { capabilities = await fixtureControl(owner.pid, 'describe');
      assert.equal(capabilities.scope, 'runtime'); assert.equal(capabilities.pid, owner.pid);
      assert.ok(capabilities.actions.every(action => ['evict','restart'].includes(action)));
    } catch (error) { report.capabilityFailure = String(error); capabilities = { actions: [] }; }
    const recoveryTimes = [];
    const recovery = Object.fromEntries(capabilities.actions.map(action => [action, { scope: 'runtime', run: async () => {
      const receipt = await fixtureControl(owner.pid, action);
      assert.equal(receipt.physical?.managerPid, owner.pid, 'Recovery must act in the admitted fixture manager');
      if (action === 'restart') recoveryTimes.push(receipt.elapsedMs);
      return { ...receipt, ...(action === 'restart' ? { client: work } : {}) };
    } }]));
    const mutationState = await runMutationSequence({ manifest: workload, client: work, evidenceScope: 'runtime', recovery,
      write: async mutation => {
        const id = ++seq, pending = message(writer, value => value.id === id);
        writer.send({ id, mutation });
        const receipt = await pending; assert.equal(receipt.error, undefined, receipt.error); return receipt.result;
      },
      observe: async (mutation, receipt, before, client) => {
        await until('external mutation observed by actual source inventory', async () => {
          await client.get({ cwd, active: false, limit: 1 });
          const metrics = await client.request('runtime_get_metrics');
          if (metrics.inventories <= before.inventories) return false;
          if (['theme', 'same-settings'].includes(mutation.kind)) return true;
          try {
            const snapshot = await client.get({ id: mutation.id }), row = snapshot.rows[0];
            if (mutation.kind === 'delete-log') return snapshot.status === 'degraded' && /Log source unavailable/.test(snapshot.reason ?? '') && Boolean(row?.health?.rawLog?.error);
            if (snapshot.status !== 'ready') return false;
            return row?.display?.coverage?.complete && row.display.coverage.offset === receipt.afterBytes;
          } catch (error) { if (!/resync|state-degraded/.test(String(error))) throw error; return false; }
        });
        assert.equal(inspectDaemonOwner(transport).owner?.token, owner.token, 'Mutation must retain the exact management instance');
      },
      onState: state => {
        report.mutations = state;
        report.mutatedWorkload = structuredClone(workload);
        writeFileSync(manifestPath, JSON.stringify(workload));
        writeFileSync(output, JSON.stringify(report, null, 2));
      },
    });
    assert.ok(mutationState.complete, 'Required owned recovery capabilities are missing; dependent phases did not execute');
    report.scenarios.at(-1).recovery = distribution(recoveryTimes);
    report.measurement.coverage.recovery = report.scenarios.every(value => value.recovery?.samples > 0);
    if (writer.exitCode === null && writer.signalCode === null) {
      if (writer.connected) writer.disconnect();
      await until('owned mutation writer exit after its IPC lifetime ends', () => writer.exitCode !== null || writer.signalCode !== null);
    }
  }
  writeFileSync(join(cwd,'finish'),'done');
  const receipt=`background-terminal:${remoteLaunch.operationId}`;
  await until('exact remote native recipient receipt',()=>remotes[0].sessionManager.getBranch().some(entry=>entry.type==='custom_message'&&entry.details?.completionEventIds?.includes(receipt)));
  assert.equal(remotes[1].sessionManager.getBranch().some(entry=>entry.type==='custom_message'&&entry.details?.completionEventIds?.includes(receipt)),false,'other remote recipient must not consume completion');
  const localEntries=await (async()=>{const id=++seq,pending=message(first,m=>m.id===id);first.send({id,entries:true});return (await pending).result;})();
  assert.equal(localEntries.some(entry=>entry.type==='custom_message'&&entry.details?.completionEventIds?.includes(receipt)),false,'ordinary local recipient must not consume remote completion');
  report.mixed.exactRecipientReceipt=receipt;report.mixed.isolation=true;
  if (incremental) {
    const teardownIdentities = observed().map(value => value.identity).filter(value => value.pid !== process.pid);
    writeFileSync(join(cwd, 'release'), 'done');
    for (const remote of remotes) await remote.dispose();
    for (const [index, client] of hostedClients.entries()) await client.call({ type: 'close_session', sessionId: remotes[index].sessionId });
    for (const child of clients) if (child.connected) child.send({ stop: true });
    work.close(); for (const client of hostedClients) client.close();
    const lifecycle = readLifecycleConfig(transport);
    assert.ok(lifecycle.daemonIdleMs > 0, 'Natural hosted-runtime exit is disabled by actual lifecycle policy');
    const exitStarted = performance.now();
    const exitIdentities = [...teardownIdentities, ...report.scenarios.at(-1).resourceBefore.map(value => value.observedIdentity).filter(value => value.pid !== process.pid)];
    await until('natural exit of every owned related process including Server and guardian', () => exitIdentities.every(value => !processMatchesStart(value.pid,value.start)), lifecycle.daemonIdleMs + 30000);
    report.scenarios.at(-1).exit = distribution([performance.now() - exitStarted]);
    report.measurement.coverage.exit = report.scenarios.every(value => value.exit?.samples > 0);
  }
} catch(error) { report.failure=String(error); throw error; }
finally {
  const owned = observed().map(value => value.identity).filter(identity=>identity.pid!==process.pid);
  writeFileSync(join(cwd,'release'),'done'); writeFileSync(join(cwd,'finish'),'done');
  work?.close(); for(const remote of remotes) await remote.dispose(); for(const client of hostedClients) client.close();
  for(const child of clients) if(child.connected) child.send({stop:true});
  await delay(1000);
  for(const child of children) if(child.exitCode===null&&child.signalCode===null) child.kill('SIGTERM');
  await delay(1000);
  for (const identity of owned) if (processMatchesStart(identity.pid, identity.start)) { try { process.kill(identity.pid, 'SIGTERM'); } catch(error) { if(error.code !== 'ESRCH') throw error; } }
  await delay(500);
  for (const identity of owned) if (processMatchesStart(identity.pid, identity.start)) { try { process.kill(identity.pid, 'SIGKILL'); } catch(error) { if(error.code !== 'ESRCH') throw error; } }
  writeFileSync(output,JSON.stringify({...report,errors:errors.slice(-4000)},null,2)); console.log(`Full runtime report: ${output}`);
}
