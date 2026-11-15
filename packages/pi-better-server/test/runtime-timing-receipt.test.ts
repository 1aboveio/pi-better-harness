import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const subagentDomain = '../../pi-better-subagents/';
const { startWorkRuntimeFixture } = await import(subagentDomain + 'tests/work-runtime-fixture.mjs');
const stop = await startWorkRuntimeFixture();
after(stop);

for (const hosted of [false, true]) test(`real ${hosted ? 'HostedSession' : 'local SDK'} replays retained timing notification to its native recipient`, { timeout: 30000 }, async () => {
  const { default: extension } = await import(subagentDomain + 'index.ts');
  const { registerAssignmentAttempt, commitAssignmentTerminal, readOutcome } = await import(subagentDomain + 'assignment-outcomes.ts');
  const { writeMeta, readMeta, runDir, logPathFor } = await import(subagentDomain + 'registry.ts');
  const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR!;
  let api: any, turns = 0;
  const settingsManager = SettingsManager.inMemory({ defaultProvider: 'delivery-fixture', defaultModel: 'model' });
  const provider = (pi: any) => pi.registerProvider('delivery-fixture', {
    baseUrl: 'https://example.invalid', apiKey: 'offline', api: 'openai-completions',
    models: [{ id: 'model', name: 'Offline recipient', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any) {
      turns++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = { role: 'assistant', content: [{ type: 'text', text: 'Result received' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      });
      return stream;
    },
  });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [pi => { api = pi; extension(pi); }, provider] });
  let session: any, host: any;
  try {
    await resourceLoader.reload();
    let manager = SessionManager.create(cwd, agentDir + '/sessions');
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' }));
    await session.setModel(session.extensionRunner.createContext().modelRegistry.find('delivery-fixture', 'model'));
    if (hosted) {
      const { HostedSession } = await import('../src/hosted-session.ts');
      const { EventLog } = await import('../src/event-log.ts');
      host = new HostedSession(session, new EventLog(agentDir + '/delivery-events.jsonl', { ringSize: 2, maxEvents: 4, flushMs: 0 }), () => {});
      await host.bindUi();
    } else await session.bindExtensions({ mode: 'print' });
    await session.setModel(session.extensionRunner.createContext().modelRegistry.find('delivery-fixture', 'model'));
    manager.appendCustomEntry('fixture', {});
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved recipient fixture' }], api: 'openai-completions', provider: 'test', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    const id = hosted ? 'sa_hosted_timing_1' : 'sa_sdk_timing_1';
    const recipient = { kind: 'parent-session' as const, sessionId: manager.getSessionId(), workspace: cwd, branchId: null, goalId: null };
    const binding = { version: 1 as const, assignmentId: id, owner: { ...recipient, kind: 'worker-conversation' as const, sessionId: id }, recipient };
    registerAssignmentAttempt(binding, id);
    mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), 'retained result\n');
    const meta: any = { id, sessionId: id, status: 'failed', pid: 0, spawnPid: process.pid, cwd, startedAt: Date.now(), endedAt: Date.now(), exitCode: 1, promptPreview: 'fixture', logPath: logPathFor(id), timing: { graceMs: 0, pendingWakes: [{ kind: "deadline", key: "deadline", content: "Retained timing notification fixture" }] }, assignment: binding, callbackOrigin: { sessionId: manager.getSessionId(), cwd }, callback: true };
    writeMeta(meta); commitAssignmentTerminal(meta);
    const deadline = Date.now() + 5000;
    while (!readOutcome(meta)?.deliveryReceipt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(readOutcome(meta)?.deliveryReceipt, JSON.stringify(readOutcome(meta)));
    await session.waitForIdle();
    const { timingWakeReceipt, removeTimingReceipt } = await import(subagentDomain + 'timing-notifications.ts');
    const timingDeadline = Date.now() + 8000;
    while (timingWakeReceipt(id, 'deadline') === undefined && Date.now() < timingDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(timingWakeReceipt(id, 'deadline'));
    await session.waitForIdle();
    assert.equal(turns, 2);
    if (host) {
      // The receiver has read nothing throughout delivery and model completion.
      // Its cursor now predates retained events; native snapshot repairs the gap.
      const delayed = host.subscribe(0, () => {});
      assert.equal(delayed.replay.truncated, true);
      delayed.unsubscribe();
      assert.match(JSON.stringify(await host.clientSnapshot()), new RegExp(readOutcome(meta)!.eventId));
    }
    const receipt = readOutcome(meta)!.deliveryReceipt;
    assert.ok(manager.getBranch().some((entry: any) => entry.id === receipt!.entryId));
    let tool = session.extensionRunner.getToolDefinition('subagent_result');
    let ctx = session.extensionRunner.createContext();
    const result = await tool.execute('read', { id }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.ok(readOutcome(meta)?.inspectedAt);
    const sessionFile = manager.getSessionFile()!;
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    if (host) await host.dispose({ abort: false }); else session.dispose();
    removeTimingReceipt(id, 'deadline'); // Crash after native handoff, before durable receipt.
    // A terminal run retains a new notice while its recipient is disconnected.
    const disconnected = readMeta(id)!;
    disconnected.timing!.pendingWakes!.push({ kind: 'stuck', key: 'stuck:1', content: 'Retained while recipient was disconnected' });
    writeMeta(disconnected);
    assert.equal(timingWakeReceipt(id, 'stuck:1'), undefined);
    manager = SessionManager.open(sessionFile);
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' }));
    await session.setModel(session.extensionRunner.createContext().modelRegistry.find('delivery-fixture', 'model'));
    if (hosted) {
      const { HostedSession } = await import('../src/hosted-session.ts');
      const { EventLog } = await import('../src/event-log.ts');
      host = new HostedSession(session, new EventLog(agentDir + '/delivery-events.jsonl', { ringSize: 2, maxEvents: 4, flushMs: 0 }), () => {});
      await host.bindUi();
    } else await session.bindExtensions({ mode: 'print' });
    assert.deepEqual(readOutcome(meta)?.deliveryReceipt, receipt);
    const reconnectDeadline = Date.now() + 8000;
    while (timingWakeReceipt(id, 'stuck:1') === undefined && Date.now() < reconnectDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(timingWakeReceipt(id, 'stuck:1'));
    assert.ok(timingWakeReceipt(id, 'deadline'), 'native transcript repairs a missing receipt without redelivery');
    await session.waitForIdle();
    assert.equal(turns, 3, 'reconnect delivers only the newly pending notice, never the earlier timing or outcome handoff');
    tool = session.extensionRunner.getToolDefinition('subagent_result');
    ctx = session.extensionRunner.createContext();
    const params = { id, outcome_revision: 1, disposition: 'consumed', note: 'Read result' };
    await tool.execute('consume', params, undefined, undefined, ctx);
    const consumed = readOutcome(meta);
    await tool.execute('replay', params, undefined, undefined, ctx);
    assert.deepEqual(readOutcome(meta), consumed);
    assert.equal(consumed?.disposition?.kind, 'consumed');
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); if (host) await host.dispose({ abort: false }); else session.dispose(); }
  }
});
