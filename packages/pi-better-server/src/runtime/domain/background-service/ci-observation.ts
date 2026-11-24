import { readHarnessSetting, type HarnessSettingsSeams } from './shared-harness-settings.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const supervisorConsultTool = 'supervisor_consult';
export const supervisorRecoveryType = 'background-ci-observation-recovery';

/** Ask the existing Goal gate, including workflow holds, before waking an idle owner. */
export function requestCiRecoveryWake(pi: ExtensionAPI, ctx: ExtensionContext, branchId: string, validUntil: number): Promise<() => boolean> {
    let goalId: string | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== 'custom' || !['pi-better-goal', 'pi-codex-goal'].includes(entry.customType)) continue;
        const data = entry.data as { kind?: string; goal?: { goalId?: string } } | undefined;
        if (data?.kind === 'clear') goalId = null;
        if (data?.kind === 'set' && typeof data.goal?.goalId === 'string') goalId = data.goal.goalId;
    }
    return new Promise(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        let settled = false;
        const finish = (current: () => boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(current);
        };
        timer = setTimeout(() => finish(() => goalId === null), 50);
        try {
            pi.events.emit('pi-better-goal:operation-resume-admission', {
                version: 1,
                owner: { sessionId: ctx.sessionManager.getSessionId(), workspace: ctx.cwd, branchId, goalId },
                pending() {
                    if (settled) return;
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(() => false), Math.max(1, validUntil - Date.now()));
                },
                reply(gate: { allowed: boolean; isCurrent?: () => boolean }) {
                    finish(() => gate?.allowed === true && gate.isCurrent?.() !== false);
                },
            });
        } catch { finish(() => false); }
    });
}

export function ciObservationEnabled(seams?: HarnessSettingsSeams): boolean {
    try {
        const setting = readHarnessSetting<{ enabled?: unknown; scenarios?: unknown }>('supervisorMode', seams);
        return setting?.enabled === true && Array.isArray(setting.scenarios)
            && setting.scenarios.every(id => typeof id === 'string') && setting.scenarios.includes('ci-observation');
    } catch {
        return false;
    }
}

// Only the current Outcome entry and bounded criteria cross the native grant.
// Never send the branch transcript or infer an Outcome from tool output.
export function supervisorOutcome(branch: readonly { id: string; type: string; customType?: string; data?: unknown }[]) {
    let entry: typeof branch[number] | undefined;
    for (let index = branch.length - 1; index >= 0; index--) {
        const item = branch[index];
        if (item?.type === 'custom' && item.customType === 'pi-better-harness:outcome') { entry = item; break; }
    }
    const data = entry?.data as { version?: number; outcome?: { status?: string; objective?: string; doneWhen?: string[]; boundaries?: string[] } } | undefined;
    if (!entry || data?.version !== 1 || data.outcome?.status !== 'active'
        || typeof data.outcome.objective !== 'string' || !data.outcome.objective.trim()) return;
    const lines = (value: unknown) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 8).map(item => item.slice(0, 400)) : [];
    return { id: entry.id, objective: data.outcome.objective.slice(0, 2000), doneWhen: lines(data.outcome.doneWhen), boundaries: lines(data.outcome.boundaries) };
}

export interface CiRun { repo: string; runId: string; attempt: number }

export function validCiRun(run: CiRun): boolean {
    return /^[\w-]+\/[\w.-]+$/.test(run.repo) && !run.repo.endsWith('/.') && !run.repo.endsWith('/..')
        && /^[1-9]\d{0,14}$/.test(run.runId) && Number.isSafeInteger(run.attempt) && run.attempt > 0;
}

/** Recognize literal argv, never a shell program, alias, output, name or a caller-supplied URL. */
export function ciRunFromArgv(kind: string, argv: readonly string[] | undefined): CiRun | undefined {
    if (kind === 'process' && argv?.[0] === 'node' && /^(?:\.\/)?scripts\/watch-github-run\.mjs$/.test(argv[1] ?? '')) {
        const options = new Map<string, string>();
        for (let i = 2; i < argv.length; i += 2) {
            const flag = argv[i], value = argv[i + 1];
            if (!flag || !value || !['--repo', '--run', '--interval-seconds'].includes(flag) || options.has(flag)) return;
            options.set(flag, value);
        }
        const run = { repo: options.get('--repo')?.toLowerCase() ?? '', runId: options.get('--run') ?? '', attempt: 1 };
        return validCiRun(run) ? run : undefined;
    }
    if (!argv || argv[0] !== 'gh' || argv[1] !== 'run'
        || !(kind === 'watch' && argv[2] === 'view' || kind === 'process' && argv[2] === 'watch')) return;
    const runId = argv[3];
    if (!/^[1-9]\d{0,14}$/.test(runId ?? '')) return;
    let repo: string | undefined, attempt = 1, pinned = false, json = false;
    for (let i = 4; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--exit-status' && kind === 'process') continue;
        const value = argv[++i];
        if ((flag === '--repo' || flag === '-R') && !repo && /^(?:github\.com\/)?[\w-]+\/[\w.-]+$/.test(value ?? '')) {
            repo = value!.replace(/^github\.com\//, '').toLowerCase();
        } else if (kind === 'watch' && flag === '--attempt' && !pinned && /^[1-9]\d{0,4}$/.test(value ?? '')) {
            attempt = Number(value); pinned = true;
        } else if (kind === 'watch' && flag === '--json' && !json && /^[A-Za-z,]+$/.test(value ?? '')) {
            json = true;
        } else return;
    }
    const run = { repo: repo ?? '', runId: runId!, attempt };
    if (validCiRun(run) && (kind !== 'watch' || json)) return run;
}
