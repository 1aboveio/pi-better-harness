// Helpers for the command-routing comparison.
//
// Two invariants live here so the evaluator cannot regress:
// - the baseline comes from a committed fixture, never from a commit that
//   delivery may have rebased away;
// - every invocation gets its own trace file and starts it empty, so a previous
//   run's target call can never be classified as this run's decision.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function loadBaseline(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw.oldParent !== 'string' || !raw.oldParent.trim()) {
    throw new Error(`Baseline ${path} has no oldParent policy text.`);
  }
  if (typeof raw.oldWorker !== 'string' || !raw.oldWorker.trim()) {
    throw new Error(`Baseline ${path} has no oldWorker handoff text.`);
  }
  return { oldParent: raw.oldParent, oldWorker: raw.oldWorker };
}

export function jobTracePath(dir, id, runId) {
  return join(dir, `${id}.${runId}.trace.jsonl`);
}

export function resetTrace(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}
