import type { DurableTaskProjection } from '../observed-waits.js';

export async function waitForPublicStatus(
  harness: { execute(name: string, params: Record<string, unknown>): Promise<string>; readDurableTask(id: string): DurableTaskProjection | undefined },
  id: string,
  done: (status: DurableTaskProjection) => boolean,
  timeoutMs = 5000,
): Promise<DurableTaskProjection> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0, response: string | undefined, observed: DurableTaskProjection | undefined;
  while (Date.now() < deadline) {
    attempts++;
    response = await harness.execute('bg_task_status', { id, verbose: true });
    const status = harness.readDurableTask(id);
    observed = status;
    if (status && status.terminalRevision > 0 && done(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const states = new Set(['starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost']);
  let publicStatus: unknown;
  try { publicStatus = JSON.parse(response ?? '').status; } catch { /* Public status may legitimately be text. */ }
  console.error('[background-golden-observation-failure]', JSON.stringify({ attempts, phase: attempts ? 'projection-returned' : 'not-started',
    publicStatus: states.has(publicStatus as string) ? publicStatus : null,
    publicText: response !== undefined && publicStatus === undefined,
    found: Boolean(observed), status: states.has(observed?.status ?? '') ? observed!.status : null,
    terminal: observed?.terminal === true,
    terminalRevision: Number.isSafeInteger(observed?.terminalRevision) ? observed!.terminalRevision : null,
    terminalOutcome: states.has(observed?.terminalOutcome ?? '') ? observed!.terminalOutcome : null,
    exitCode: Number.isSafeInteger(observed?.exitCode) ? observed!.exitCode : null,
    signal: observed?.signal === null ? null : /^SIG[A-Z0-9]{1,16}$/.test(observed?.signal ?? '') ? observed!.signal : 'unavailable',
  }));
  throw new Error(`task ${id} did not reach expected golden-path state`);
}
