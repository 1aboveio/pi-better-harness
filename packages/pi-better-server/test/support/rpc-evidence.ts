const phases = new Set(['init-pending', 'init-returned', 'init-failed', 'queued', 'executing', 'recovery', 'read-pending', 'read-returned', 'tool-pending', 'tool-returned', 'settled', 'request-pending', 'request-returned', 'request-failed']);
const planes = new Set(['background', 'adapter', 'read', 'cancel']);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1e12, value)) : null;

/** Private fixture evidence: whitelist fields, never stringify arbitrary runtime objects. */
export function createRpcEvidence() {
  const events: Array<{ plane: string; slot: number | null; phase: string; at: number }> = [];
  const active = new Map<string, typeof events[number]>();
  let sample: (() => any) | undefined;
  return {
    bind(read: () => unknown) { sample = read; },
    event(plane: string, slot: number, phase: string) {
      if (!planes.has(plane) || !phases.has(phase)) return;
      events.push({ plane, slot: count(slot), phase, at: Date.now() });
      const key = `${plane}:${count(slot)}`;
      if (['settled', 'init-returned', 'init-failed'].includes(phase)) active.delete(key);
      else { active.set(key, events.at(-1)!); if (active.size > 32) active.delete(active.keys().next().value!); }
      if (events.length > 32) events.shift();
    },
    snapshot() {
      let state: any;
      try { state = sample?.(); } catch { state = undefined; }
      const lanes = Object.fromEntries(['control', 'query', 'repair'].map(lane => [lane,
        Object.fromEntries(['capacity', 'active', 'admitted', 'completed'].map(key => [key, count(state?.lanes?.[lane]?.[key])]))]));
      const read = state?.read;
      return { version: 1, events: events.map(event => ({ ...event })), active: [...active.values()].map(event => ({ ...event })), lanes,
        read: { active: count(read?.active), queued: count(read?.queued),
          worker: ['running', 'failed', 'closed', 'restarting'].includes(read?.worker) ? read.worker : 'unknown',
          observation: ['ready', 'rebuilding', 'degraded'].includes(state?.observation) ? state.observation : 'unknown' } };
    },
  };
}
