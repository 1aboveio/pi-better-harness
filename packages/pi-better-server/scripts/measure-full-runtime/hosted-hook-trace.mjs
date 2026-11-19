import { writeFileSync } from 'node:fs';

/** Resource fixture only: retain the exact pending hook without inspecting its context. */
export function traceHostedHook(owner, event, ordinal, handler) {
  if (!['session_start', 'resources_discover'].includes(event)) return handler;
  const phase = `${owner}:${event}:${ordinal}`;
  const record = status => {
    const output = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
    if (output) writeFileSync(output, JSON.stringify({ phase, status, at: Date.now(), pid: process.pid }));
  };
  return async function(...args) {
    record('entered');
    try {
      const value = await Reflect.apply(handler, this, args);
      record('returned');
      return value;
    } catch (error) { record('failed'); throw error; }
  };
}
