import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { WorkClient } from '../src/runtime/work-client.mjs';
import { backgroundGoalObservation, backgroundObservation, closeBackgroundObservation } from '../../pi-better-background-tasks/src/work-observation.ts';

test('packed crash premise requires an actual pending operation rather than warm Goal cache', async () => {
  const socket: any = new PassThrough(), requests: any[] = [];
  let wrote: (request: any) => void;
  const written = new Promise<any>(resolve => { wrote = resolve; });
  socket.write = (line: string) => {
    const request = JSON.parse(line); requests.push(request);
    if (request.type === 'runtime_get_snapshot') wrote(request);
    if (request.type !== 'runtime_get_snapshot') queueMicrotask(() => socket.emit('data', JSON.stringify({ id: request.id, success: true, data: request.type === 'hello' ? {} : { status: 'ready', instanceId: 'owner', seq: 1, rows: [] } }) + '\n'));
    return true;
  };
  const client = new WorkClient(socket, '/agent');
  const pi: any = { events: { emit(name: string, request: any) { if (name === 'pi-better-runtime:connect') request.accept(client); } } };
  const ctx: any = { cwd: '/workspace', sessionManager: { getSessionId: () => 'parent' } };
  try {
    await backgroundGoalObservation(pi, ctx);
    const count = requests.length;
    await backgroundGoalObservation(pi, ctx);
    assert.equal(requests.length, count, 'Warm Goal remains zero-RPC');
    const interrupted = backgroundObservation(pi, ctx);
    const request = await written;
    assert.ok((client as any).pending.has(request.id), 'Supported operation has an actual pending protocol request');
    socket.emit('data', JSON.stringify({ id: request.id, success: true, data: { status: 'ready', rows: [] } }) + '\n');
    assert.equal((await interrupted).status, 'ready');
  } finally { closeBackgroundObservation(pi); client.close(); }
});
