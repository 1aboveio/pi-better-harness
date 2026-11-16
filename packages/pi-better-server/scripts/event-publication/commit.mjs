import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export async function commitMetadata(path, marker, afterRename) {
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  const staged = `${path}.${process.pid}.latency.tmp`;
  writeFileSync(staged, JSON.stringify({ ...meta, name: marker }));
  const commitStartedNs = process.hrtime.bigint().toString();
  renameSync(staged, path);
  if (afterRename) await afterRename();
  const committedNs = process.hrtime.bigint().toString();
  return { marker, commitStartedNs, committedNs };
}

export function publicationObservation(commit, recipient) {
  const visible = BigInt(recipient.visibleNs), started = BigInt(commit.commitStartedNs), completed = BigInt(commit.committedNs);
  if (completed < started || visible < started) throw new Error(`Invalid source commit/visibility ordering: ${JSON.stringify({ commit, recipient })}`);
  // Matching the unique renamed marker proves causality. A writer can be descheduled
  // after rename, so its return timestamp is only an upper bound on commit time.
  return { ...recipient, latencyMs: Number(visible - started) / 1e6,
    completionDeltaMs: Number(visible - completed) / 1e6 };
}
