import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';

interface Attempt {
  id: string; sessionId?: string; cwd: string; resumedFrom?: string;
  operations?: { resumeLaunchToken?: string };
  assignment?: { assignmentId?: string };
}
type Graph = Map<string, Set<string>>;

/** Index resume edges once; each invalidated component is visited at most once per scope. */
export async function affectedAttempts(related: Iterable<Attempt>, changed: Iterable<Attempt>): Promise<Set<string>> {
  const graphs = new Map<string, Graph>();
  const visited = new Map<string, Set<string>>();
  const affected = new Set<string>();
  let sliceStarted = performance.now(), operations = 0;
  const checkpoint = async () => {
    if (++operations % 256 === 0 || performance.now() - sliceStarted >= 8) {
      await yieldTurn(); sliceStarted = performance.now();
    }
  };
  const scope = (meta: Attempt, assignment: boolean) => JSON.stringify([
    meta.sessionId, meta.cwd, assignment, assignment ? meta.assignment?.assignmentId : null,
  ]);
  for (const meta of related) {
    if (meta.operations?.resumeLaunchToken && meta.resumedFrom) {
      for (const key of [scope(meta, false), scope(meta, true)]) {
        let graph = graphs.get(key);
        if (!graph) { graph = new Map(); graphs.set(key, graph); }
        for (const [from, to] of [[meta.id, meta.resumedFrom], [meta.resumedFrom, meta.id]]) {
          let neighbors = graph.get(from!);
          if (!neighbors) { neighbors = new Set(); graph.set(from!, neighbors); }
          neighbors.add(to!);
        }
      }
    }
    await checkpoint();
  }
  for (const meta of changed) {
    const key = scope(meta, Boolean(meta.assignment));
    let seen = visited.get(key);
    if (!seen) { seen = new Set(); visited.set(key, seen); }
    const graph = graphs.get(key), pending = [meta.id];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); affected.add(id);
      for (const neighbor of graph?.get(id) ?? []) if (!seen.has(neighbor)) pending.push(neighbor);
      await checkpoint();
    }
    await checkpoint();
  }
  return affected;
}
