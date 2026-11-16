// Source hints coalesce by entity. Receipt/application remains owned by each
// domain; both domains take the same bounded foreground allowance before repair.
import { AsyncLocalStorage } from 'node:async_hooks';
export const ENTITY_BUDGET = 32;
export type WorkLane = "control" | "query" | "repair";
const lanes: WorkLane[] = ["control", "query", "repair"];
const limits = [16, 8, 8];
const sourceKinds = ['legacy-watch', 'legacy-remote-poll', 'legacy-handoff', 'legacy-process-deadline', 'legacy-log-retention'];
const wakeIndex = 10 + sourceKinds.length * 5;
export function notifyWorkBudget(buffer: SharedArrayBuffer) {
  const counters = new Int32Array(buffer);
  if (counters.length > wakeIndex) { Atomics.add(counters, wakeIndex, 1); Atomics.notify(counters, wakeIndex); }
}
/** Root-wide outstanding source work. Reserved lanes cannot be consumed by a wedged reader. */
export function createWorkBudget(buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (wakeIndex + 7 + sourceKinds.length))) {
  const counters = new Int32Array(buffer);
  const legacyIndex = 9 + sourceKinds.length * 5;
  const reservation = new AsyncLocalStorage<{ active: boolean }>();
  const pending = new Map<string, Promise<unknown>>();
  const ownerObservations = new Map<string, number>();
  const queue: Array<() => boolean> = [];
  let waiting = false, pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    const version = Atomics.load(counters, wakeIndex);
    for (let i = 0; i < queue.length;) { if (queue[i]!()) queue.splice(i, 1); else i++; }
    pumping = false;
    if (queue.length && !waiting) {
      const wait = (Atomics as typeof Atomics & { waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> } }).waitAsync(counters, wakeIndex, version);
      if (wait.async) { waiting = true; void (wait.value as Promise<string>).then(() => { waiting = false; pump(); }); }
      else queueMicrotask(pump);
    }
  };
  const sourceWork = new Map<string, { started: number; completed: number; failed: number; elapsedMs: number; active: number }>();
  return { buffer,
    // Only timer callbacks use deferred dispatch. Synchronous source callers
    // retain their return/throw contract; nested source measurement never waits.
    scheduleSource<T>(kind: string, id: string, work: () => T, owner = 'runtime', dueAt?: number): Promise<Awaited<T>> {
      if (reservation.getStore()?.active) return Promise.resolve().then(() => this.source(kind, work)) as Promise<Awaited<T>>;
      const key = JSON.stringify([owner, kind, id]);
      const prior = pending.get(key);
      if (prior) return prior as Promise<Awaited<T>>;
      let resolve!: (value: Awaited<T>) => void, reject!: (error: unknown) => void;
      const result = new Promise<Awaited<T>>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, result);
      queue.push(() => {
        // Outstanding observations cannot consume the slots needed by deadlines.
        const observation = !['legacy-process-deadline', 'legacy-handoff'].includes(kind);
        if (observation && owner !== 'runtime' && (ownerObservations.get(owner) ?? 0) >= 2) return false;
        if (observation && counters.length > legacyIndex) {
          for (;;) {
            const active = Atomics.load(counters, legacyIndex);
            if (active >= 8) return false;
            if (Atomics.compareExchange(counters, legacyIndex, active, active + 1) === active) break;
          }
        }
        const release = this.enter('control');
        if (!release) { if (observation && counters.length > legacyIndex) Atomics.sub(counters, legacyIndex, 1); return false; }
        const scope = { active: true };
        const sourceIndex = sourceKinds.indexOf(kind);
        if (sourceIndex >= 0 && dueAt !== undefined) Atomics.add(counters, wakeIndex + 7 + sourceIndex, Math.max(0, Date.now() - dueAt));
        if (observation) ownerObservations.set(owner, (ownerObservations.get(owner) ?? 0) + 1);
        const finish = () => {
          scope.active = false;
          if (observation) { const left = ownerObservations.get(owner)! - 1; if (left) ownerObservations.set(owner, left); else ownerObservations.delete(owner); }
          if (observation && counters.length > legacyIndex) Atomics.sub(counters, legacyIndex, 1); pending.delete(key); release();
        };
        try {
          Promise.resolve(reservation.run(scope, () => this.source(kind, work))).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        } catch (error) { finish(); reject(error); }
        return true;
      });
      pump();
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
      const started = performance.now();
      let released = false;
      return () => { if (!released) {
        released = true; Atomics.sub(counters, index, 1);
        Atomics.add(counters, wakeIndex + 1 + index, 1);
        Atomics.add(counters, wakeIndex + 4 + index, Math.round(performance.now() - started));
        notifyWorkBudget(buffer);
      } };
    },
    metrics() { return { queuedSources: queue.length, pendingSources: pending.size, sources: { ...Object.fromEntries([...sourceWork].map(([kind, metric]) => [kind, { ...metric, deadlineLatenessMs: 0 }])),
      ...Object.fromEntries(sourceKinds.flatMap((kind, i) => {
        const base = 9 + i * 5;
        return counters.length < base + 5 ? [] : [[kind, { started: Atomics.load(counters, base), completed: Atomics.load(counters, base + 1),
          failed: Atomics.load(counters, base + 2), elapsedMs: Atomics.load(counters, base + 3), active: Atomics.load(counters, base + 4),
          deadlineLatenessMs: Atomics.load(counters, wakeIndex + 7 + i) }]];
      })) }, capacity: ENTITY_BUDGET, lanes: Object.fromEntries(lanes.map((lane, i) => [lane,
      { capacity: limits[i], active: Atomics.load(counters, i), admitted: Atomics.load(counters, i + 3), deferred: Atomics.load(counters, i + 6),
        completed: Atomics.load(counters, wakeIndex + 1 + i), elapsedMs: Atomics.load(counters, wakeIndex + 4 + i) }])) }; },
  };
}
export function workPage<T>(items: Iterable<T>, limit = ENTITY_BUDGET): T[] {
  const page: T[] = [];
  for (const item of items) { if (page.length === limit) break; page.push(item); }
  return page;
}
