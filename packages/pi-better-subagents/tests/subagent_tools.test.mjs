// @covers subagent.extension-tools
// @level unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeTaskTools, planTaskTools } from '../subagent-tools.ts';
import { defaultSubagentTools, discoverTrustedTools } from '../shared-task-tools.ts';

const BUILTINS = ['read', 'write', 'edit', 'bash'];

function packages(t) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-tools-')));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const web = join(base, 'node_modules', '@juicesharp', 'rpiv-web-tools');
    const other = join(base, 'node_modules', 'other-web');
    for (const dir of [web, other]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.ts'), ''); }
    const registered = [
        { name: 'web_fetch', sourceInfo: { path: join(web, 'index.ts'), source: 'npm:@juicesharp/rpiv-web-tools', baseDir: web } },
        { name: 'web_search', sourceInfo: { path: join(web, 'index.ts'), source: 'npm:@juicesharp/rpiv-web-tools', baseDir: web } },
        { name: 'read', sourceInfo: { path: '/harness/node_modules/pi-better-harness/extensions/sandbox/index.ts', source: 'npm:pi-better-harness', baseDir: '/harness' } },
        { name: 'grep', sourceInfo: { path: '<builtin:grep>', source: 'builtin' } },
        { name: 'subagent_spawn', sourceInfo: { path: '/h/index.ts', source: 'npm:pi-better-harness', baseDir: '/h' } },
        { name: 'apply_patch', sourceInfo: { path: '/v/src/index.ts', source: 'npm:@vanillagreen/pi-codex-minimal-tools', baseDir: '/v' } },
        { name: 'ask_user_question', sourceInfo: { path: '/q/index.ts', source: 'npm:@juicesharp/rpiv-ask-user-question', baseDir: '/q' } },
    ];
    return { base, web, other, registered };
}

test('discovery lists only third-party tools with their owning package', (t) => {
    const { registered, web } = packages(t);
    assert.deepEqual(discoverTrustedTools(registered), [
        { name: 'ask_user_question', package: 'npm:@juicesharp/rpiv-ask-user-question', root: '/q' },
        { name: 'web_fetch', package: 'npm:@juicesharp/rpiv-web-tools', root: web },
        { name: 'web_search', package: 'npm:@juicesharp/rpiv-web-tools', root: web },
    ]);
});

test('the default plan loads the ticked web tools from their registered package and adds guarded apply_patch', (t) => {
    const { registered, web } = packages(t);
    const plan = planTaskTools({ requested: ['read', 'edit', 'apply_patch', 'web_fetch', 'web_search', 'ask_user_question'],
        settings: defaultSubagentTools(), network: true, builtins: BUILTINS, registered, resolvePath: () => undefined });
    assert.equal(plan.applyPatch, true);
    assert.deepEqual(plan.trusted.map(({ name, root, network, loadPath }) => ({ name, root, network, loadPath })), [
        { name: 'web_fetch', root: web, network: true, loadPath: web },
        { name: 'web_search', root: web, network: true, loadPath: web },
    ]);
    assert.deepEqual(plan.refused, [{ name: 'ask_user_question', reason: 'not a guarded tool and not ticked as trusted in /sandbox (Subagents · Tools)' }]);
    assert.equal(describeTaskTools(plan), 'guarded apply_patch · trusted web_fetch (@juicesharp/rpiv-web-tools), web_search (@juicesharp/rpiv-web-tools)');
});

test('network tools are refused with Network Off; unresolvable or mismatched packages are refused with a reason', (t) => {
    const { registered, other } = packages(t);
    const base = { settings: defaultSubagentTools(), builtins: BUILTINS, registered, resolvePath: () => undefined };
    assert.deepEqual(planTaskTools({ ...base, requested: ['web_fetch'], network: false }).refused,
        [{ name: 'web_fetch', reason: 'needs Network access, which is Off for subagents' }]);
    assert.match(planTaskTools({ ...base, requested: ['web_fetch'], network: true, registered: [] }).refused[0].reason,
        /package @juicesharp\/rpiv-web-tools is not installed|can't be found/);
    // A config override naming another package loads it only if that package is the ticked one.
    const mismatch = planTaskTools({ ...base, requested: ['web_fetch'], network: true, toolExtensions: { web_fetch: 'npm:other-web' } });
    assert.match(mismatch.refused[0].reason, /toolExtensions maps it to other-web, not the ticked package @juicesharp\/rpiv-web-tools/);
    const ticked = planTaskTools({ ...base, requested: ['web_fetch'], network: true, toolExtensions: { web_fetch: 'npm:other-web' },
        settings: { applyPatch: false, trusted: [{ name: 'web_fetch', package: 'npm:other-web' }] }, resolvePath: () => other });
    assert.deepEqual(ticked.trusted.map((tool) => [tool.name, tool.root]), [['web_fetch', other]]);
    assert.deepEqual(planTaskTools({ ...base, requested: ['apply_patch'], network: true, settings: { applyPatch: false, trusted: [] } }).refused,
        [{ name: 'apply_patch', reason: 'apply_patch is off in /sandbox (Subagents · Tools)' }]);
});
