import { monitorEventLoopDelay } from 'node:perf_hooks';
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
process.on('message', message => {
  if (message?.type !== 'resource-sample') return;
  process.send?.({ type: 'resource-sample', id: message.id, pid: process.pid,
    cpu: process.cpuUsage(), rss: process.memoryUsage().rss, usage: process.resourceUsage(),
    lag: { p50: lag.percentile(50) / 1e6, p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6 } });
  lag.reset();
});
