import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { claimDaemonOwner, inspectDaemonOwner } from "../src/daemon-owner.ts";
import { runtimeRoot } from "../src/runtime/root.ts";
import { createServerArtifact, ownPackageDir } from "../src/startup/artifact.ts";
import type { RuntimePlatform } from "../src/startup/managed-types.ts";

const workspace = process.env.PI_RUNTIME_PACK_WORKSPACE ?? resolve(import.meta.dirname, "../../..");
// jiti belongs to the selected host SDK, not the eval child's working directory.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostJiti = pathToFileURL(hostRequire.resolve("jiti")).href;
mkdirSync(join(workspace, ".work"), { recursive: true });
const execute = (command: string, args: string[], cwd: string, env = process.env) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: "pipe" });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end();
});

test("packed standalone packages use one pinned socket runtime, including cached offline restart", { timeout: 900000 }, async t => {
  const evidence = mkdtempSync(join(workspace, ".work/standalone-"));
  t.diagnostic(`Retained package/socket evidence: ${evidence}`);
  const agentDir = join(evidence, "agent"), serverDir = realpathSync(mkdtempSync("/tmp/p752-"));
  const socketFixtures = [serverDir];
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SERVER_DIR: serverDir, npm_config_cache: join(workspace, ".work/npm-cache") };
  env.TMPDIR = env.TMP = env.TEMP = join(evidence, "volatile"); mkdirSync(env.TMPDIR);
  delete env.PI_SERVER_COMMAND; delete env.PI_SERVER_LAUNCHER;
  const downloadTrace = join(evidence, "node-downloads");
  if (env.PI_TEST_NODE_ARCHIVE) {
    const tools = join(evidence, "tools"); mkdirSync(tools);
    // Only the external download is substituted; the installer authenticates the official archive.
    writeFileSync(join(tools, "curl"), `#!/bin/sh\nprintf 'download\\n' >> "$PI_TEST_DOWNLOAD_TRACE"\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = -o ]; then shift; cp "$PI_TEST_NODE_ARCHIVE" "$1"; exit $?; fi\n  shift\ndone\nexit 1\n`, { mode: 0o700 });
    env.PATH = `${tools}:${env.PATH}`; env.PI_TEST_DOWNLOAD_TRACE = downloadTrace;
  }
  const stop = async () => {
    const owner = inspectDaemonOwner(serverDir);
    if (owner.status !== "live") return;
    const ended = new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (inspectDaemonOwner(serverDir).status !== "live") return resolve();
        if (Date.now() > deadline) return reject(new Error(`daemon ${owner.owner.pid} did not stop`));
        setTimeout(check, 25);
      }; check();
    });
    process.kill(owner.owner.pid, "SIGTERM"); await ended;
  };
  t.after(async () => {
    await stop();
    const log = join(serverDir, "daemon.log");
    if (existsSync(log)) writeFileSync(join(evidence, "daemon.log"), readFileSync(log));
    for (const fixture of socketFixtures) rmSync(fixture, { recursive: true, force: true });
  });
  const clients: string[] = [], archives: string[] = [], sizes: Record<string, number> = {};
  // npm prepack regenerates modules. Build in a private source copy so parallel
  // daemon tests cannot import a truncated or temporarily removed output file.
  const packWorkspace = join(evidence, "pack-workspace");
  mkdirSync(packWorkspace);
  const include = (path: string) => !["node_modules", ".work", "runtime-client"].includes(basename(path));
  for (const name of ["packages", "scripts"]) cpSync(join(workspace, name), join(packWorkspace, name), { recursive: true, filter: include });
  for (const name of ["package.json", "package-lock.json"]) cpSync(join(workspace, name), join(packWorkspace, name));
  symlinkSync(join(workspace, "node_modules"), join(packWorkspace, "node_modules"), "dir");
  for (const name of ["pi-better-subagents", "pi-better-background-tasks"]) {
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", evidence], join(packWorkspace, "packages", name), env);
    writeFileSync(join(evidence, `${name}-pack.log`), packed.stderr);
    assert.equal(packed.code, 0, packed.stderr);
    const record = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0]; sizes[name] = record.size;
    archives.push(join(evidence, record.filename));
    const install = join(evidence, name); mkdirSync(install);
    writeFileSync(join(install, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const result = await execute("npm", ["install", "--prefix", install, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(evidence, record.filename)], install, env);
    writeFileSync(join(evidence, `${name}-install.log`), result.stdout + result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(install, "node_modules/@earendil-works/pi-coding-agent")), false, "query installation needs no SDK");
    clients.push(join(install, "node_modules", name, "runtime-client/src/runtime/status-cli.mjs"));
  }
  writeFileSync(join(evidence, "package-sizes.json"), JSON.stringify(sizes, null, 2));
  const started = performance.now();
  // Exercise the real extension entrypoints before a CLI or fixture registers the root.
  const backgroundSource = join(evidence, "pi-better-background-tasks/node_modules/pi-better-background-tasks/src");
  const entryScript = `
    import assert from 'node:assert/strict';
    import {createJiti} from ${JSON.stringify(hostJiti)};
    import {pathToFileURL} from 'node:url';
    const jiti=createJiti(import.meta.url);
    const tools=new Map(); let provider;
    const pi={on(){},registerTool(t){tools.set(t.name,t)},events:{on(){return ()=>{}},emit(name,value){if(name==='pi-better-goal:register-provider')provider=value}}};
    const ctx={cwd:${JSON.stringify(evidence)},sessionManager:{getSessionId:()=> 'cold-background'}};
    const {registerTools}=await jiti.import(pathToFileURL(${JSON.stringify(join(backgroundSource, "tools.ts"))}).href);
    const {registerBackgroundTasksGoalProvider}=await jiti.import(pathToFileURL(${JSON.stringify(join(backgroundSource, "goal-provider.ts"))}).href);
    const {closeBackgroundObservation}=await jiti.import(pathToFileURL(${JSON.stringify(join(backgroundSource, "work-observation.ts"))}).href);
  `;
  const coldScript = entryScript + `
    try {
      registerTools(pi); registerBackgroundTasksGoalProvider(pi);
      const listed=await tools.get('bg_task_list').execute('cold',{},undefined,undefined,ctx);
      assert.match(listed.content[0].text,/No background tasks found \\(current session\\)/);
      const activity=await provider.getActivity(ctx); assert.deepEqual(activity.items,[]);
      const foreign=await provider.getActivity({...ctx,sessionManager:{getSessionId:()=> 'foreign'}}); assert.deepEqual(foreign.items,[]);
      console.log(JSON.stringify({list:listed,activity,foreign}));
    } finally {closeBackgroundObservation(pi)}
  `;
  const cold = await execute(process.execPath, ["--input-type=module", "-e", coldScript], workspace, env);
  writeFileSync(join(evidence, "cold-background-entry.log"), cold.stdout + cold.stderr);
  assert.equal(cold.code, 0, cold.stderr);
  const first = await execute(process.execPath, [clients[0]!], workspace, env);
  writeFileSync(join(evidence, "first-status.log"), first.stdout + first.stderr);
  assert.equal(first.code, 0, first.stderr);
  const status = JSON.parse(first.stdout);
  assert.equal(status.hostedSessions, 0); assert.equal(status.agentDir, agentDir); assert.equal(status.nodeVersion.split(".")[0], "24");
  const coldStartMs = performance.now() - started;
  const snapshotRun = join(env.TMPDIR, "pi-better-subagents/runs/sa_packed_snapshot"); mkdirSync(snapshotRun, { recursive: true });
  const snapshotMeta = { id: "sa_packed_snapshot", cwd: evidence, sessionId: "packed-worker", status: "completed", startedAt: Date.now(), name: "packed snapshot" };
  writeFileSync(join(snapshotRun, "output.log"), "");
  const snapshotPath = join(snapshotRun, "meta.json"); writeFileSync(snapshotPath, JSON.stringify(snapshotMeta));
  const packedApi = pathToFileURL(clients[0]!.replace("status-cli.mjs", "client.mjs")).href;
  const snapshotScript = `
    const {WorkClient}=await import(${JSON.stringify(packedApi)});
    const {writeFileSync}=await import('node:fs');
    const client=new WorkClient(${JSON.stringify(join(serverDir, "pi-server.sock"))}, process.env.PI_CODING_AGENT_DIR);
    const wait=predicate=>new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{off();reject(Error('snapshot update timed out'))},5000); const off=client.onChange(snapshot=>{if(predicate(snapshot)){clearTimeout(timer);off();resolve(snapshot)}}); });
    try {
      await client.subscribe({cwd:${JSON.stringify(evidence)},limit:10});
      if(client.snapshot.status==='rebuilding'||!client.snapshot.rows.some(row=>row.meta.id==='sa_packed_snapshot'))
        await wait(snapshot=>snapshot.status!=='rebuilding'&&snapshot.rows.some(row=>row.meta.id==='sa_packed_snapshot'));
      const initial=client.snapshot;
      const update=wait(snapshot=>snapshot.rows[0]?.meta.name==='external packed writer');
      writeFileSync(${JSON.stringify(snapshotPath)},JSON.stringify({...${JSON.stringify(snapshotMeta)},name:'external packed writer'}));
      const updated=await update;
      console.log(JSON.stringify({initial,updated}));
    } finally {client.close()}
  `;
  const packedSnapshot = await execute(process.execPath, ["--input-type=module", "-e", snapshotScript], workspace, env);
  writeFileSync(join(evidence, "packed-snapshot.log"), packedSnapshot.stdout + packedSnapshot.stderr);
  assert.equal(packedSnapshot.code, 0, packedSnapshot.stderr);
  const observations = JSON.parse(packedSnapshot.stdout);
  assert.equal(observations.initial.instanceId, status.instanceId);
  assert.equal(observations.initial.status, "ready");
  assert.equal(observations.initial.rows[0].assignment.state, "completed");
  assert.equal(observations.updated.rows[0].meta.name, "external packed writer");
  assert.notEqual(observations.updated.scopeRevision, observations.initial.scopeRevision);
  const alias = join(evidence, "alias"); symlinkSync(agentDir, alias);
  const second = await execute(process.execPath, [clients[1]!], workspace, { ...env, PI_CODING_AGENT_DIR: alias, PI_SERVER_DIR: join(evidence, "other-transport") });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).instanceId, status.instanceId);
  assert.equal(JSON.parse(second.stdout).serverDir, status.serverDir);
  const duplicate = join(evidence, "duplicate"); mkdirSync(duplicate);
  writeFileSync(join(duplicate, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const copy = await execute("npm", ["install", "--prefix", duplicate, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", archives[0]!], duplicate, env);
  assert.equal(copy.code, 0, copy.stderr);
  const copyStatus = await execute(process.execPath, [join(duplicate, "node_modules/pi-better-subagents/runtime-client/src/runtime/status-cli.mjs")], workspace, env);
  assert.equal(copyStatus.code, 0, copyStatus.stderr);
  assert.equal(JSON.parse(copyStatus.stdout).instanceId, status.instanceId);
  // Legacy clients may still query sessions without hello; runtime commands may not.
  const request = async (command: object) => {
    const { connect } = await import("node:net");
    const socket = connect(join(serverDir, "pi-server.sock")); socket.setEncoding("utf8");
    await once(socket, "connect"); socket.write(JSON.stringify(command) + "\n");
    const [reply] = await once(socket, "data"); socket.destroy(); return JSON.parse(String(reply));
  };
  assert.deepEqual((await request({ type: "list_sessions" })).data.sessions, []);
  assert.match((await request({ type: "runtime_get_status" })).error, /requires hello/);
  assert.match((await request({ type: "hello", protocolVersion: 1, requiredCapabilities: ["unsupported"] })).error, /capability-mismatch/);
  const { runtimeStatus } = await import("../src/runtime/client.ts");
  await assert.rejects(runtimeStatus(join(serverDir, "pi-server.sock"), agentDir, { build: { contentId: "different" } } as any), /capability-mismatch/);
  const alternativeSource = join(evidence, "alternative-build");
  cpSync(join(ownPackageDir, "src"), join(alternativeSource, "src"), { recursive: true });
  cpSync(join(ownPackageDir, "scripts/private-runtime"), join(alternativeSource, "scripts/private-runtime"), { recursive: true });
  writeFileSync(join(alternativeSource, "package.json"), JSON.stringify({ name: "incompatible-build-fixture", version: "9.0.0", type: "module" }));
  const alternative = createServerArtifact({ platform: `${process.platform}-${process.arch}` as RuntimePlatform, packageDir: alternativeSource });
  const artifactBase = join(dirname(clients[0]!), "../../artifacts", alternative.build.platform);
  const originalManifest = readFileSync(`${artifactBase}.json`), originalArchive = readFileSync(`${artifactBase}.gz`);
  const compatibleOwner = inspectDaemonOwner(serverDir);
  try {
    writeFileSync(`${artifactBase}.json`, JSON.stringify({ build: alternative.build, sha256: alternative.sha256 }));
    writeFileSync(`${artifactBase}.gz`, alternative.bytes);
    const incompatible = await execute(process.execPath, [clients[0]!], workspace, { ...env, PI_SERVER_DIR: join(evidence, "incompatible-alternate") });
    writeFileSync(join(evidence, "incompatible-status.log"), incompatible.stdout + incompatible.stderr);
    assert.notEqual(incompatible.code, 0); assert.match(incompatible.stderr, /capability-mismatch/);
    assert.deepEqual(inspectDaemonOwner(serverDir), compatibleOwner);
    assert.equal(existsSync(join(evidence, "incompatible-alternate")), false);
  } finally {
    writeFileSync(`${artifactBase}.json`, originalManifest); writeFileSync(`${artifactBase}.gz`, originalArchive);
  }
  await stop();
  // R1: durable transport registration survives both clean exit and a crashed cached connection.
  const recoveryScript = entryScript + `
    import {readFileSync,appendFileSync,existsSync} from 'node:fs';
    import {connect} from 'node:net';
    const {WorkClient,ensureRuntime}=await import(${JSON.stringify(packedApi)});
    const {inspectDaemonOwner}=await import(${JSON.stringify(new URL("../daemon-owner.mjs", pathToFileURL(clients[1]!)).href)});
    const transport=process.env.PI_SERVER_DIR;
    const registration=readFileSync(process.env.PI_CODING_AGENT_DIR+'/server-registration-v1.json','utf8');
    let observedPid;
    const trace=phase=>{
      const current=inspectDaemonOwner(transport);if(current.owner)observedPid=current.owner.pid;
      let stat;try{if(process.platform==='linux'&&observedPid)stat=readFileSync('/proc/'+observedPid+'/stat','utf8')}catch(error){stat=error.code}
      appendFileSync(${JSON.stringify(join(evidence, "recovery-timeline.jsonl"))},JSON.stringify({phase,at:Date.now(),owner:current,stat,socket:existsSync(transport+'/pi-server.sock')})+'\\n');
    };
    const probe=()=>new Promise(resolve=>{
      const socket=connect(transport+'/pi-server.sock');let buffer='';
      const finish=result=>{clearTimeout(timer);socket.destroy();appendFileSync(${JSON.stringify(join(evidence, "recovery-timeline.jsonl"))},JSON.stringify({phase:'handshake',at:Date.now(),result})+'\\n');resolve()};
      const timer=setTimeout(()=>finish({error:'probe deadline'}),2000);
      socket.on('error',error=>finish({error:error.code}));socket.on('connect',()=>socket.write(JSON.stringify({id:'probe',type:'hello',protocolVersion:1,runtimeRoot:process.env.PI_CODING_AGENT_DIR})+'\\n'));
      socket.on('data',data=>{buffer+=data;if(buffer.includes('\\n'))finish({reply:buffer.split('\\n')[0]})});
    });
    const owner=()=>{const current=inspectDaemonOwner(transport);assert.equal(current.status,'live');return current.owner};
    const stop=async()=>{const previous=owner();process.kill(previous.pid,'SIGTERM');const deadline=Date.now()+10000;
      while(inspectDaemonOwner(transport).status==='live'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
      assert.notEqual(inspectDaemonOwner(transport).status,'live');return previous.pid;};
    const listed=async(name='bg_task_list')=>{const result=await tools.get(name).execute('recovery',{action:'list'},undefined,undefined,ctx);assert.match(result.content[0].text,/No background tasks found/);};
    let paused,startupClient;
    try {
      await ensureRuntime({agentDir:process.env.PI_CODING_AGENT_DIR,serverDir:transport});
      startupClient=new WorkClient(transport+'/pi-server.sock',process.env.PI_CODING_AGENT_DIR,['runtime-client-retention-v1']);
      await startupClient.ready;
      await startupClient.request('runtime_register_client',{clientId:'packed-startup-handoff'});
      registerTools(pi);registerBackgroundTasksGoalProvider(pi);
      trace('before-first-list');await listed();trace('first-list-ready');
      await provider.getActivity(ctx);
      const handoff=await startupClient.request('runtime_get_status');
      assert.ok(handoff.livenessReasons.some(reason=>reason.kind==='connection'&&reason.id==='work-'+process.pid),'extension foreground must register its own live connection before startup handoff');
      appendFileSync(${JSON.stringify(join(evidence, "recovery-timeline.jsonl"))},JSON.stringify({phase:'foreground-handoff',at:Date.now(),instanceId:handoff.instanceId,livenessReasons:handoff.livenessReasons})+'\\n');
      startupClient.close();startupClient=undefined;
      trace('foreground-ready');await probe();const first=owner().pid;
      await stop();trace('clean-stop');assert.equal(readFileSync(process.env.PI_CODING_AGENT_DIR+'/server-registration-v1.json','utf8'),registration);
      assert.deepEqual((await provider.getActivity(ctx)).items,[]);trace('clean-recovery-ready');assert.notEqual(owner().pid,first);await listed();
      const crashed=owner().pid;process.kill(crashed,'SIGSTOP');
      const interrupted=provider.getActivity(ctx);await new Promise(r=>setImmediate(r));trace('before-kill');process.kill(crashed,'SIGKILL');trace('kill-sent');
      assert.deepEqual((await interrupted).items,[]);trace('crash-recovery-ready');assert.notEqual(owner().pid,crashed);await listed();
      await stop();closeBackgroundObservation(pi);await listed('bg_status');
      assert.equal(readFileSync(process.env.PI_CODING_AGENT_DIR+'/server-registration-v1.json','utf8'),registration);
      assert.deepEqual((await provider.getActivity({...ctx,sessionManager:{getSessionId:()=> 'foreign'}})).items,[]);
      paused=owner().pid;process.kill(paused,'SIGSTOP');closeBackgroundObservation(pi);
      await assert.rejects(listed(),/runtime-unhealthy:.*timed out/);assert.equal(owner().pid,paused);
      assert.equal(readFileSync(process.env.PI_CODING_AGENT_DIR+'/server-registration-v1.json','utf8'),registration);
      console.log(JSON.stringify({healthyRecovery:true,cachedDisconnectRecovered:true,interruptedQueryRecovered:true,liveOwnerRefused:true}));
    } catch(error) {trace('failure:'+String(error));await probe();throw error}
    finally {startupClient?.close();if(paused)process.kill(paused,'SIGCONT');closeBackgroundObservation(pi)}
  `;
  const recovery = await execute(process.execPath, ["--input-type=module", "-e", recoveryScript], workspace, env);
  writeFileSync(join(evidence, "background-recovery.log"), recovery.stdout + recovery.stderr);
  assert.equal(recovery.code, 0, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).healthyRecovery, true);
  await stop();
  const releaseOwner = claimDaemonOwner(serverDir);
  try {
    const ownerBefore = inspectDaemonOwner(serverDir);
    const backgroundRefusal = await execute(process.execPath, ["--input-type=module", "-e", entryScript + `
      try {registerTools(pi);await assert.rejects(tools.get('bg_task_list').execute('live-owner',{},undefined,undefined,ctx),/existing live owner/)}
      finally {closeBackgroundObservation(pi)}
    `], workspace, env);
    writeFileSync(join(evidence, "background-live-owner-refusal.log"), backgroundRefusal.stdout + backgroundRefusal.stderr);
    assert.equal(backgroundRefusal.code, 0, backgroundRefusal.stderr);
    assert.deepEqual(inspectDaemonOwner(serverDir), ownerBefore);
    const live = await execute(process.execPath, [clients[1]!], workspace, { ...env, PI_SERVER_DIR: join(evidence, "third-transport") });
    assert.notEqual(live.code, 0); assert.match(live.stderr, /existing live owner/);
  } finally { releaseOwner(); }
  // Execute the packed API with fetch forbidden. Cached staging must not need it.
  const api = pathToFileURL(clients[0]!.replace("status-cli.mjs", "client.mjs")).href;
  const offlineScript = `globalThis.fetch=()=>{throw Error('offline: network forbidden')}; const {ensureRuntime}=await import(${JSON.stringify(api)}); console.log(JSON.stringify(await ensureRuntime({agentDir:process.env.PI_CODING_AGENT_DIR, serverDir:process.env.PI_SERVER_DIR,offline:true})));`;
  const offline = await execute(process.execPath, ["--input-type=module", "-e", offlineScript], workspace, env);
  writeFileSync(join(evidence, "offline-status.log"), offline.stdout + offline.stderr);
  assert.equal(offline.code, 0, offline.stderr);
  if (env.PI_TEST_NODE_ARCHIVE) assert.equal(readFileSync(downloadTrace, "utf8"), "download\n", "cached startup must not download Node again");
  assert.notEqual(JSON.parse(offline.stdout).instanceId, status.instanceId);
  assert.equal(JSON.parse(offline.stdout).build.contentId, status.build.contentId);
  await stop();
  const backgroundOffline = await execute(process.execPath, [clients[1]!], workspace, { ...env, PI_OFFLINE: "1" });
  writeFileSync(join(evidence, "background-offline-status.log"), backgroundOffline.stdout + backgroundOffline.stderr);
  assert.equal(backgroundOffline.code, 0, backgroundOffline.stderr);
  const backgroundStatus = JSON.parse(backgroundOffline.stdout);
  assert.equal(backgroundStatus.build.contentId, status.build.contentId);
  assert.equal(backgroundStatus.hostedSessions, 0);
  assert.notEqual(backgroundStatus.instanceId, JSON.parse(offline.stdout).instanceId);
  if (env.PI_TEST_NODE_ARCHIVE) assert.equal(readFileSync(downloadTrace, "utf8"), "download\n");
  const liveOwner = inspectDaemonOwner(serverDir);
  assert.equal(liveOwner.status, "live");
  if (liveOwner.status !== "live") throw new Error("missing live owner");
  process.kill(liveOwner.owner.pid, "SIGSTOP");
  try {
    const unhealthy = await execute(process.execPath, [clients[1]!], workspace, { ...env, PI_SERVER_DIR: join(evidence, "unresponsive-alternate") });
    assert.notEqual(unhealthy.code, 0); assert.match(unhealthy.stderr, /runtime-unhealthy: no response/);
    assert.deepEqual(inspectDaemonOwner(serverDir), liveOwner);
    assert.equal(existsSync(join(evidence, "unresponsive-alternate")), false);
  } finally { process.kill(liveOwner.owner.pid, "SIGCONT"); }
  await stop();
  const release = join(agentDir, "managed-runtime/releases", status.build.contentId);
  const node = join(release, "node/bin/node"), savedNode = readFileSync(node);
  const domainAgent = join(evidence, "packaged-domain-agent"); mkdirSync(domainAgent);
  const domainScript = `
    const {createSubagentLaunch}=await import(${JSON.stringify(pathToFileURL(join(release, "src/runtime/subagent-launch.ts")).href)});
    const host=await createSubagentLaunch(${JSON.stringify(domainAgent)},'packaged-domain',{});
    try {
      await host.initialize();
      if(!host.status().continuationReady)throw new Error('Packaged continuation adapter unavailable');
      console.log(JSON.stringify({fixedDomainInitialized:true,status:host.status()}));
    } finally {await host.close()}
  `;
  const domain = await execute(node, ["--input-type=module", "-e", domainScript], evidence,
    { ...env, PI_CODING_AGENT_DIR: domainAgent });
  writeFileSync(join(evidence, "packaged-domain.log"), domain.stdout + domain.stderr);
  assert.equal(domain.code, 0, domain.stderr);
  assert.equal(JSON.parse(domain.stdout).fixedDomainInitialized, true,
    "the installed artifact initializes its SDK and bundled domains without repository imports");
  chmodSync(node, 0o700); writeFileSync(node, "corrupt private executable");
  try {
    const corruptNode = await execute(process.execPath, [clients[1]!], workspace, env);
    assert.notEqual(corruptNode.code, 0); assert.match(corruptNode.stderr, /Node executable integrity mismatch/);
  } finally { writeFileSync(node, savedNode); chmodSync(node, 0o500); }
  const archive = join(release, "artifact.gz"); chmodSync(archive, 0o600); writeFileSync(archive, "corrupt");
  const corrupt = await execute(process.execPath, [clients[0]!], workspace, env);
  assert.notEqual(corrupt.code, 0); assert.match(corrupt.stderr, /integrity|corrupt|artifact/i);
  assert.notEqual(inspectDaemonOwner(serverDir).status, "live");
  const uncachedTransport = realpathSync(mkdtempSync("/tmp/p752-")); socketFixtures.push(uncachedTransport);
  const missing = await execute(process.execPath, [clients[1]!], workspace, { ...env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(evidence, "uncached-agent"), PI_SERVER_DIR: uncachedTransport });
  assert.notEqual(missing.code, 0); assert.match(missing.stderr, /Offline cache miss.*connect once/);
  writeFileSync(join(evidence, "measurements.json"), JSON.stringify({ sizes, coldStartMs, nodeDownload: env.PI_TEST_NODE_ARCHIVE ? "pre-fetched official archive" : "network", status }, null, 2));
});

test("root aliases converge and a live unresponsive owner cannot be bypassed through another transport", { timeout: 10000 }, async t => {
  const evidence = mkdtempSync(join(workspace, ".work/owner-"));
  const agentDir = join(evidence, "agent"), transport = realpathSync(mkdtempSync("/tmp/p752-"));
  const root = runtimeRoot(agentDir, transport);
  symlinkSync(agentDir, join(evidence, "alias"));
  assert.deepEqual(runtimeRoot(join(evidence, "alias"), join(evidence, "alternate")), root);
  const { runtimeStatus } = await import("../src/runtime/client.ts");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(join(transport, "pi-server.sock")); await once(server, "listening");
  t.after(async () => {
    sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(transport, { recursive: true, force: true });
  });
  await assert.rejects(runtimeStatus(join(transport, "pi-server.sock"), agentDir, {} as any, 50), /runtime-unhealthy: no response/);
  assert.equal(existsSync(join(evidence, "alternate")), false);
});
