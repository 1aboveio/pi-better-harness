import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const scratch = dirname(fileURLToPath(import.meta.url));
export const repo = realpathSync(join(scratch, '../../..'));
export const sdkRoot = '/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent';
export const preload = join(scratch, 'offline.cjs');
export const cliArgs = ['--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'];

export function summarize(values) {
  assert.ok(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { n: values.length, medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    minMs: sorted[0], maxMs: sorted.at(-1) };
}

export function fixture(parent) {
  const base = realpathSync(mkdtempSync(join(parent, 'sample-')));
  const f = { base, project: join(base, 'project'), agent: join(base, 'agent'),
    control: join(base, 'control'), home: join(base, 'home'), temp: join(base, 'tmp'), taskScratch: join(base, 'task-scratch') };
  for (const dir of Object.values(f)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(f.agent, 'auth.json'), '{}');
  writeFileSync(join(f.agent, 'settings.json'), '{}');
  writeFileSync(join(f.taskScratch, '.sandbox-anchor'), '');
  f.env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: f.home,
    TMPDIR: f.temp, TMP: f.temp, TEMP: f.temp, XDG_CACHE_HOME: join(f.home, '.cache'),
    XDG_CONFIG_HOME: join(f.home, '.config'), XDG_DATA_HOME: join(f.home, '.local/share'),
    PI_CODING_AGENT_DIR: f.agent, PI_PACKAGE_DIR: sdkRoot, PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    NO_COLOR: '1', TERM: 'dumb' };
  return f;
}

// Real LF-framed subprocess transport. Timing ends at readiness, not child exit.
export async function runChild(args, f, { rpc = false, timeoutMs = 30000, readyType = 'benchmark_sdk_readiness' } = {}) {
  const started = performance.now();
  const child = spawn(process.execPath, args, { cwd: f.project, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rows = [], stderrRecords = [];
  let stdout = '', stderr = '', buffer = '', stderrBuffer = '', readyMs, guardMs, transportError;
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { transportError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on('error', (error) => { transportError ??= error; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data) => {
    stderr += data;
    stderrBuffer += data;
    let end;
    while ((end = stderrBuffer.indexOf('\n')) !== -1) {
      const line = stderrBuffer.slice(0, end).replace(/\r$/, '');
      stderrBuffer = stderrBuffer.slice(end + 1);
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      stderrRecords.push(row);
      if (row.type === 'task_sandbox_ready') guardMs = performance.now() - started;
    }
  });
  child.stdout.on('data', (data) => {
    stdout += data;
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { transportError ??= new Error(`Invalid JSONL: ${line}`); child.kill('SIGTERM'); continue; }
      rows.push(row);
      if (row.type === 'task_sandbox_ready') guardMs = performance.now() - started;
      const ready = rpc ? row.id === 'startup' && row.type === 'response' && row.command === 'get_state' : row.type === readyType;
      if (ready && readyMs === undefined) {
        readyMs = performance.now() - started;
        if (rpc) child.stdin.end();
      }
    }
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  if (rpc) child.stdin.write('{"type":"get_state","id":"startup"}\n');
  else child.stdin.end();
  let exit;
  try { exit = await closed; } finally { clearTimeout(deadline); }
  assert.equal(timedOut, false, `Readiness deadline exceeded; child ${child.pid} killed and reaped`);
  if (transportError) throw transportError;
  assert.equal(exit.code, 0, stderr + stdout);
  assert.ok(readyMs !== undefined, `No session readiness response: ${stdout}`);
  assert.equal(buffer, '', 'no incomplete JSONL record');
  const audits = stderr.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((row) => row.type === 'benchmark_network_audit');
  assert.equal(audits.length, 1, 'network preloader ran and audited child shutdown');
  assert.deepEqual(audits[0].attempts, [], 'no network attempts');
  if (rpc) {
    const state = rows.find((row) => row.id === 'startup');
    assert.equal(state.success, true);
    assert.equal(state.data.messageCount, 0);
    assert.equal(state.data.isStreaming, false);
    assert.ok(state.data.model === undefined ||
      (state.data.model.provider === 'unknown' && state.data.model.id === 'unknown' && state.data.model.contextWindow === 0),
      'no usable provider selected (SDK unknown sentinel is permitted)');
    assert.equal(state.data.sessionFile, undefined, 'in-memory session');
  }
  return { pid: child.pid, command: [process.execPath, ...args], cwd: f.project, environment: f.env,
    readyWallMs: readyMs, guardMarkerWallMs: guardMs ?? null, exitWallMs: performance.now() - started,
    exit, stdoutRecords: rows, stderrRecords, stderr, authAfter: readFileSync(join(f.agent, 'auth.json'), 'utf8') };
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
function git(args) {
  const result = spawnSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function workspaceSnapshot() {
  const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0')
    .filter((path) => path && !path.startsWith('docs/research/subagent-startup-scratch/'));
  const entries = new Map([...new Set(paths)].sort().map((path) => {
    const full = join(repo, path);
    if (!existsSync(full)) return [path, 'absent'];
    const stat = lstatSync(full);
    return [path, (stat.isDirectory() ? 'directory' : hash(readFileSync(full))) + ':' + (stat.mode & 0o777)];
  }));
  return { entries, status: git(['status', '--short']).split('\n')
    .filter((line) => !line.includes('docs/research/subagent-startup-scratch/')).join('\n'),
    head: git(['rev-parse', 'HEAD']), indexHash: hash(readFileSync(join(repo, '.git/index'))) };
}

async function main() {
  const count = Number(process.argv[2] ?? 7);
  assert.ok(Number.isInteger(count) && count >= 5, 'at least five samples per arm');
  const before = workspaceSnapshot();
  const packageJson = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.version, '1.0.4');
  const runRoot = realpathSync(mkdtempSync(join(scratch, '.run-')));
  const arms = { cliCold: [], sdkCold: [], taskGuardCold: [] };
  const worker = join(scratch, 'sdk-worker.mjs');
  const cliEntry = join(sdkRoot, 'dist/cli.js');
  const taskEntry = join(repo, 'packages/pi-better-subagents/task-runtime.mjs');
  let warm;
  try {
    // Rotate cold-arm order; all launches and warm creations are sequential.
    const kinds = Object.keys(arms);
    for (let sample = 0; sample < count; sample++) {
      for (let offset = 0; offset < kinds.length; offset++) {
        const kind = kinds[(sample + offset) % kinds.length];
        const f = fixture(runRoot);
        try {
          let args;
          if (kind === 'sdkCold') args = ['--require', preload, worker, sdkRoot, '1'];
          else if (kind === 'cliCold') args = ['--require', preload, cliEntry, ...cliArgs];
          else {
            const policy = { version: 1, root: f.project, home: f.home, agentDir: f.agent,
              profilePath: join(f.control, 'task.sb'), scratch: f.taskScratch,
              permissions: { projectFiles: 'read-write', outsideProject: 'read', storedCredentials: 'off',
                commands: false, network: false, processAccess: 'off' },
              denyWrite: [f.agent, f.control, join(f.taskScratch, '.sandbox-anchor')],
              tools: ['read', 'write', 'edit', 'bash'] };
            const policyPath = join(f.control, 'task-policy.json');
            writeFileSync(policyPath, JSON.stringify(policy));
            args = ['--require', preload, taskEntry, join(sdkRoot, 'dist/index.js'), policyPath,
              ...cliArgs, '--no-builtin-tools'];
          }
          const result = await runChild(args, f, { rpc: kind !== 'sdkCold' });
          assert.equal(result.authAfter, '{}');
          if (kind === 'taskGuardCold') {
            const marker = [...result.stdoutRecords, ...result.stderrRecords].find((row) => row.type === 'task_sandbox_ready');
            assert.deepEqual(marker?.tools, ['read', 'write', 'edit', 'bash'], result.stderr);
            result.guardMarkerChannel = result.stderrRecords.includes(marker) ? 'stderr' : 'stdout';
            result.kernelSandboxIncluded = false;
            result.policy = JSON.parse(readFileSync(join(f.control, 'task-policy.json'), 'utf8'));
          }
          result.sample = sample;
          arms[kind].push(result);
          console.log(`${kind} ${sample + 1}/${count}: ${result.readyWallMs.toFixed(2)} ms`);
        } finally { rmSync(f.base, { recursive: true, force: true }); }
      }
    }
    const f = fixture(runRoot);
    warm = await runChild(['--require', preload, worker, sdkRoot, String(count + 1)], f,
      { readyType: 'benchmark_sdk_ready' });
    const samples = warm.stdoutRecords.find((row) => row.type === 'benchmark_sdk_ready').samples;
    // First creation warms execution paths but is recorded, not counted as warm.
    assert.equal(samples.length, count + 1);
    warm.warmup = samples[0];
    warm.measuredSamples = samples.slice(1);
    console.log(`sdkWarm: ${summarize(warm.measuredSamples.map((sample) => sample.readyMs)).medianMs.toFixed(2)} ms median`);
  } finally { rmSync(runRoot, { recursive: true, force: true }); }
  const after = workspaceSnapshot();
  const changed = [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter((path) => before.entries.get(path) !== after.entries.get(path));
  assert.deepEqual(changed, [], 'no tracked/nonignored untracked files changed outside scratch');
  assert.equal(after.status, before.status);
  assert.equal(after.head, before.head);
  assert.equal(after.indexHash, before.indexHash);
  const summary = Object.fromEntries(Object.entries(arms).map(([kind, samples]) =>
    [kind, summarize(samples.map((sample) => sample.readyWallMs))]));
  summary.sdkColdImportPlusReady = summarize(arms.sdkCold.map((sample) =>
    sample.stdoutRecords.find((row) => row.type === 'benchmark_sdk_ready').samples[0].importPlusReadyMs));
  summary.sdkColdImport = summarize(arms.sdkCold.map((sample) =>
    sample.stdoutRecords.find((row) => row.type === 'benchmark_sdk_ready').importMs));
  summary.sdkWarmFreshSession = summarize(warm.measuredSamples.map((sample) => sample.readyMs));
  const results = { generatedAt: new Date().toISOString(), samplesPerArm: count,
    repeatCommand: `${process.execPath} ${join(scratch, 'benchmark.mjs')} ${count}`,
    environment: { node: process.version, execPath: process.execPath, realExecPath: realpathSync(process.execPath),
      versions: process.versions, platform: platform(), arch: arch(), osRelease: release(), cpu: cpus()[0]?.model,
      cpuCount: cpus().length, sdkRoot, sdkVersion: packageJson.version, cliEntry,
      globalCliOnPathNotMeasured: { path: '/Users/exoulster/.bun/bin/pi', target: realpathSync('/Users/exoulster/.bun/bin/pi') },
      inheritedEnvironment: 'none; exact allowlisted per-child environments recorded below',
      launchMode: 'same Node binary, unbundled SDK CLI vs SDK index import; global bundled CLI not timed' },
    method: { timer: 'performance.now monotonic milliseconds', cold: 'parent immediately before spawn to readiness JSONL receipt',
      sdkInternal: 'import await; fresh file-backed runtime/settings + resource reload + offline refresh + create + bind',
      warm: 'imports reused; recorded first creation excluded; fixed cwd/env; reset private agent disk outside timer; all objects recreated',
      taskGuard: 'existing task-runtime.mjs, private test-style policy, native Jiti bootstrap and get_state; no kernel task execution',
      network: 'PI_OFFLINE=1; no credentials; Node preload blocks network functions and audits zero attempts',
      excluded: ['fixture setup and reset', 'post-readiness validation/disposal and process shutdown', 'provider prompting and response latency',
        'tools and kernel task worker startup', 'production parent orchestration/workspace provisioning', 'user resources/configuration'],
      caveat: 'cold processes, not cold filesystem caches; shared host load uncontrolled; not production subagent latency' },
    summary, raw: { ...arms, sdkWarm: warm },
    sourceSha256: Object.fromEntries([join(scratch, 'benchmark.mjs'), worker, preload,
      join(scratch, 'benchmark.test.mjs'), taskEntry, join(repo, 'packages/pi-better-subagents/task-guard.ts'),
      join(repo, 'packages/pi-better-subagents/tests/task_runtime.test.mjs'),
      join(sdkRoot, 'package.json'), cliEntry, join(sdkRoot, 'dist/core/sdk.js'),
      join(sdkRoot, 'dist/core/agent-session-services.js'), join(sdkRoot, 'dist/core/model-runtime.js')]
      .map((path) => [path, hash(readFileSync(path))])),
    verification: { childCount: count * 3 + 1, allChildrenClosed: true, tempRunRootRemoved: !existsSync(runRoot),
      outsideScratchChangedPaths: changed, comparedFileCount: before.entries.size,
      outsideScratchDigestBefore: hash(JSON.stringify([...before.entries])), outsideScratchDigestAfter: hash(JSON.stringify([...after.entries])),
      gitStatusBefore: before.status, gitStatusAfter: after.status, gitHead: before.head.trim(),
      gitIndexHashBefore: before.indexHash, gitIndexHashAfter: after.indexHash,
      scope: 'tracked and nonignored untracked file contents/modes plus git HEAD/index/status; ignored files and contents of gitlinks/nested repositories not fingerprinted' } };
  writeFileSync(join(scratch, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
