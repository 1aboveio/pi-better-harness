import { readFileSync } from 'node:fs';
import ts from 'typescript';

const target = new URL('../../src/runtime/background-tools.ts', import.meta.url).href;
const recorder = new URL('./recovery-trace.mjs', import.meta.url).href;

export function instrumentRecoveryTrace(source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error(`Resource trace source anchor changed: ${from}`);
    source = source.replace(from, to);
  };
  replace('service.noteParentContext(ctx, { recover: false });', `
    const traceRecoveryState = () => {
      const state = service.activeOrigin ? service.callbackRecoveryScopes.get(JSON.stringify([service.activeOrigin.cwd, service.activeOrigin.sessionId, service.activeContext.sessionManager.getBranch().map(entry => entry.id).filter(id => typeof id === 'string')])) : service.unscopedCallbackRecovery;
      return state ? { ...state } : null;
    };
    const traceBeforeContext = { owner: service.activeOrigin, state: traceRecoveryState() };
    service.noteParentContext(ctx, { recover: false });`);
  replace('const recoveryVersion = authority.backgroundDigest([lease.store.parentRecoveryRevision(record.owner), record.branchIds]);', `
    const traceCoordinatorRevision = lease.store.parentRecoveryRevision(record.owner);
    const recoveryVersion = authority.backgroundDigest([traceCoordinatorRevision, record.branchIds]);`);
  replace('metrics.reconciles++;', `
    const traceAfterContext = traceRecoveryState();
    recordRecoveryTrace({ event: 'reconcile', owner: record.owner, branchDigest: authority.backgroundDigest(record.branchIds),
      coordinatorRevision: traceCoordinatorRevision, cachedRecoveryDigest: recoveryVersions.get(viewKey) ?? null,
      recoveryDigest: recoveryVersion, pending: !traceAfterContext || traceAfterContext.revision < 0 || traceAfterContext.delivery !== undefined || traceAfterContext.claims !== undefined,
      beforeContext: traceBeforeContext, afterContext: traceAfterContext });
    metrics.reconciles++;`);
  replace('metrics.scopeRefreshes++;', `
    recordRecoveryTrace({ event: 'projection', owner: record.owner, branchDigest: authority.backgroundDigest(record.branchIds),
      previousRevision: projection?.revision ?? null, revision, scopeRevision: snapshot.scopeRevision, snapshotSequence: snapshot.seq });
    metrics.scopeRefreshes++;`);
  replace("item.delivery.defer('Native delivery lease expired');", `
    recordRecoveryTrace({ event: 'invalidate', owner: item.scope.owner, reason: 'delivery-lease-expired' });
    item.delivery.defer('Native delivery lease expired');`);
  replace('deliveries.delete(record.params.token);', `
    recordRecoveryTrace({ event: 'invalidate', owner: record.owner, reason: record.params.delivered === true ? 'receipt-delivered' : 'receipt-deferred' });
    deliveries.delete(record.params.token);`);
  replace('scopes.delete(oldest); forgetOwner(oldest);', `
    recordRecoveryTrace({ event: 'invalidate', ownerKey: oldest, reason: 'scope-evicted' });
    scopes.delete(oldest); forgetOwner(oldest);`);
  return `import { recordRecoveryTrace } from ${JSON.stringify(recorder)};\n${source}`;
}

export async function load(url, context, nextLoad) {
  if (url !== target) return nextLoad(url, context);
  const source = instrumentRecoveryTrace(readFileSync(new URL(url), 'utf8'));
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}
