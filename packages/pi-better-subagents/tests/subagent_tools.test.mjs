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
    const ask = join(base, 'node_modules', '@juicesharp', 'rpiv-ask-user-question');
    const harness = join(base, 'node_modules', 'pi-better-harness');
    for (const dir of [web, other, ask, harness]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.ts'), '');
        writeFileSync(join(dir, 'package.json'), '{}');
    }
    const registered = [
        { name: 'web_fetch', sourceInfo: { path: join(web, 'index.ts'), source: 'npm:@juicesharp/rpiv-web-tools', baseDir: web } },
        { name: 'web_search', sourceInfo: { path: join(web, 'index.ts'), source: 'npm:@juicesharp/rpiv-web-tools', baseDir: web } },
        { name: 'read', sourceInfo: { path: join(harness, 'index.ts'), source: 'npm:pi-better-harness', baseDir: harness } },
        { name: 'grep', sourceInfo: { path: '<builtin:grep>', source: 'builtin' } },
        { name: 'subagent_spawn', sourceInfo: { path: join(harness, 'index.ts'), source: 'npm:pi-better-harness', baseDir: harness } },
        { name: 'apply_patch', sourceInfo: { path: '/v/src/index.ts', source: 'npm:@vanillagreen/pi-codex-minimal-tools', baseDir: '/v' } },
        { name: 'ask_user_question', sourceInfo: { path: join(ask, 'index.ts'), source: 'npm:@juicesharp/rpiv-ask-user-question', baseDir: ask } },
    ];
    return { base, web, other, ask, registered };
}

test('discovery lists only third-party tools with their owning package', (t) => {
    const { registered, web, ask } = packages(t);
    assert.deepEqual(discoverTrustedTools(registered), [
        { name: 'ask_user_question', package: 'npm:@juicesharp/rpiv-ask-user-question', root: ask },
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

test('inventory requests are refused while Off and Read needs no trusted extension', () => {
    const base = { requested: ['process_list'], settings: defaultSubagentTools(), network: false,
        builtins: [...BUILTINS, 'process_list'], registered: [], resolvePath: () => { throw new Error('fixed adapter must not resolve an extension'); } };
    for (const processAccess of [undefined, 'off']) {
        assert.deepEqual(planTaskTools({ ...base, processAccess }).refused,
            [{ name: 'process_list', reason: 'Process access is Off; enable Read in /sandbox' }]);
    }
    assert.deepEqual(planTaskTools({ ...base, processAccess: 'read' }), { applyPatch: false, trusted: [], refused: [] });
    assert.deepEqual(discoverTrustedTools([{ name: 'process_list', sourceInfo: { path: '/vendor/index.ts', source: 'npm:fake-process', baseDir: '/vendor' } }]), [],
        'a third-party tool cannot spoof the reserved inventory adapter');
});

test('a single extension file with no manifest is its own package: load and admit only that file', (t) => {
    const { base } = packages(t);
    const extensions = join(base, 'agent', 'extensions');
    mkdirSync(extensions, { recursive: true });
    const file = join(extensions, 'fetcher.ts');
    writeFileSync(file, '');
    writeFileSync(join(extensions, 'other.ts'), '');
    const registered = [{ name: 'fetch_docs', sourceInfo: { path: file, source: 'local', scope: 'user', origin: 'top-level', baseDir: extensions } }];
    assert.deepEqual(discoverTrustedTools(registered), [{ name: 'fetch_docs', package: file, root: file }]);
    const plan = planTaskTools({ requested: ['fetch_docs'], settings: { applyPatch: false, trusted: [{ name: 'fetch_docs', package: file }] },
        network: true, builtins: BUILTINS, registered, resolvePath: () => undefined });
    assert.deepEqual(plan.trusted.map(({ root, loadPath }) => ({ root, loadPath })), [{ root: file, loadPath: file }],
        'never the extensions directory, which Pi would scan for every extension');
});
