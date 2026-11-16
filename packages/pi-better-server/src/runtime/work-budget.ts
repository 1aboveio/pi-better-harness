// Source hints coalesce by entity. Receipt/application remains owned by each
// domain; both domains take the same bounded foreground allowance before repair.
export const ENTITY_BUDGET = 32;
export type WorkLane = "control" | "query" | "repair";
const lanes: WorkLane[] = ["control", "query", "repair"];
const limits = [16, 8, 8];
/** Root-wide outstanding source work. Reserved lanes cannot be consumed by a wedged reader. */
export function createWorkBudget(buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 9)) {
  const counters = new Int32Array(buffer);
  const sourceWork = new Map<string, { started: number; completed: number; failed: number; elapsedMs: number; active: number }>();
  return { buffer,
    // Measure at the owner that performs the work, including asynchronous completion.
    source<T>(kind: string, work: () => T): T {
      let metric = sourceWork.get(kind);
      if (!metric) { metric = { started: 0, completed: 0, failed: 0, elapsedMs: 0, active: 0 }; sourceWork.set(kind, metric); }
      metric.started++; metric.active++;
      const started = performance.now();
      const finish = (failed: boolean) => { metric.active--; metric.completed++; metric.failed += Number(failed); metric.elapsedMs += performance.now() - started; };
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
    metrics() { return { sources: Object.fromEntries([...sourceWork].map(([kind, metric]) => [kind, { ...metric }])), capacity: ENTITY_BUDGET, lanes: Object.fromEntries(lanes.map((lane, i) => [lane,
      { capacity: limits[i], active: Atomics.load(counters, i), admitted: Atomics.load(counters, i + 3), deferred: Atomics.load(counters, i + 6) }])) }; },
  };
}
export function workPage<T>(items: Iterable<T>, limit = ENTITY_BUDGET): T[] {
  const page: T[] = [];
  for (const item of items) { if (page.length === limit) break; page.push(item); }
  return page;
}
