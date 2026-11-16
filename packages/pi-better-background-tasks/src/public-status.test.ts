import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerTools } from './tools.js';
import { registerObservedWaitClient } from './observed-waits.js';
import { waitForPublicStatus } from './test-support/public-status.js';
import type { DurableTaskProjection } from './observed-waits.js';

it('public status observation waits for structured authoritative terminal evidence, not formatted response JSON', async () => {
  let calls = 0;
  const task = { id: 'bgs_component', kind: 'process', status: 'succeeded', terminal: true,
    terminalRevision: 1, terminalOutcome: 'succeeded', exitCode: 0, signal: null } as DurableTaskProjection;
  const tools = new Map<string, any>();
  const pi: any = { events: new EventEmitter(), on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
  registerObservedWaitClient(pi, {
    isDurableTask: () => true,
    async settledStatusForParent() {
      calls++;
      if (calls === 1) throw new Error('Terminal runner evidence is awaiting authoritative server import; supervision is unavailable.');
      return { taskId: task.id, ...task };
    },
    readDurableTask: () => task,
    formatStatus: () => 'succeeded',
  } as any);
  registerTools(pi, undefined, () => undefined, { resumeLocal: false });
  const ctx: any = { cwd: '/component', sessionManager: { getSessionId: () => 'component' } };
  const harness = {
    async execute(name: string, params: Record<string, unknown>) {
      expect(name).toBe('bg_task_status'); expect(params).toEqual({ id: task.id, verbose: true });
      const result = await tools.get(name).execute('component', params, undefined, undefined, ctx);
      const text = result.content[0].text;
      if (calls === 1) expect(text).toBe('Terminal runner evidence is awaiting authoritative server import; supervision is unavailable.');
      return text;
    },
    readDurableTask() { return calls === 1 ? { ...task, terminalRevision: 0 } : task; },
  };
  const result = await waitForPublicStatus(harness, task.id, status => status.status === 'succeeded');
  expect(calls).toBe(2);
  expect(result).toMatchObject({ id: task.id, kind: 'process', status: 'succeeded', terminalRevision: 1,
    terminalOutcome: 'succeeded', exitCode: 0, signal: null });
});

it('does not accept uncommitted structured terminal state or exceed the original 5000ms window', async () => {
  vi.useFakeTimers();
  try {
    const task = { id: 'component', status: 'succeeded', terminalRevision: 0 } as DurableTaskProjection;
    const harness = { execute: vi.fn(async () => 'Terminal runner evidence is awaiting authoritative server import; supervision is unavailable.'),
      readDurableTask: () => task };
    const result = waitForPublicStatus(harness, task.id, () => true);
    const rejected = expect(result).rejects.toThrow('did not reach expected golden-path state');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(harness.execute).toHaveBeenCalledTimes(100);
  } finally { vi.useRealTimers(); }
});

it('retains an actual public request failure rather than returning a cached successful projection', async () => {
  const failure = new Error('runtime-unhealthy: runtime_background_tool timed out');
  await expect(waitForPublicStatus({ execute: async () => { throw failure; },
    readDurableTask: () => ({ status: 'succeeded', terminalRevision: 1 } as DurableTaskProjection) }, 'component', () => true)).rejects.toBe(failure);
});
