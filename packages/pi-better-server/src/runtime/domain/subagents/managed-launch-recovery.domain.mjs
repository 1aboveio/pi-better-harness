// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-recovery.ts. Do not edit directly.
/** Called only after replacing the management epoch, fencing every old bootstrap. */
export function recoverLaunchMetadata(attempt, management, evidence, now = Date.now()) {
    const frozen = attempt.recoveryMeta;
    if (!frozen || frozen.id !== attempt.id || frozen.sessionId !== attempt.sessionId || frozen.management?.root !== management.root) {
        throw new Error(`launch-recovery-evidence-missing: ${attempt.id}`);
    }
    const pid = attempt.writerPid ?? attempt.pid;
    const start = attempt.writerStartTime ?? attempt.pidStartTime;
    if (attempt.bootstrapped && !pid)
        throw new Error(`writer-identity-unknown: ${attempt.id}`);
    if (pid && evidence.pidExists(pid)) {
        const observed = evidence.startToken(pid);
        if (!start || !observed)
            throw new Error(`writer-identity-unknown: ${attempt.id}`);
        if (observed === start) {
            const lease = evidence.lease(attempt.sessionId);
            if (!lease || lease.token !== attempt.lease || lease.attemptId !== attempt.id) {
                throw new Error(`writer-authority-unknown: ${attempt.id}`);
            }
        }
    }
    // No recorded PID and no successful bootstrap means the superseded token can
    // never execute task code. A dispatched writer retains ordinary health/log
    // reconciliation, including process-group evidence and interrupted streams.
    return { ...frozen, management, pid: pid ?? 0,
        ...(pid ? { pidStartTime: start, pgid: pid } : { status: "lost", lostAt: now, endedAt: now }),
        supervisionInterruptedAt: now, supervisionInterruptedReason: "runtime-launch-recovery" };
}
