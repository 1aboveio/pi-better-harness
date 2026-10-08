import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [sdkRoot, countText] = process.argv.slice(2);
const count = Number(countText);
assert.ok(Number.isInteger(count) && count > 0);
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const envAtStart = JSON.stringify(process.env);
const startImport = performance.now();
const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
const importMs = performance.now() - startImport;
const seen = new WeakSet();
const ids = new Set();
const samples = [];

for (let index = 0; index < count; index++) {
  // Keep process cwd/env fixed; erase disk state before each measured fresh creation.
  if (index > 0) {
    rmSync(agentDir, { recursive: true, force: true });
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'auth.json'), '{}');
    writeFileSync(join(agentDir, 'settings.json'), '{}');
  }
  assert.equal(process.cwd(), cwd);
  assert.equal(JSON.stringify(process.env), envAtStart);
  const start = performance.now();
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const runtimeMs = performance.now() - start;
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  // CLI createAgentSessionServices refreshes again after loading resources.
  await modelRuntime.refresh({ allowNetwork: false });
  const resourcesMs = performance.now() - start - runtimeMs;
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  const { session } = await sdk.createAgentSession({
    cwd, agentDir, modelRuntime, settingsManager, resourceLoader, sessionManager,
    tools: ['read', 'bash', 'edit', 'write'],
  });
  try {
    await session.bindExtensions({});
    const createMs = performance.now() - start - runtimeMs - resourcesMs;
    const readyMs = performance.now() - start;
    if (count === 1) process.stdout.write(`${JSON.stringify({ type: 'benchmark_sdk_readiness', sessionId: session.sessionId })}\n`);
    assert.equal(session.messages.length, 0);
    assert.equal(session.model.provider, 'unknown');
    assert.equal(session.model.id, 'unknown');
    assert.equal(session.model.contextWindow, 0);
    assert.equal(session.sessionFile, undefined);
    assert.equal(session.isStreaming, false);
    assert.deepEqual(session.getActiveToolNames().sort(), ['bash', 'edit', 'read', 'write']);
    assert.deepEqual(resourceLoader.getExtensions().extensions, []);
    assert.deepEqual(resourceLoader.getSkills().skills, []);
    assert.deepEqual(resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(await modelRuntime.listCredentials(), []);
    assert.equal(modelRuntime.getAvailableSnapshot().length, 0);
    assert.equal(modelRuntime.getError(), undefined);
    for (const value of [settingsManager, modelRuntime, modelRuntime.credentials, modelRuntime.models,
      resourceLoader, sessionManager, session, session.agent, ...session.agent.state.tools]) {
      assert.equal(seen.has(value), false, 'fresh per-session objects, not shared runtime/auth/tools');
      seen.add(value);
    }
    assert.equal(ids.has(session.sessionId), false);
    ids.add(session.sessionId);
    assert.equal(process.cwd(), cwd);
    assert.equal(JSON.stringify(process.env), envAtStart);
    samples.push({ index, pid: process.pid, importMs: index === 0 ? importMs : 0,
      runtimeMs, resourcesMs, createAndBindMs: createMs, readyMs,
      importPlusReadyMs: readyMs + (index === 0 ? importMs : 0),
      sessionId: session.sessionId, state: { messageCount: 0, model: session.model, isStreaming: false,
        sessionFile: null, tools: session.getActiveToolNames() },
      privateAgentFiles: readdirSync(agentDir), checks: 'fresh objects/IDs, empty history/auth, no model, fixed cwd/env' });
  } finally {
    session.dispose();
    await settingsManager.flush();
  }
}
assert.deepEqual(globalThis.__startupNetworkAttempts, []);
process.stdout.write(`${JSON.stringify({ type: 'benchmark_sdk_ready', pid: process.pid,
  sdkVersion: sdk.VERSION, nodeVersion: process.version, execPath: process.execPath,
  cwd, agentDir, importMs, samples })}\n`);
