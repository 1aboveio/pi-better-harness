import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
test('standalone native Background tools use server ownership, replay once and survive foreground exit', { timeout: 60000 }, async () => {
    const root = realpathSync(mkdtempSync('/tmp/bg-native-')), agent = join(root, 'agent'), cwd = join(root, 'workspace'), transport = join(root, 'socket');
    for (const path of [agent, cwd, transport])
        mkdirSync(path, { recursive: true });
    const sessionFile = join(root, 'session.jsonl');
    writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd }) + '\n');
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root, TMP: root, TEMP: root, LAUNCH_WORKSPACE: cwd, BACKGROUND_ONLY: '1', BACKGROUND_SESSION_FILE: sessionFile };
    let errors = '', sequence = 0;
    const children: ReturnType<typeof fork>[] = [];
    function start(url: URL) { const child = fork(url, [], { execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child); child.stdout!.resume(); child.stderr!.on('data', d => errors += d); return child; }
    const wait = (child: ReturnType<typeof fork>): Promise<any[]> => new Promise((resolve, reject) => {
        const cleanup = () => { child.off('message', message); child.off('exit', exit); child.off('error', error); };
        const message = (value: any) => { cleanup(); resolve([value]); };
        const exit = () => { cleanup(); reject(new Error(errors)); };
        const error = (value: Error) => { cleanup(); reject(value); };
        child.once('message', message);
        child.once('exit', exit);
        child.once('error', error);
    });
    let daemon = start(new URL('./support/work-daemon.ts', import.meta.url));
    let parent: ReturnType<typeof fork>;
    const call = async (tool: string, params: any, key = `native-${++sequence}`) => { const reply = wait(parent); parent.send({ id: ++sequence, key, tool, params }); const [value] = await reply; assert.equal(value.error, undefined, `${value.stack}\n${errors}`); return value.result; };
    try {
        await wait(daemon);
        writeFileSync(join(agent, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
        parent = start(new URL('../scripts/measure-full-runtime/frontend.ts', import.meta.url));
        await wait(parent);
        const marker = join(cwd, 'launches'), release = join(cwd, 'release');
        const params = { shell: false, callback: false, argv: [process.execPath, '-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'one\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('native-done')}},20)`] };
        const launched = await call('bg_task_spawn', params, 'stable-native-spawn');
        assert.ok(launched.details?.id, JSON.stringify(launched));
        const replay = await call('bg_task_spawn', params, 'stable-native-spawn');
        assert.equal(replay.details.id, launched.details.id);
        const waited = await call('wait_for_operations', { task_ids: [launched.details.id], continuation_note: 'Inspect exact result' });
        assert.ok(waited.details?.waitId, JSON.stringify(waited));
        parent.kill('SIGKILL');
        await once(parent, 'exit');
        writeFileSync(release, 'go');
        const db = new DatabaseSync(join(agent, 'operation-coordinator.sqlite'), { readOnly: true });
        try {
            const deadline = Date.now() + 15000;
            while (!db.prepare('SELECT terminal_revision FROM operations WHERE operation_id=?').get(launched.details.operationId)?.terminal_revision) {
                assert.ok(Date.now() < deadline, errors);
                await delay(50);
            }
        }
        finally {
            db.close();
        }
        parent = start(new URL('../scripts/measure-full-runtime/frontend.ts', import.meta.url));
        await wait(parent);
        const status = await call('bg_task_status', { id: launched.details.id });
        assert.match(JSON.stringify(status), /completed|succeeded/);
        const log = await call('bg_task_log', { id: launched.details.id });
        assert.match(JSON.stringify(log), /native-done/);
        assert.equal(readFileSync(marker, 'utf8'), 'one\n');
        const running = await call('bg_task_spawn', { shell: false, callback: false, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] });
        const stopped = await call('bg_task_stop', { id: running.details.id });
        assert.match(JSON.stringify(stopped), /cancel|stop/i);
        const callback = await call('bg_task_spawn', { shell: false, callback: true, argv: [process.execPath, '-e', "console.log('callback-proof')"] });
        const receiptId = `background-terminal:${callback.details.operationId}`;
        let nativeMessages: any[] = [];
        const callbackDeadline = Date.now() + 10000;
        while (!nativeMessages.length) {
            await call('bg_task_status', { id: callback.details.id });
            const pending = wait(parent);
            parent.send({ id: ++sequence, entries: true });
            const [reply] = await pending;
            nativeMessages = reply.result.filter((entry: any) => entry.type === 'custom_message' && entry.customType === 'background-completion-batch' && entry.details?.completionEventIds?.includes(receiptId));
            assert.ok(Date.now() < callbackDeadline, `Native completion receipt absent: ${JSON.stringify(reply.result)} ${errors}`);
            await delay(100);
        }
        assert.equal(nativeMessages.length, 1);
        // Legacy terminal callbacks remain obligations after UI retention and
        // process restart; the shared visible snapshot intentionally omits them.
        const legacyRelease=join(cwd,'legacy-release');
        const legacyBatch=await call('bg_task_spawn_batch',{jobs:[{shell:false,callback:true,argv:[process.execPath,'-e',`const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(legacyRelease)})){clearInterval(timer);console.log('old-legacy-result')}},20)`]}]});
        const legacyId=legacyBatch.details.launched[0].id;
        parent.kill('SIGKILL');await once(parent,'exit');writeFileSync(legacyRelease,'go');
        const legacyPath=join(root,'pi-better-background-tasks','tasks',legacyId,'meta.json');
        const legacyDeadline=Date.now()+10000;
        while(JSON.parse(readFileSync(legacyPath,'utf8')).status==='running'){assert.ok(Date.now()<legacyDeadline,errors);await delay(50);}
        daemon.kill('SIGKILL');await once(daemon,'exit');
        const legacyMeta=JSON.parse(readFileSync(legacyPath,'utf8'));legacyMeta.endedAt=Date.now()-86400000;
        delete legacyMeta.callbackSentAt;delete legacyMeta.callbackSuppressedAt;
        writeFileSync(legacyPath,JSON.stringify(legacyMeta));
        daemon=start(new URL('./support/work-daemon.ts',import.meta.url));await wait(daemon);
        parent=start(new URL('../scripts/measure-full-runtime/frontend.ts',import.meta.url));await wait(parent);
        const legacyReceipt=`background-legacy:${legacyId}:${legacyMeta.endedAt}`;
        const recoveryDeadline=Date.now()+10000;let recovered=false;
        while(!recovered){
          await call('bg_task_status',{id:legacyId});
          const pending=wait(parent);parent.send({id:++sequence,entries:true});const [reply]=await pending;
          recovered=reply.result.some((entry:any)=>entry.type==='custom_message'&&entry.customType==='background-completion-batch'&&entry.details?.completionEventIds?.includes(legacyReceipt));
          assert.ok(Date.now()<recoveryDeadline,`Old legacy callback did not recover: ${JSON.stringify(reply.result)} ${errors}`);await delay(100);
        }
        // A mandatory Background profile is re-read by the server, independent of
        // whether this native process has the optional sandbox extension loaded.
        writeFileSync(join(agent, 'settings.json'), JSON.stringify({ piBetterHarness: { sandboxPermissions: { version: 1, permissions: { main: { enabled: true, projectFiles: 'read-write', outsideProject: 'off', storedCredentials: 'off', commands: false, network: false, shell: false, processAccess: 'off', commandTimeoutSeconds: 30 }, background: { enabled: true, projectFiles: 'read-write', outsideProject: 'off', storedCredentials: 'off', commands: false, network: false, shell: false, processAccess: 'off', commandTimeoutSeconds: 30 }, subagents: { enabled: true, projectFiles: 'read-write', outsideProject: 'off', storedCredentials: 'off', commands: false, network: false, shell: false, processAccess: 'off', commandTimeoutSeconds: 30 } } } } }));
        const forbidden = join(cwd, 'forbidden');
        const refused = await call('bg_task_spawn', { shell: false, callback: false, argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'bad')`] });
        assert.equal(existsSync(forbidden), false);
        assert.match(JSON.stringify(refused), /refus|permission|unavailable|disabled/i);
    }
    finally {
        for (const child of children)
            if (child.connected)
                child.disconnect();
        for (const child of children)
            if (child.exitCode === null && child.signalCode === null)
                child.kill('SIGTERM');
    }
});
