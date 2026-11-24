import { expect, it } from 'vitest';
import { ciObserverArgv, ciRunFromArgv, requestCiRecoveryWake } from './ci-observation.ts';

it('only recognizes scoped read-only CI observers and retains their exact attempt', () => {
    expect(ciRunFromArgv('watch', ['gh', 'run', 'view', '123', '-R', 'Example/Build', '--json', 'status,jobs', '--attempt', '2']))
        .toEqual({ repo: 'example/build', runId: '123', attempt: 2 });
    expect(ciRunFromArgv('process', ['node', 'scripts/watch-github-run.mjs', '--repo', 'example/build', '--run', '123']))
        .toEqual({ repo: 'example/build', runId: '123', attempt: 1 });
    expect(ciRunFromArgv('watch', ['gh', 'run', 'rerun', '123', '-R', 'example/build'])).toBeUndefined();
    expect(ciRunFromArgv('watch', ['gh', 'run', 'view', '123', '-R', 'other.host/example/build', '--json', 'status'])).toBeUndefined();
    expect(ciRunFromArgv('process', ['gh', 'run', 'watch', '123', '-R', 'example/build', '--web'])).toBeUndefined();
});

it('requires the current Goal and workflow permission to wake the original owner', async () => {
    const ctx = { cwd: '/workspace', sessionManager: { getSessionId: () => 'owner', getBranch: () => [
        { type: 'custom', customType: 'pi-better-goal', data: { kind: 'set', goal: { goalId: 'goal' } } },
    ] } };
    let allowed = false;
    let current = true;
    const pi = { events: { emit: (event: string, request: any) => {
        expect(event).toBe('pi-better-goal:operation-resume-admission');
        expect(request.owner).toEqual({ sessionId: 'owner', workspace: '/workspace', branchId: 'branch', goalId: 'goal' });
        request.reply({ allowed, isCurrent: () => current });
    } } };
    const wake = () => requestCiRecoveryWake(pi as any, ctx as any, 'branch', Date.now() + 1000);
    expect((await wake())()).toBe(false);
    allowed = true;
    const grant = await wake();
    expect(grant()).toBe(true);
    current = false;
    expect(grant()).toBe(false);
});

it('recognizes a literal installed watcher command and excludes compound shell commands', () => {
    const command = 'node /agent/npm/node_modules/@1aboveio/skills/skills/cicd/github-actions/scripts/watch-run.mjs --run 45180745024 --repo 1aboveio/a1';
    const identify = (command: string) => ciRunFromArgv('process', ciObserverArgv({ command }));
    expect(identify(command)).toEqual({ repo: '1aboveio/a1', runId: '45180745024', attempt: 1 });
    for (const suffix of ['; exit', ' && other', '\nother', ' >out', ' --another flag']) expect(identify(command + suffix)).toBeUndefined();
    expect(identify(command.replace('node_modules', 'node_modules/../node_modules'))).toBeUndefined();
});
