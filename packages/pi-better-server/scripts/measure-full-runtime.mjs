import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { inspectDaemonOwner, processMatchesStart } from '../src/daemon-owner.ts';
import { WorkClient } from '../src/runtime/work-client.mjs';
import { DaemonClient } from '../src/client.ts';
const root = realpathSync(mkdtempSync('/tmp/p751-full-')), agent = join(root, 'agent'), transport = join(root, 's'), cwd = join(root, 'workspace'), samples = join(root, 'samples');
for (const path of [agent, transport, cwd, samples, join(agent, 'agents/roles')]) mkdirSync(path, { recursive: true });
const probe = new URL('./measure-full-runtime/probe.mjs', import.meta.url).href;
const execPath = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath;
const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root, TMP: root, TEMP: root, PI_RESOURCE_REPORT_DIR: samples,
  NODE_OPTIONS: `--import ${probe}`, LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: join(cwd, 'entered'), LAUNCH_RELEASE: join(cwd, 'release'), PI_OFFLINE: '1' };
writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'offline-fixture' } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ piBetterHarness: { subagents: { providerExtensions: { openai: fileURLToPath(new URL('../test/support/subagent-offline-model.ts', import.meta.url)) }, defaultTools: 'read', maxConcurrent: 1 } } }));
writeFileSync(join(agent, 'agents/roles/fixture.md'), '---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4.1\n---\nOffline resource fixture.\n');
let errors = '', seq = 0; const children = [], clients = [];
const report = { root, platform: process.platform, node: process.version, scope: 'Actual guardian, server, SDK Pi clients, managed worker, Background runner/command, two HostedSessions; sampler overhead included', scenarios: [] };
const output = process.env.PI_FULL_RUNTIME_REPORT ?? join(root, 'report.json');
function start(url) { const child = fork(url, [], { execPath, execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child); child.stdout.resume(); child.stderr.on('data', d => { errors += d; }); return child; }
async function until(label, fn, timeout = 30000) { const deadline = Date.now()+timeout; while (Date.now()<deadline) { const value = await fn(); if (value) return value; await delay(25); } throw new Error(`${label} timed out: ${errors.slice(-4000)}`); }
function message(child, predicate) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error(`IPC timeout: ${errors.slice(-2000)}`)); }, 30000); const on = value => { if (predicate(value)) { cleanup(); resolve(value); } }; const exit = () => { cleanup(); reject(new Error(`Child exited: ${errors}`)); }; function cleanup() { clearTimeout(timer); child.off('message', on); child.off('exit', exit); } child.on('message', on); child.once('exit', exit); }); }
async function call(child, tool, params, key = `resource-${++seq}`) { const id = ++seq, pending = message(child, m => m.id === id); child.send({ id, key, tool, params }); const reply = await pending; assert.equal(reply.error, undefined, reply.stack); return reply.result; }
function observed() { return readdirSync(samples).filter(name => name.endsWith('.json')).flatMap(name => { try { const value = JSON.parse(readFileSync(join(samples,name),'utf8')); return processMatchesStart(value.identity.pid,value.identity.start) ? [value] : []; } catch { return []; } }); }
let guardian, work, hosted;
try {
  guardian = start(new URL('../src/cli.ts', import.meta.url));
  const owner = await until('server owner', () => { const v = inspectDaemonOwner(transport); return v.status === 'live' && v.owner; });
  await until('socket', async () => { try { work = new WorkClient(join(transport,'pi-server.sock'), agent); await work.ready; return true; } catch { work?.close(); return false; } });
  writeFileSync(join(agent,'server-registration-v1.json'), JSON.stringify({ version:1, agentDir:agent, serverDir:transport }));
  hosted = await DaemonClient.connect(join(transport,'pi-server.sock'));
  for (let i=0;i<2;i++) { const result = await hosted.call({ type:'create_session', cwd, model:{ provider:'openai', modelId:'gpt-4.1' } }); assert.ok(result.sessionId); }
  const first = start(new URL('./measure-full-runtime/frontend.ts', import.meta.url)); await message(first,m=>m.ready); clients.push(first);
  const launch = await call(first,'subagent_spawn',{ prompt:'Execute fixture',role:'fixture',model:'openai/gpt-4.1',callback:false,tools:'read',skills:[] });
  assert.equal(launch.details.launched,true,JSON.stringify(launch));
  const metaPath = join(root,'pi-better-subagents/runs',launch.details.runId,'meta.json');
  const worker = JSON.parse(readFileSync(metaPath,'utf8'));
  await until('worker entered', () => { try { return JSON.parse(readFileSync(env.LAUNCH_ENTERED,'utf8')); } catch { return false; } });
  const bg = await call(first,'bg_task_spawn',{ shell:false,callback:true,argv:[execPath,'-e',`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(cwd,'command-pid'))},String(process.pid));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(cwd,'finish'))})){clearInterval(t);console.log('done')}},50)`] });
  assert.ok(bg.details?.id,JSON.stringify(bg));
  const db = new (await import('node:sqlite')).DatabaseSync(join(agent,'operation-coordinator.sqlite'),{readOnly:true});
  const grant = JSON.parse(db.prepare("SELECT value FROM coordinator_state WHERE key=?").get(`result-supervision-v1:${bg.details.operationId}`).value); db.close();
  const claim = await until('runner claim', () => { try { return JSON.parse(readFileSync(join(grant.directory,'tasks',bg.details.id,'claim.json'),'utf8')); } catch { return false; } });
  await work.request('runtime_cancellation_status');
  for (const count of [1,5,10]) {
    while(clients.length<count) { const child=start(new URL('./measure-full-runtime/frontend.ts',import.meta.url)); await message(child,m=>m.ready); clients.push(child); }
    await work.get({cwd,active:true}); await delay(1200);
    writeFileSync(join(samples, 'generation'), String(count)); await delay(500);
    const commandPid = Number(readFileSync(join(cwd,'command-pid'),'utf8'));
    const before=observed(), required=[owner.pid,guardian.pid,worker.pid,claim.pid,commandPid,...clients.map(c=>c.pid)];
    const role = pid => pid===owner.pid ? 'server' : pid===guardian.pid ? 'guardian' : pid===worker.pid ? 'worker' : pid===claim.pid ? 'runner' : pid===commandPid ? 'command' : 'pi';
    for(const pid of required) assert.ok(before.some(v=>v.identity.pid===pid),`Missing instrumented actual process ${pid}`);
    const start=performance.now(), latencies=[]; const duration=count===10?60000:3000;
    while(performance.now()-start<duration) { const began=performance.now(); await work.request('runtime_get_status'); latencies.push(performance.now()-began); await delay(100); }
    const after=observed(), metrics=await work.request('runtime_get_metrics'), status=await work.request('runtime_get_status');
    assert.equal(status.hostedSessions,2); assert.equal(inspectDaemonOwner(transport).owner.pid,owner.pid);
    const resources=after.map(value=>{ const prior=before.find(v=>v.identity.pid===value.identity.pid); assert.ok(prior,'Unexpected process appeared during steady measurement'); return { ...value, role: role(value.identity.pid), cpuMs:((value.cpu.user-prior.cpu.user)+(value.cpu.system-prior.cpu.system))/1000,fsRead:value.usage.fsRead-prior.usage.fsRead,fsWrite:value.usage.fsWrite-prior.usage.fsWrite }; });
    const mainConnections=resources.reduce((sum,v)=>sum+v.connections.coordinator,0), derivedMain=resources.reduce((sum,v)=>sum+v.connections.derived,0);
    const derivedWorker=metrics.indexConnections, coordinatorWorker=metrics.sqlite.active-derivedWorker;
    const connections={coordinator:mainConnections+coordinatorWorker,derived:derivedMain+derivedWorker};
    report.scenarios.push({clients:count,elapsedMs:performance.now()-start,resources,connections,metrics,totalCpuMs:resources.reduce((s,v)=>s+v.cpuMs,0),totalRss:resources.reduce((s,v)=>s+v.rss,0),rpcMs:{p50:latencies.sort((a,b)=>a-b)[Math.floor(latencies.length*.5)],p95:latencies[Math.floor(latencies.length*.95)],p99:latencies[Math.floor(latencies.length*.99)]}});
    writeFileSync(output,JSON.stringify(report,null,2));
    assert.ok(connections.coordinator<=2,`Root coordinator budget exceeded: ${JSON.stringify(connections)}`); assert.ok(connections.derived<=2);
  }
} catch(error) { report.failure=String(error); throw error; }
finally {
  const owned = observed().map(value => value.identity);
  writeFileSync(join(cwd,'release'),'done'); writeFileSync(join(cwd,'finish'),'done');
  work?.close(); hosted?.close();
  for(const child of clients) if(child.connected) child.send({stop:true});
  await delay(1000);
  for(const child of children) if(child.exitCode===null&&child.signalCode===null) child.kill('SIGTERM');
  await delay(1000);
  for (const identity of owned) if (processMatchesStart(identity.pid, identity.start)) { try { process.kill(identity.pid, 'SIGTERM'); } catch(error) { if(error.code !== 'ESRCH') throw error; } }
  await delay(500);
  for (const identity of owned) if (processMatchesStart(identity.pid, identity.start)) { try { process.kill(identity.pid, 'SIGKILL'); } catch(error) { if(error.code !== 'ESRCH') throw error; } }
  writeFileSync(output,JSON.stringify({...report,errors:errors.slice(-4000)},null,2)); console.log(`Full runtime report: ${output}`);
}
