import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const { startWorkRuntimeFixture } = await import('../../pi-better-subagents/tests/work-runtime-fixture.mjs');
const stop = await startWorkRuntimeFixture();
after(stop);

for (const hosted of [false, true]) test(`real ${hosted ? 'HostedSession' : 'local SDK'} reads and consumes the exact retained assignment`, { timeout: 30000 }, async () => {
  const { default: extension } = await import('../../pi-better-subagents/index.ts');
  const { registerAssignmentAttempt, commitAssignmentTerminal, readOutcome } = await import('../../pi-better-subagents/assignment-outcomes.ts');
  const { writeMeta, runDir, logPathFor } = await import('../../pi-better-subagents/registry.ts');
  const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR!;
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
  let session: any, host: any;
  try {
    await resourceLoader.reload();
    let manager = SessionManager.create(cwd, agentDir + '/sessions');
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' }));
    if (hosted) {
      const { HostedSession } = await import('../src/hosted-session.ts');
      const { EventLog } = await import('../src/event-log.ts');
      host = new HostedSession(session, new EventLog(agentDir + '/delivery-events.jsonl'), () => {});
      await host.bindUi();
    } else await session.bindExtensions({ mode: 'print' });
    manager.appendCustomEntry('fixture', {});
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Saved recipient fixture' }], api: 'openai-completions', provider: 'test', model: 'fixture', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    const id = hosted ? 'sa_hosted_outcome_1' : 'sa_sdk_outcome_1';
    const recipient = { kind: 'parent-session' as const, sessionId: manager.getSessionId(), workspace: cwd, branchId: null, goalId: null };
    const binding = { version: 1 as const, assignmentId: id, owner: { ...recipient, kind: 'worker-conversation' as const, sessionId: id }, recipient };
    registerAssignmentAttempt(binding, id);
    mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), 'retained result\n');
    const meta: any = { id, sessionId: id, status: 'failed', pid: 0, spawnPid: process.pid, cwd, startedAt: Date.now(), endedAt: Date.now(), exitCode: 1, promptPreview: 'fixture', logPath: logPathFor(id), assignment: binding, callbackOrigin: { sessionId: manager.getSessionId(), cwd }, callback: false };
    writeMeta(meta); commitAssignmentTerminal(meta);
    let tool = session.extensionRunner.getToolDefinition('subagent_result');
    let ctx = session.extensionRunner.createContext();
    const result = await tool.execute('read', { id }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.ok(readOutcome(meta)?.inspectedAt);
    const sessionFile = manager.getSessionFile()!;
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    if (host) await host.dispose({ abort: false }); else session.dispose();
    manager = SessionManager.open(sessionFile);
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' }));
    if (hosted) {
      const { HostedSession } = await import('../src/hosted-session.ts');
      const { EventLog } = await import('../src/event-log.ts');
      host = new HostedSession(session, new EventLog(agentDir + '/reconnected-events.jsonl'), () => {});
      await host.bindUi();
    } else await session.bindExtensions({ mode: 'print' });
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
