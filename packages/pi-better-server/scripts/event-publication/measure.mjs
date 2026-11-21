import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { WorkClient } from '../../src/runtime/work-client.mjs';
import { publicationObservation } from './commit.mjs';

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

/** Observe a delivered violation after timing ends; never poll or repair it. */
export async function publicationBudgetDiagnostic(observation, diagnostics) {
  if (!observation.recipients.some(recipient => recipient.latencyMs > 1000)) return;
  try { return { component: await diagnostics?.() }; }
  catch (error) { return { diagnosticError: String(error) }; }
}
/** No snapshot polling or RPC response is counted as event visibility. */
export async function measureEventPublication({ socketPath, agentDir, scope, metaPath, taskId, subscribers, commits = 5, phase, diagnostics }) {
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
      let acknowledgement;
      try {
        const committed = once(writer, 'message');
        writer.send({ marker });
        const [message, visible] = await deadline(Promise.all([committed.then(([value]) => { acknowledgement = value; return value; }), Promise.all(visibility)]), 'committed change through subscription');
        if (message.marker !== marker) throw new Error('External writer acknowledged a different source commit');
        const observation = { commit, marker, commitStartedNs: message.commitStartedNs, committedNs: message.committedNs,
          recipients: visible.map(value => publicationObservation(message, value)) };
        observations.push(observation);
        const failure = await publicationBudgetDiagnostic(observation, diagnostics);
        if (failure) {
          observation.failure = failure;
          console.error(`Event publication budget failure: ${JSON.stringify({ phase, ...observation }).slice(0, 32768)}`);
        }
      } catch (error) {
        // Capture only after failure; RPC responses never satisfy the visibility assertion.
        const row = value => ({ status: value?.status, reason: value?.reason, seq: value?.seq, scopeRevision: value?.scopeRevision,
          row: value?.rows?.find(row => row.meta?.id === taskId) });
        const report = { phase, commit, marker, acknowledgement, subscriptions: clients.map(client => row(client.snapshot)) };
        try {
          const info = statSync(metaPath, { bigint: true });
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          report.file = { id: meta.id, name: meta.name, identity: `${info.dev}:${info.ino}`, size: String(info.size), mtimeNs: String(info.mtimeNs) };
          report.freshQuery = row(await clients[0].get(scope));
          report.component = await diagnostics?.();
        } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
        console.error(`Event publication failure: ${JSON.stringify(report).slice(0, 32768)}`);
        throw error;
      } finally { removers.forEach(remove => remove()); }
    }
    const values = observations.flatMap(item => item.recipients.map(value => value.latencyMs));
    return { boundary: 'external atomic metadata commit to matching real Unix subscription event',
      latencyBound: 'conservative upper bound from immediately before atomic rename; completionDeltaMs retains the signed post-rename timestamp delta', subscribers, commits,
      healthyBudgetMs: 1000, ms: distribution(values), observations };
  } finally {
    clients.forEach(client => client.close());
    if (writer.exitCode === null && writer.signalCode === null) { const exit = once(writer, 'exit'); writer.kill('SIGTERM'); await exit; }
  }
}
