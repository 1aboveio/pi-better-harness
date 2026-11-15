import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WorkClient } from '../../src/runtime/work-client.mjs';

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) };
}
function deadline(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Event publication timeout: ${label}`)), 10000);
  })]).finally(() => clearTimeout(timer));
}
/** No snapshot polling or RPC response is counted as event visibility. */
export async function measureEventPublication({ socketPath, agentDir, scope, metaPath, taskId, subscribers, commits = 5 }) {
  const clients = [], observations = [];
  const writer = fork(new URL('./writer.mjs', import.meta.url), [metaPath], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    await deadline(once(writer, 'message'), 'external writer startup');
    for (let i = 0; i < subscribers; i++) {
      const client = new WorkClient(socketPath, agentDir); clients.push(client);
      const initial = await client.subscribe(scope);
      if (initial.status !== 'ready') {
        let off;
        try { await deadline(new Promise(resolve => { off = client.onChange(snapshot => { if (snapshot.status === 'ready') resolve(); }); }), 'subscription readiness'); }
        finally { off?.(); }
      }
    }
    for (let commit = 0; commit < commits; commit++) {
      const marker = `publication-${randomUUID()}`, removers = [];
      const visibility = clients.map((client, subscriber) => new Promise(resolve => {
        removers.push(client.onChange(snapshot => {
          if (snapshot.status === 'ready' && snapshot.rows.some(row => row.meta?.id === taskId && row.meta?.name === marker))
            resolve({ subscriber, visibleNs: process.hrtime.bigint().toString(), seq: snapshot.seq, instanceId: snapshot.instanceId });
        }));
      }));
      try {
        const committed = once(writer, 'message');
        writer.send({ marker });
        const [message, visible] = await deadline(Promise.all([committed.then(([value]) => value), Promise.all(visibility)]), 'committed change through subscription');
        observations.push({ commit, committedNs: message.committedNs, recipients: visible.map(value => ({ ...value,
          latencyMs: Number(BigInt(value.visibleNs) - BigInt(message.committedNs)) / 1e6 })) });
      } finally { removers.forEach(remove => remove()); }
    }
    const values = observations.flatMap(item => item.recipients.map(value => value.latencyMs));
    return { boundary: 'external atomic metadata commit to matching real Unix subscription event', subscribers, commits,
      healthyBudgetMs: 1000, ms: distribution(values), observations };
  } finally {
    clients.forEach(client => client.close());
    if (writer.exitCode === null && writer.signalCode === null) { const exit = once(writer, 'exit'); writer.kill('SIGTERM'); await exit; }
  }
}
