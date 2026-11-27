import type { RunMeta } from "./registry.ts";

interface RecoverableAttempt {
    id: string;
    sessionId: string;
    lease: string;
    pid?: number;
    pidStartTime?: string;
    writerPid?: number;
    writerStartTime?: string;
    bootstrapped?: boolean;
    recoveryMeta?: unknown;
}
interface RecoveryEvidence {
    pidExists(pid: number): boolean;
    startToken(pid: number): string | undefined;
    lease(sessionId: string): { token: string; attemptId: string } | undefined;
}

/** Called only after replacing the management epoch, fencing every old bootstrap. */
export function recoverLaunchMetadata(attempt: RecoverableAttempt, management: NonNullable<RunMeta["management"]>, evidence: RecoveryEvidence, now = Date.now()): RunMeta {
    const frozen = attempt.recoveryMeta as RunMeta | undefined;
    if (!frozen || frozen.id !== attempt.id || frozen.sessionId !== attempt.sessionId || frozen.management?.root !== management.root) {
        throw new Error(`launch-recovery-evidence-missing: ${attempt.id}`);
    }
    const pid = attempt.writerPid ?? attempt.pid;
    const start = attempt.writerStartTime ?? attempt.pidStartTime;
    if (attempt.bootstrapped && !pid) throw new Error(`writer-identity-unknown: ${attempt.id}`);
    if (pid && evidence.pidExists(pid)) {
        const observed = evidence.startToken(pid);
        if (!start || !observed) throw new Error(`writer-identity-unknown: ${attempt.id}`);
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
