import type { DurableTaskProjection } from '../observed-waits.js';

export async function waitForPublicStatus(
  harness: { execute(name: string, params: Record<string, unknown>): Promise<string>; readDurableTask(id: string): DurableTaskProjection | undefined },
  id: string,
  done: (status: DurableTaskProjection) => boolean,
  timeoutMs = 5000,
): Promise<DurableTaskProjection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await harness.execute('bg_task_status', { id, verbose: true });
    const status = harness.readDurableTask(id);
    if (status && status.terminalRevision > 0 && done(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`task ${id} did not reach expected golden-path state`);
}
