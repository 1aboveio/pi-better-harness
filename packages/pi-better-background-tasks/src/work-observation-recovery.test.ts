import { test, expect } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backgroundObservation, closeBackgroundObservation } from './work-observation.js';

for (const cancel of [false, true]) test(`background query survives listener gap; cancel=${cancel}`, async () => {
  const root = realpathSync(mkdtempSync('/tmp/pi-bg-gap-'));
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
  const pi = { events: { emit() {} } } as any;
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'parent' } } as any;
  const sockets = new Set<Socket>();
  let instance = 'first';
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        const data = request.type === 'hello' ? { capabilities: [] } : { instanceId: instance, seq: 1, status: 'ready', rows: [{ id: 'retained-task' }] };
        socket.write(JSON.stringify({ id: request.id, success: true, data }) + '\n');
      }
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(join(root, 'pi-server.sock'), resolve));
    expect((await backgroundObservation(pi, ctx)).instanceId).toBe('first');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance = 'replacement';
    timer = setTimeout(() => server.listen(join(root, 'pi-server.sock')), 100);
    const pending = backgroundObservation(pi, ctx);
    if (cancel) {
      closeBackgroundObservation(pi);
      await expect(pending).rejects.toThrow();
    } else {
      const result = await pending;
      expect(result.instanceId).toBe('replacement');
      expect(result.rows).toEqual([{ id: 'retained-task' }]);
    }
  } finally {
    clearTimeout(timer); closeBackgroundObservation(pi);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
