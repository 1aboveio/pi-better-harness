import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, statSync, readFileSync, appendFileSync, renameSync, truncateSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { socketPathFor } from '../../src/runtime/socket.ts';

export const baseline = 'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8';

export function workloadTransport(root, env = process.env) {
  const explicit = env.PI_FULL_RUNTIME_TRANSPORT_DIR;
  const directory = explicit ?? join(root, 's');
  if (explicit !== undefined) {
    assert.ok(isAbsolute(explicit), 'PI_FULL_RUNTIME_TRANSPORT_DIR must be an absolute existing owned directory');
    assert.equal(realpathSync(explicit), explicit, 'Workload transport must be canonical, not an alias');
    const info = statSync(explicit);
    assert.ok(info.isDirectory(), 'Workload transport must be a directory');
    if (process.getuid) assert.equal(info.uid, process.getuid(), 'Workload transport must be owned by the current user');
  }
  return { directory, socketPath: socketPathFor(directory) };
}

export function workloadSettings(env = process.env) {
  if (env.PI_INCREMENTAL_WORKLOAD !== '1') return undefined;
  const history = Number(env.PI_INCREMENTAL_HISTORY ?? 4416);
  const group = Number(env.PI_INCREMENTAL_GROUP ?? 48);
  const clients = Number(env.PI_INCREMENTAL_CLIENTS ?? 1);
  const durationMs = Number(env.PI_INCREMENTAL_DURATION_MS ?? 600000);
  assert.ok([4416, 10000].includes(history), 'History must be 4416 or 10000');
  assert.ok(Number.isSafeInteger(group) && group >= 48, 'Group must be an integer >= 48 (qualification requires 48, 96 and larger)');
  assert.ok([1, 5, 10].includes(clients), 'Clients must be 1, 5 or 10');
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 600000, 'Each fixed-host workload must run at least 600000 ms');
  assert.notEqual(env.PI_FULL_RUNTIME_MATRIX_ONLY, '1', 'Mixed adapter smoke cannot qualify an incremental workload');
  return { history, group, clients, durationMs, baseline };
}

export function seedWorkload({ root, agent, cwd, settings }) {
  const durable = join(agent, 'subagents'), archives = join(durable, 'attempts');
  const runs = join(root, 'pi-better-subagents', 'runs');
  mkdirSync(archives, { recursive: true }); mkdirSync(runs, { recursive: true });
  const meta = (id, sessionId = id) => ({ id, cwd, sessionId, status: 'completed', startedAt: 1, endedAt: 2, callback: false,
    recipe: { version: 1, sessionId, cwd, sessionDir: join(durable, 'sessions') } });
  for (let i = 0; i < settings.history; i++) {
    const id = `sa_808_history_${i}`;
    writeFileSync(join(archives, `${id}.json`), JSON.stringify({ version: 1, meta: meta(id) }));
  }
  const tasks = [];
  for (let i = 0; i < settings.group; i++) {
    const id = `sa_808_group_${i}`, directory = join(runs, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'meta.json'), JSON.stringify(meta(id, '808-group')));
    const finalText = `808 final result ${i}`;
    const event = { type: 'message_end', message: { role: 'assistant',
      content: [{ type: 'text', text: finalText }], usage: { input: 3, output: 7, cost: { total: 0.01 } } } };
    const bytes = JSON.stringify(event) + '\n';
    writeFileSync(join(directory, 'output.log'), bytes);
    tasks.push({ id, finalText, costUSD: 0.01, input: 3, output: 7, bytes: Buffer.byteLength(bytes), logState: 'present' });
  }
  return { agent, cwd, runs, durable, tasks, history: settings.history, seededLogBytes: tasks.reduce((sum, task) => sum + task.bytes, 0) };
}

export function mutationExpectation(task, command) {
  if (['theme', 'same-settings'].includes(command.kind)) return undefined;
  assert.ok(task && task.id === command.id, 'Expected result requires exact task identity');
  if (['append', 'replace-log'].includes(command.kind)) return {
    logState: 'present', finalText: command.text,
    costUSD: ((command.kind === 'append' ? Math.round(task.costUSD * 100) : 0) + command.cents) / 100,
    input: (command.kind === 'append' ? task.input : 0) + 11, output: (command.kind === 'append' ? task.output : 0) + 13,
  };
  assert.ok(['truncate-log', 'delete-log'].includes(command.kind), 'Unknown result mutation');
  return { logState: command.kind === 'delete-log' ? 'missing' : 'empty', finalText: '', costUSD: 0, input: 0, output: 0 };
}

/** Used by the existing external writer; receipts describe actual source bytes, not runtime work. */
export function mutateWorkload(manifest, command) {
  const settings = ['theme', 'same-settings'].includes(command.kind);
  const allowed = ['theme', 'same-settings', 'append', 'replace-log', 'truncate-log', 'delete-log'];
  assert.ok(allowed.includes(command.kind), 'Unknown workload mutation');
  const task = manifest.tasks.find(task => task.id === command.id);
  if (!settings) assert.ok(task, 'Mutation requires an exact fixture task identity');
  const path = settings ? join(manifest.agent, 'settings.json') : join(manifest.runs, task.id, 'output.log');
  if (!settings) {
    const meta = JSON.parse(readFileSync(join(manifest.runs, task.id, 'meta.json'), 'utf8'));
    assert.equal(meta.id, task.id); assert.equal(meta.cwd, manifest.cwd); assert.equal(meta.sessionId, '808-group');
  }
  const before = readFileSync(path);
  let appended;
  let expected;
  if (command.kind === 'theme' || command.kind === 'same-settings') {
    if (command.kind === 'theme') assert.equal(typeof command.theme, 'string', 'Theme mutation requires a theme name');
    const next = command.kind === 'same-settings' ? before : Buffer.from(JSON.stringify({ ...JSON.parse(before), theme: command.theme }));
    const staged = `${path}.${process.pid}.mutation.tmp`;
    writeFileSync(staged, next, { flag: 'wx' }); renameSync(staged, path);
  } else if (command.kind === 'append' || command.kind === 'replace-log') {
    assert.ok(Number.isSafeInteger(command.cents) && command.cents > 0, 'Usage cost requires positive integer cents');
    assert.equal(typeof command.text, 'string');
    const event = { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: command.text }],
      usage: { input: 11, output: 13, cost: { total: command.cents / 100 } } } };
    appended = Buffer.from(JSON.stringify(event) + '\n');
    if (command.kind === 'append') appendFileSync(path, appended);
    else { const staged = `${path}.${process.pid}.mutation.tmp`; writeFileSync(staged, appended, { flag: 'wx' }); renameSync(staged, path); }
    expected = mutationExpectation(task, command);
  } else {
    if (command.kind === 'truncate-log') truncateSync(path, 0);
    else unlinkSync(path);
    expected = mutationExpectation(task, command);
  }
  const after = command.kind === 'delete-log' ? null : readFileSync(path);
  const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  return { kind: command.kind, id: task?.id, beforeBytes: before.length, afterBytes: after?.length ?? 0,
    appendedBytes: appended?.length ?? 0, beforeDigest: digest(before), afterDigest: digest(after), expected };
}

export function workloadCounterDelta(before, after) {
  if (before.executor || after.executor) {
    assert.equal(before.executor?.restarts, after.executor?.restarts, 'Worker generation changed; recovery must be reported separately');
    assert.equal(after.executor?.worker, 'running', 'Read worker is not running');
  }
  if (before.assignments?.generation || after.assignments?.generation) {
    assert.equal(before.assignments?.generation, after.assignments?.generation, 'Coordinator generation changed; ordinary counters cannot be compared');
  }
  const delta = (a, b, name) => {
    assert.ok(Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a, `Missing/reset counter: ${name}`);
    return b - a;
  };
  const fields = (a, b, names) => Object.fromEntries(names.map(name => [name, delta(a?.[name], b?.[name], name)]));
  if (before.baselineObservation || after.baselineObservation) {
    assert.equal(before.baselineObservation?.complete, true, 'Missing baseline observation coverage');
    assert.equal(after.baselineObservation?.complete, true, 'Missing baseline observation coverage');
    assert.equal(before.baselineObservation.threadId, after.baselineObservation.threadId, 'Baseline reader generation changed');
    assert.deepEqual(before.baselineObservation.moduleUrls, after.baselineObservation.moduleUrls, 'Baseline module origins changed');
    return { complete: false, unavailable: ['projection-source-breakdown', 'ordinary-versus-repair-source-work'],
      projections: fields(before, after, ['projections']),
      logs: fields(before.logReads, after.logReads, ['bytes', 'reads', 'parsedEvents', 'displayFolded', 'healthFolded']),
      ordinary: null, repair: null };
  }
  return {
    projections: fields(before, after, ['projections', 'assignmentProjections', 'logProjections', 'healthProjections']),
    logs: fields(before.logReads, after.logReads, ['bytes', 'reads', 'parsedEvents', 'displayFolded', 'healthFolded']),
    ordinary: fields(before.sourceWork?.entity, after.sourceWork?.entity, ['batches', 'paths', 'stats', 'metadataReads', 'logBytes', 'logReads']),
    repair: fields(before.sourceWork?.repair, after.sourceWork?.repair, ['batches', 'paths', 'stats', 'metadataReads', 'logBytes', 'logReads']),
  };
}

export function reconcileTask(task, row, cwd) {
  assert.equal(row.meta.id, task.id);
  assert.equal(row.meta.cwd, cwd);
  assert.equal(row.meta.sessionId, '808-group');
  assert.equal(row.meta.status, 'completed');
  const unavailable = task.logState === 'missing';
  if (unavailable) {
    assert.ok(row.detail.parsed.diagnostics?.some(message => /ENOENT|Log unreadable/.test(message)), 'Deleted log must report unavailable evidence');
    assert.notEqual(row.display?.coverage?.complete, true, 'Missing source cannot claim complete log coverage');
  } else {
    assert.ok(!row.display?.coverage?.error, 'Present source projection must be verified');
    assert.ok(!row.detail.parsed.diagnostics?.some(message => /Log unreadable|Incomplete usage|catch-up pending|Log truncated/.test(message)), 'Present source must be fully reconciled');
  }
  assert.equal(row.detail.parsed.finalText, task.finalText);
  assert.equal(row.detail.parsed.usage.costUSD, task.costUSD);
  assert.equal(row.detail.parsed.usage.input, task.input);
  assert.equal(row.detail.parsed.usage.output, task.output);
  return { id: task.id, finalText: row.detail.parsed.finalText, costUSD: unavailable ? null : row.detail.parsed.usage.costUSD,
    ...(task.logState === 'missing' || task.logState === 'empty' ? { sourceCompleteness: unavailable ? 'unavailable' : 'empty', diagnostics: row.detail.parsed.diagnostics } : {}),
    input: unavailable ? null : row.detail.parsed.usage.input, output: unavailable ? null : row.detail.parsed.usage.output };
}

export async function reconcileWorkload(work, cwd, manifest) {
  const missingSource = manifest.tasks.some(task => task.logState === 'missing');
  const verifyStatus = snapshot => {
    if (missingSource) {
      assert.equal(snapshot.status, 'degraded', 'Missing log evidence must remain degraded');
      assert.match(snapshot.reason ?? '', /Log source unavailable/, 'Only the expected missing-log degradation is admissible');
    } else assert.equal(snapshot.status, 'ready', snapshot.reason);
  };
  const snapshot = await work.get({ cwd, active: false, limit: 1 });
  verifyStatus(snapshot);
  // The full-runtime fixture also creates unrelated real work. Count this fixture's
  // exact identities through detail queries, not a global count containing them.
  const results = [];
  for (const task of manifest.tasks) {
    const detail = await work.get({ id: task.id, detail: true });
    verifyStatus(detail);
    assert.equal(detail.rows.length, 1, `Missing exact task ${task.id}`);
    results.push(reconcileTask(task, detail.rows[0], cwd));
  }
  const history = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const page = await work.get({ cwd, active: false, limit: 200, ...(cursor ? { cursor } : {}) });
    verifyStatus(page);
    for (const row of page.rows) if (row.meta.id.startsWith('sa_808_history_')) {
      assert.equal(row.meta.status, 'completed');
      assert.equal(row.meta.cwd, cwd);
      assert.equal(row.meta.sessionId, row.meta.id);
      assert.ok(!history.has(row.meta.id), `Repeated historical row ${row.meta.id}`);
      history.add(row.meta.id);
    }
    cursor = page.nextCursor;
    if (cursor) { assert.ok(!cursors.has(cursor), 'Historical cursor repeated without progress'); cursors.add(cursor); }
  } while (cursor);
  assert.equal(history.size, manifest.history);
  for (let i = 0; i < manifest.history; i++) assert.ok(history.has(`sa_808_history_${i}`));
  return { history: history.size, results };
}
