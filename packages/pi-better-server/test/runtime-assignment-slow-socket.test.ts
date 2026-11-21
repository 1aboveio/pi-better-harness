import test from 'node:test';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { startDaemon } from '../src/server.ts';
import { DaemonClient } from '../src/client.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// Load the standalone package at its runtime boundary. Its source is checked
// under that package's compiler settings, not the Server's strip-only settings.
const subagents = '../../pi-better-subagents/';
test('paused real Unix subscriber repairs exact assignment after backpressure and replay truncation', { timeout: 30000 }, async () => {
  const { default: extension } = await import(subagents + 'index.ts');
  const { registerAssignmentAttempt, commitAssignmentTerminal, readOutcome } = await import(subagents + 'assignment-outcomes.ts');
  const { writeMeta, runDir, logPathFor } = await import(subagents + 'registry.ts');
  const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR!;
  let turns = 0;
  const settingsManager = SettingsManager.inMemory({ defaultProvider: 'delivery-fixture', defaultModel: 'model' });
  const provider = (pi: any) => pi.registerProvider('delivery-fixture', {
    baseUrl: 'https://example.invalid', apiKey: 'offline', api: 'openai-completions',
    models: [{ id: 'model', name: 'Offline recipient', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any) {
      turns++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = { role: 'assistant', content: [{ type: 'text', text: 'Result received ' + 'x'.repeat(256 * 1024) }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message });
        for (let i = 0; i < 64; i++) stream.push({ type: 'text_delta', contentIndex: 0, delta: 'x'.repeat(64 * 1024), partial: message });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      });
      return stream;
    },
  });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, provider] });
  const transport = mkdtempSync('/tmp/p751-slow-');
  let session: any, daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: DaemonClient[] = [];
  let backpressure = 0;
  const originalWrite = Socket.prototype.write;
  // Observe the real kernel transport without replacing its buffering or writes.
  Socket.prototype.write = function (this: Socket, ...args: any[]) {
    const result = (originalWrite as any).apply(this, args);
    if (result === false && typeof args[0] === 'string' && args[0].includes('"type":"event"')) backpressure++;
    return result;
  } as typeof originalWrite;
  const connect = async () => { const client = await DaemonClient.connect(daemon!.socketPath); clients.push(client); return client; };
  try {
    await resourceLoader.reload();
    daemon = await startDaemon({ serverDir: transport, daemonIdleMs: 0, sessionIdleMs: 0,
      eventLog: { ringSize: 2, maxEvents: 4, flushMs: 0 },
      sessionOptions: { agentDir, settingsManager, resourceLoader, noTools: 'all' } });
    const slow = await connect();
    const created = await slow.request({ type: 'create_session', cwd, model: { provider: 'delivery-fixture', modelId: 'model' } });
    assert.equal(created.success, true, JSON.stringify(created));
    const sessionId = created.sessionId!;
    session = daemon.registry.get(sessionId)!.session;
    const manager = session.sessionManager;
    (slow as any).socket.pause();
    manager.appendCustomEntry('fixture', {});
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved recipient fixture' }], api: 'openai-completions', provider: 'test', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    const id = 'sa_slow_socket_outcome_1';
    const recipient = { kind: 'parent-session' as const, sessionId: manager.getSessionId(), workspace: cwd, branchId: null, goalId: null };
    const binding = { version: 1 as const, assignmentId: id, owner: { ...recipient, kind: 'worker-conversation' as const, sessionId: id }, recipient };
    registerAssignmentAttempt(binding, id);
    mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), 'retained result\n');
    const meta: any = { id, sessionId: id, status: 'failed', pid: 0, spawnPid: process.pid, cwd, startedAt: Date.now(), endedAt: Date.now(), exitCode: 1, promptPreview: 'fixture', logPath: logPathFor(id), assignment: binding, callbackOrigin: { sessionId: manager.getSessionId(), cwd }, callback: true };
    writeMeta(meta); commitAssignmentTerminal(meta);
    // Let the actual foreground observation/timer and callback batcher discover
    // and deliver the durable outcome; no synthetic workflow event or flush.
    const deadline = Date.now() + 5000;
    while (!readOutcome(meta)?.deliveryReceipt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(readOutcome(meta)?.deliveryReceipt, JSON.stringify(readOutcome(meta)));
    await session.waitForIdle();
    assert.equal(turns, 1);
    assert.ok(backpressure > 0, 'real socket writes must hit backpressure while subscriber reads are paused');
    slow.close();
    const reconnect = await connect();
    const replay = await reconnect.request({ type: 'subscribe', sessionId, sinceSeq: 0 });
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.equal(replay.data.truncated, true);
    const snapshot = await reconnect.request({ type: 'client_snapshot', sessionId });
    assert.equal(snapshot.success, true, JSON.stringify(snapshot));
    assert.ok(JSON.stringify(snapshot.data).includes(readOutcome(meta)!.eventId));
    const receipt = readOutcome(meta)!.deliveryReceipt;
    assert.ok(manager.getBranch().some((entry: any) => entry.id === receipt!.entryId));
    let tool = session.extensionRunner.getToolDefinition('subagent_result');
    let ctx = session.extensionRunner.createContext();
    const result = await tool.execute('read', { id }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.ok(readOutcome(meta)?.inspectedAt);
    assert.equal(turns, 1, 'transport reconnect must not repeat delivered model handoff');
    assert.deepEqual(readOutcome(meta)?.deliveryReceipt, receipt);
    const params = { id, outcome_revision: 1, disposition: 'consumed', note: 'Read result' };
    await tool.execute('consume', params, undefined, undefined, ctx);
    const consumed = readOutcome(meta);
    await tool.execute('replay', params, undefined, undefined, ctx);
    assert.deepEqual(readOutcome(meta), consumed);
    assert.equal(consumed?.disposition?.kind, 'consumed');
    // A second real hosted recipient receives no first-recipient outcome.
    const other = await connect();
    const otherEvents: any[] = [];
    other.onEvent(event => otherEvents.push(event));
    await resourceLoader.reload();
    const otherCreated = await other.request({ type: 'create_session', cwd, model: { provider: 'delivery-fixture', modelId: 'model' } });
    assert.equal(otherCreated.success, true, JSON.stringify(otherCreated));
    const otherSnapshot = await other.request({ type: 'client_snapshot', sessionId: otherCreated.sessionId });
    assert.equal(JSON.stringify(otherSnapshot).includes(readOutcome(meta)!.eventId), false);
    assert.equal(JSON.stringify(otherEvents).includes(readOutcome(meta)!.eventId), false);
    const otherSession = daemon.registry.get(otherCreated.sessionId!)!.session;
    const denied = await otherSession.extensionRunner!.getToolDefinition('subagent_result')!.execute('wrong-recipient', { id }, undefined, undefined, otherSession.extensionRunner!.createContext());
    assert.equal(JSON.stringify(denied).includes(readOutcome(meta)!.eventId), false);
    await assert.rejects(() => otherSession.extensionRunner!.getToolDefinition('subagent_result')!.execute('wrong-recipient-all', { id, all: true, outcome_revision: 1, disposition: 'dismissed', note: 'foreign request' }, undefined, undefined, otherSession.extensionRunner!.createContext()), /different parent/);
    assert.deepEqual(readOutcome(meta), consumed, 'foreign recipient cannot rewrite disposition');
  } finally {
    Socket.prototype.write = originalWrite;
    for (const client of clients) client.close();
    await daemon?.stop();
    rmSync(transport, { recursive: true, force: true });
  }
});
