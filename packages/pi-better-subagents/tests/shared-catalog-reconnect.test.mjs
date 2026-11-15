import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
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
