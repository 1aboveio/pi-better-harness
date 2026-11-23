import type { acquireMutationStore } from "./mutation-store.ts";
// @ts-expect-error Generated canonical supervisor.
import { createLocalSupervisor, defaultSupervisorDirectory } from "./domain/background/supervisor/supervisor.mjs";
// @ts-expect-error Generated durable stop request.
import { writeStopRequest } from "./domain/background/supervisor/store.mjs";
// @ts-expect-error Generated supervisor identity and format.
import { SUPERVISOR_RECORD_VERSION, SUPERVISOR_TASK_ID_PATTERN } from "./domain/background/supervisor/types.mjs";
// @ts-expect-error Generated canonical terminal evidence rules.
import { supervisorTerminalPublication } from "./domain/background/terminal-publication.mjs";

const reason = "24-hour task lifetime exceeded";

/** Repair records left behind by offline or older task owners. */
export function startTaskExpiry(control: ReturnType<typeof acquireMutationStore>, log: (message: string) => void) {
  const { store, budget } = control;
  let timer: NodeJS.Timeout;
  const sweep = () => {
    const release = budget.enter("repair");
    let delay = 30_000;
    try {
      if (!release) { delay = 1000; return; }
      const overdue = store.overdueOperations();
      if (store.expireWaits() || overdue.length) delay = 1000;
      for (const op of overdue) {
        try {
          let publication;
          if (op.observer.kind === "local-supervisor" && SUPERVISOR_TASK_ID_PATTERN.test(op.taskId)) {
            const grant = store.resultSupervision(op.operationId);
            const directory = grant ? grant.directory : defaultSupervisorDirectory();
            const inspection = createLocalSupervisor({ directory }).snapshot(op.taskId);
            if (inspection?.token === op.launchToken && (!grant || grant.launchToken === op.launchToken)) {
              if (inspection.terminal) publication = supervisorTerminalPublication(op, inspection);
              else writeStopRequest(directory, { version: SUPERVISOR_RECORD_VERSION, taskId: op.taskId,
                token: op.launchToken, requestedAt: Date.now(), reason });
            }
          }
          store.recordTerminalOutcome(publication ?? { operationId: op.operationId, owner: op.owner,
            eventId: "task-lifetime-expired", outcome: "failed", reason });
        } catch (error) {
          if (store.getOperation(op.operationId)?.phase === "running") log(`Task expiry for ${op.operationId}: ${String(error)}`);
        }
      }
    } catch (error) { log(`Task expiry: ${String(error)}`); }
    finally {
      release?.();
      timer = setTimeout(sweep, delay);
      timer.unref();
    }
  };
  sweep();
  return () => clearTimeout(timer);
}
