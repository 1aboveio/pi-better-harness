import test from 'node:test';
import assert from 'node:assert/strict';
import * as campaign from '../scripts/measure-full-runtime/campaign.mjs';
import { subjectModuleUrl, parseSubjectBinding } from '../scripts/measure-full-runtime/subject-binding.mjs';

test('paired windows use one external driver and explicit unchanged subject and artifact roots', () => {
  assert.equal(typeof campaign.windowInvocation, 'function');
  const before = campaign.windowInvocation({ checkout: '/approved/before', artifactRoot: '/artifacts/before', driverCheckout: '/fixture', durationMs: 600000 });
  const after = campaign.windowInvocation({ checkout: '/approved/after', artifactRoot: '/artifacts/after', driverCheckout: '/fixture', durationMs: 600000 });
  assert.equal(before.script, '/fixture/packages/pi-better-server/scripts/measure-full-runtime/measure-subject.mjs');
  assert.equal(after.script, before.script);
  assert.equal(before.cwd, '/approved/before');
  assert.equal(after.cwd, '/approved/after');
  assert.deepEqual(JSON.parse(before.binding), { checkout: '/approved/before', artifactRoot: '/artifacts/before', driverCheckout: '/fixture' });
  assert.deepEqual(JSON.parse(after.binding), { checkout: '/approved/after', artifactRoot: '/artifacts/after', driverCheckout: '/fixture' });
});

test('driver runtime imports bind to measured modules without redirecting fixture or foreign code', () => {
  const roots = { checkout: '/approved/before', artifactRoot: '/artifacts/before', driverCheckout: '/fixture' };
  assert.equal(subjectModuleUrl('file:///fixture/packages/pi-better-server/src/runtime/work-client.mjs', roots), 'file:///artifacts/before/src/runtime/work-client.mjs');
  assert.equal(subjectModuleUrl('file:///fixture/packages/pi-better-server/src/cli.ts', roots), 'file:///artifacts/before/src/cli.ts');
  assert.equal(subjectModuleUrl('file:///fixture/packages/pi-better-background-tasks/src/index.ts', roots), 'file:///approved/before/packages/pi-better-background-tasks/src/index.ts');
  assert.equal(subjectModuleUrl('file:///fixture/packages/pi-better-subagents/index.ts', roots), 'file:///approved/before/packages/pi-better-subagents/index.ts');
  for (const url of ['node:fs', 'file:///foreign/src/runtime/query-worker.mjs', 'file:///fixture/packages/pi-better-server/scripts/measure-full-runtime/frontend.ts']) assert.equal(subjectModuleUrl(url, roots), url);
  assert.deepEqual(parseSubjectBinding(JSON.stringify(roots)), roots);
  assert.throws(() => parseSubjectBinding(JSON.stringify({ ...roots, checkout: '../before' })), /absolute checkout/);
});
