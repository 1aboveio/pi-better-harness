import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection, type Socket } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { WorkQueries } from '../src/runtime/queries.ts';
const { publicationObservation } = await import(String('../scripts/event-publication/commit.mjs'));

test('unique committed content reaches real socket subscribers before a descheduled writer records rename completion', { timeout: 15000 }, async t => {
  const parent = resolve('../../.work/804/tmp'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'publication-'));
  const id = 'sa_controlled_commit', run = join(root, 'runs', id), path = join(run, 'meta.json');
  mkdirSync(run, { recursive: true });
  writeFileSync(path, JSON.stringify({ id, cwd: root, status: 'completed', startedAt: 1, endedAt: 2, name: 'original' }));
  const model = new WorkReadModel(root, 'controlled-publication', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000 });
  const peers: Socket[] = [], queries: WorkQueries[] = [];
  const server = createServer(socket => {
    peers.push(socket);
    const query = new WorkQueries(model, socket); queries.push(query);
    query.handle({ type: 'runtime_subscribe', scope: { cwd: root } });
    socket.write('{"subscribed":true}\n');
  });
  const socketPath = join(root, 'events.sock');
  try {
    await model.reconcile();
    server.listen(socketPath); await once(server, 'listening');
    for (const count of [1, 5, 10]) {
      const marker = `controlled-${randomUUID()}`, clients: Socket[] = [];
      const visible = [];
      for (let subscriber = 0; subscriber < count; subscriber++) {
        const socket = createConnection(socketPath); clients.push(socket); peers.push(socket);
        let ready!: () => void;
        const subscribed = new Promise<void>(resolve => { ready = resolve; });
        visible.push(new Promise<any>(resolve => {
          let buffer = '';
          socket.on('data', chunk => {
            buffer += chunk;
            for (;;) {
              const end = buffer.indexOf('\n'); if (end < 0) break;
              const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
              if (frame.subscribed) ready();
              const snapshot = frame.event?.snapshot;
              if (snapshot?.status === 'ready' && snapshot.rows.some((row: any) => row.meta.id === id && row.meta.name === marker))
                resolve({ subscriber, visibleNs: process.hrtime.bigint().toString(), seq: snapshot.seq, instanceId: snapshot.instanceId });
            }
          });
        }));
        await subscribed;
      }
      const writer = fork(new URL('./support/controlled-publication-writer.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      try {
        await once(writer, 'message');
        const renamed = once(writer, 'message'); writer.send({ path, marker }); await renamed;
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).name, marker);
        const before = model.metrics;
        model.fileHint(run, 'meta.json');
        const recipients = await Promise.all(visible);
        const committed = once(writer, 'message'); writer.send('release');
        const [commit] = await committed;
        const measurements = recipients.map(recipient => publicationObservation(commit, recipient));
        assert.ok(measurements.every(value => value.completionDeltaMs < 0), 'the original post-rename delta deterministically reproduces the CI failure');
        assert.throws(() => assert.ok(measurements[Math.floor(count / 2)].completionDeltaMs >= 0, 'Event visibility must follow the source commit'), /Event visibility/);
        assert.ok(measurements.every(value => value.latencyMs >= 0 && value.latencyMs <= 1000));
        assert.equal(model.snapshot({ id }).rows[0]!.meta.name, marker);
        assert.ok(model.metrics.metadataReads - before.metadataReads <= 1, 'subscriber count does not multiply changed-source reads');
        assert.throws(() => publicationObservation(commit, { visibleNs: (BigInt(commit.commitStartedNs) - 1n).toString() }), /ordering/);
        t.diagnostic(JSON.stringify({ subscribers: count, commit, recipients: measurements,
          metadataReads: model.metrics.metadataReads - before.metadataReads,
          candidate: createHash('sha256').update(readFileSync(new URL('../scripts/event-publication/commit.mjs', import.meta.url))).digest('hex') }));
      } finally {
        if (writer.exitCode === null && writer.signalCode === null) { const exit = once(writer, 'exit'); writer.kill(); await exit; }
        clients.forEach(socket => socket.destroy());
      }
    }
  } finally {
    queries.forEach(query => query.close()); peers.forEach(socket => socket.destroy());
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await model.close(); rmSync(root, { recursive: true, force: true });
  }
});
