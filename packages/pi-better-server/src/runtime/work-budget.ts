// Source hints coalesce by entity. Receipt/application remains owned by each
// domain; both domains take the same bounded foreground allowance before repair.
import { AsyncLocalStorage } from 'node:async_hooks';
export const ENTITY_BUDGET = 32;
export type WorkLane = "control" | "query" | "repair";
const lanes: WorkLane[] = ["control", "query", "repair"];
const limits = [16, 8, 8];
const sourceKinds = ['legacy-watch', 'legacy-remote-poll', 'legacy-handoff', 'legacy-process-deadline', 'legacy-log-retention'];
/** Root-wide outstanding source work. Reserved lanes cannot be consumed by a wedged reader. */
export function createWorkBudget(buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (10 + sourceKinds.length * 5))) {
  const counters = new Int32Array(buffer);
  const legacyIndex = 9 + sourceKinds.length * 5;
  const reservation = new AsyncLocalStorage<{ active: boolean }>();
  const pending = new Map<string, Promise<unknown>>();
  const queue: Array<() => boolean> = [];
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    retry = undefined;
    while (queue.length && queue[0]!()) queue.shift();
    if (queue.length) { retry = setTimeout(pump, 5); retry.unref(); }
  };
  const sourceWork = new Map<string, { started: number; completed: number; failed: number; elapsedMs: number; active: number }>();
  return { buffer,
    // Only timer callbacks use deferred dispatch. Synchronous source callers
    // retain their return/throw contract; nested source measurement never waits.
    scheduleSource<T>(kind: string, id: string, work: () => T): Promise<Awaited<T>> {
      if (reservation.getStore()?.active) return Promise.resolve().then(() => this.source(kind, work)) as Promise<Awaited<T>>;
      const key = JSON.stringify([kind, id]);
      const prior = pending.get(key);
      if (prior) return prior as Promise<Awaited<T>>;
      let resolve!: (value: Awaited<T>) => void, reject!: (error: unknown) => void;
      const result = new Promise<Awaited<T>>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, result);
      queue.push(() => {
        // Legacy polls cannot occupy all control slots while awaiting a provider.
        if (counters.length > legacyIndex) {
          for (;;) {
            const active = Atomics.load(counters, legacyIndex);
            if (active >= 8) return false;
            if (Atomics.compareExchange(counters, legacyIndex, active, active + 1) === active) break;
          }
        }
        const release = this.enter('control');
        if (!release) { if (counters.length > legacyIndex) Atomics.sub(counters, legacyIndex, 1); return false; }
        const scope = { active: true };
        const finish = () => { scope.active = false; release(); if (counters.length > legacyIndex) Atomics.sub(counters, legacyIndex, 1); pending.delete(key); if (queue.length && !retry) { retry = setTimeout(pump, 0); retry.unref(); } };
        try {
          Promise.resolve(reservation.run(scope, () => this.source(kind, work))).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        } catch (error) { finish(); reject(error); }
        return true;
      });
      if (!retry) pump();
      return result;
    },
    // Measure at the owner that performs the work, including asynchronous completion.
    source<T>(kind: string, work: () => T): T {
      const index = sourceKinds.indexOf(kind), base = 9 + index * 5;
      const shared = index >= 0 && counters.length >= base + 5;
      let metric = sourceWork.get(kind);
      if (!metric) { metric = { started: 0, completed: 0, failed: 0, elapsedMs: 0, active: 0 }; sourceWork.set(kind, metric); }
      metric.started++; metric.active++;
      if (shared) { Atomics.add(counters, base, 1); Atomics.add(counters, base + 4, 1); }
      const started = performance.now();
      const finish = (failed: boolean) => {
        const elapsed = performance.now() - started;
        metric.active--; metric.completed++; metric.failed += Number(failed); metric.elapsedMs += elapsed;
        if (shared) { Atomics.add(counters, base + 1, 1); Atomics.add(counters, base + 2, Number(failed)); Atomics.add(counters, base + 3, Math.round(elapsed)); Atomics.sub(counters, base + 4, 1); }
      };
      try {
        const value = work();
        if (value instanceof Promise) return value.then(result => { finish(false); return result; }, error => { finish(true); throw error; }) as T;
        finish(false);
        return value;
      } catch (error) { finish(true); throw error; }
    },
    enter(lane: WorkLane) {
      const index = lanes.indexOf(lane);
      for (;;) {
        const used = Atomics.load(counters, index);
        if (used >= limits[index]!) { Atomics.add(counters, index + 6, 1); return undefined; }
        if (Atomics.compareExchange(counters, index, used, used + 1) === used) break;
      }
      Atomics.add(counters, index + 3, 1);
      let released = false;
      return () => { if (!released) { released = true; Atomics.sub(counters, index, 1); } };
    },
    metrics() { return { queuedSources: queue.length, sources: { ...Object.fromEntries([...sourceWork].map(([kind, metric]) => [kind, { ...metric }])),
      ...Object.fromEntries(sourceKinds.flatMap((kind, i) => {
        const base = 9 + i * 5;
        return counters.length < base + 5 ? [] : [[kind, { started: Atomics.load(counters, base), completed: Atomics.load(counters, base + 1),
          failed: Atomics.load(counters, base + 2), elapsedMs: Atomics.load(counters, base + 3), active: Atomics.load(counters, base + 4) }]];
      })) }, capacity: ENTITY_BUDGET, lanes: Object.fromEntries(lanes.map((lane, i) => [lane,
      { capacity: limits[i], active: Atomics.load(counters, i), admitted: Atomics.load(counters, i + 3), deferred: Atomics.load(counters, i + 6) }])) }; },
  };
}
export function workPage<T>(items: Iterable<T>, limit = ENTITY_BUDGET): T[] {
  const page: T[] = [];
  for (const item of items) { if (page.length === limit) break; page.push(item); }
  return page;
}
