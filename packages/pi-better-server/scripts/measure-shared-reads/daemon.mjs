import './probe.mjs';
const { startDaemon } = await import('../../src/server.ts');
const daemon = await startDaemon({ serverDir: process.env.PI_SERVER_DIR, sessionIdleMs: 0, daemonIdleMs: 0 });
process.send?.({ type: 'ready', socket: daemon.socketPath });
process.on('message', message => {
  if (message === 'stop') void daemon.stop().then(() => process.exit(0));
});
