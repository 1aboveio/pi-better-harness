import { supervisorPaths, readLaunchRecord, readTerminalRecord, readLostRecord, readClaimRecord, readCommandRecord, readStopRequest, readCleanupRecord } from "./supervisor/store.mjs";
function launchSummary(record) {
    return {
        taskId: record.taskId,
        token: record.token,
        kind: record.kind,
        ...(record.name === undefined ? {} : { name: record.name }),
        ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
        createdAt: record.createdAt,
        argv: record.command.argv,
        cwd: record.command.cwd,
        ...(record.commandTimeoutMs === undefined ? {} : { commandTimeoutSeconds: record.commandTimeoutMs / 1000 }),
        ...(record.taskTimeoutMs === undefined ? {} : { timeoutSeconds: record.taskTimeoutMs / 1000 }),
        ...(record.intervalMs === undefined ? {} : { intervalSeconds: record.intervalMs / 1000 }),
        ...(record.successWhen === undefined ? {} : { successWhen: record.successWhen }),
        ...(record.failureWhen === undefined ? {} : { failureWhen: record.failureWhen }),
        requestHash: record.requestHash,
    };
}
export function snapshot(directory, taskId) {
    const launchRead = readLaunchRecord(directory, taskId);
    if (launchRead.missing)
        return undefined;
    if (!launchRead.value) {
        throw new Error(`Unreadable supervisor launch record for ${taskId}: ${launchRead.error}`);
    }
    const launch = launchRead.value;
    const paths = supervisorPaths(directory, taskId);
    const result = readTerminalRecord(directory, taskId).value;
    const lostRecord = readLostRecord(directory, taskId).value;
    const claim = readClaimRecord(directory, taskId).value;
    const command = readCommandRecord(directory, taskId).value;
    const stop = readStopRequest(directory, taskId);
    const cleanup = readCleanupRecord(directory, taskId);
    const status = result
        ? result.status
        : lostRecord
            ? "lost"
            : claim
                ? "running"
                : "starting";
    return {
        taskId,
        token: launch.token,
        kind: launch.kind,
        status,
        terminal: result !== undefined || lostRecord !== undefined,
        launch: launchSummary(launch),
        // Liveness is deliberately not asserted here: a snapshot never spawns `ps`.
        ...(claim === undefined
            ? {}
            : { claim: { pid: claim.pid, pidStartTime: claim.pidStartTime, claimedAt: claim.claimedAt, alive: false } }),
        ...(command === undefined
            ? {}
            : {
                command: {
                    pid: command.pid,
                    pgid: command.pgid,
                    pidStartTime: command.pidStartTime,
                    startedAt: command.startedAt,
                    attempt: command.attempt ?? 1,
                    alive: false,
                },
            }),
        ...(result === undefined ? {} : { result }),
        ...(lostRecord === undefined ? {} : { lost: lostRecord }),
        ...(cleanup === undefined ? {} : { cleanup }),
        ...(stop === undefined ? {} : { stopRequestedAt: stop.requestedAt }),
        taskDir: paths.dir,
        logs: { stdout: paths.stdout, stderr: paths.stderr, events: paths.events },
        observedAt: Date.now(),
    };
}
