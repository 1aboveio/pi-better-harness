import { writeFileSync } from 'node:fs';

let activeHook;
const tracedClients = new WeakSet();
const MAX_REQUESTS = 32;

function recordHook(hook, status, dependency) {
  const output = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
  if (output) writeFileSync(output, JSON.stringify({ phase: hook.phase, status, at: Date.now(), pid: process.pid,
    ...(dependency ? { dependency } : {}) }));
}

/** Observe only the Subagents client's existing requests while its startup hook is awaited. */
export function traceHostedRequests(Client) {
  if (tracedClients.has(Client)) return;
  tracedClients.add(Client);
  const request = Client.prototype.request;
  Client.prototype.request = function(type, ...args) {
    const hook = activeHook;
    if (!hook || !hook.phase.startsWith('subagents:session_start:')) return Reflect.apply(request, this, [type, ...args]);
    const sequence = ++hook.requests;
    if (sequence > MAX_REQUESTS) {
      if (sequence === MAX_REQUESTS + 1) recordHook(hook, 'entered', { state: 'request-bound-exceeded', limit: MAX_REQUESTS });
      return Reflect.apply(request, this, [type, ...args]);
    }
    const dependency = { sequence, type: String(type).slice(0, 64), state: 'pending' };
    recordHook(hook, 'entered', dependency);
    const pending = Reflect.apply(request, this, [type, ...args]);
    recordHook(hook, 'entered', { ...dependency, state: 'submitted' });
    return pending.then(value => {
      if (activeHook === hook && hook.requests <= MAX_REQUESTS) recordHook(hook, 'entered', { ...dependency, state: 'returned',
        ...(['ready', 'rebuilding', 'degraded'].includes(value?.status) ? { sourceStatus: value.status } : {}) });
      return value;
    }, error => {
      if (activeHook === hook && hook.requests <= MAX_REQUESTS) recordHook(hook, 'entered', { ...dependency, state: 'failed' });
      throw error;
    });
  };
}

/** Resource fixture only: retain the exact pending hook without inspecting its context. */
export function traceHostedHook(owner, event, ordinal, handler) {
  if (!['session_start', 'resources_discover'].includes(event)) return handler;
  return async function(...args) {
    const previous = activeHook;
    const hook = { phase: `${owner}:${event}:${ordinal}`, requests: 0 };
    activeHook = hook;
    recordHook(hook, 'entered');
    try {
      const value = await Reflect.apply(handler, this, args);
      recordHook(hook, 'returned');
      return value;
    } catch (error) { recordHook(hook, 'failed'); throw error; }
    finally { activeHook = previous; }
  };
}
