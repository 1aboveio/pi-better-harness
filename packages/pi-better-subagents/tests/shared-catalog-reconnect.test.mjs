import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { submitManagedLaunch } from '../managed-launch-client.ts';
import { connectCatalogClient } from '../shared-catalog.ts';

test('Catalog ensures a stopped runtime but never retries rejected hello', async t => {
    const root = mkdtempSync('/tmp/catalog-connect-');
    let ensures = 0, rejectHello = false;
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('data', bytes => {
            const request = JSON.parse(bytes.toString().trim());
            socket.write(JSON.stringify({ id: request.id, success: !rejectHello,
                error: 'catalog capability refused', data: { instanceId: 'server', agentDir: root } }) + '\n');
        });
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        rmSync(root, { recursive: true, force: true });
    });
    const ensure = async agentDir => {
        assert.equal(agentDir, root);
        ensures++;
        await new Promise(resolve => server.listen(join(root, 'pi-server.sock'), resolve));
    };
    const first = await connectCatalogClient(root, root, ensure);
    first.close();
    assert.equal(ensures, 1);
    const second = await connectCatalogClient(root, root, ensure);
    second.close();
    assert.equal(ensures, 1);
    rejectHello = true;
    await assert.rejects(connectCatalogClient(root, root, ensure), /capability refused/);
    assert.equal(ensures, 1);
});

test('cancelling Catalog startup releases its runtime recovery demand', { timeout: 5000 }, async t => {
    const root = realpathSync(mkdtempSync('/tmp/catalog-startup-abort-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const starting = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    const ensure = async (_agentDir, _serverDir, _timeoutMs, signal) => {
        starting.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        stopped.resolve();
    };
    const controller = new AbortController();
    const opening = connectCatalogClient(root, root, ensure, controller.signal);
    void opening.catch(() => {});
    await starting.promise;
    controller.abort();
    await assert.rejects(opening, { name: 'AbortError' });
    await stopped.promise;
});

for (const heldType of ['hello', 'runtime_register_catalog']) {
    test(`managed launch cancels while Catalog is waiting for ${heldType}`, { timeout: 5000 }, async t => {
        const root = realpathSync(mkdtempSync('/tmp/catalog-launch-abort-'));
        const prior = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = root;
        writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
        const requests = [];
        const connections = new Set();
        const held = Promise.withResolvers();
        const server = createServer(socket => {
            connections.add(socket);
            socket.on('close', () => connections.delete(socket));
            socket.on('data', bytes => {
                const request = JSON.parse(bytes.toString().trim());
                requests.push(request.type);
                if (request.type === heldType) held.resolve({ closed: once(socket, 'close') });
                else socket.write(JSON.stringify({ id: request.id, success: true, data: { instanceId: 'server' } }) + '\n');
            });
        });
        t.after(async () => {
            for (const socket of connections) socket.destroy();
            await new Promise(resolve => server.close(resolve));
            if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = prior;
            rmSync(root, { recursive: true, force: true });
        });
        server.listen(join(root, 'pi-server.sock'));
        await once(server, 'listening');
        const controller = new AbortController();
        const launch = submitManagedLaunch({}, { cwd: root }, 'cancelled', 'subagent_spawn', {}, controller.signal);
        void launch.catch(() => {});
        const { closed } = await held.promise;
        controller.abort();

        await assert.rejects(Promise.race([launch, delay(1000, 'launch still pending', { ref: false })]), { name: 'AbortError' });
        assert.notEqual(await Promise.race([closed, delay(1000, 'socket still open', { ref: false })]), 'socket still open');
        assert.deepEqual(requests, heldType === 'hello' ? ['hello'] : ['hello', 'runtime_register_catalog']);
        assert.equal(existsSync(join(root, 'subagent-launch-admission')), false);
    });
}
