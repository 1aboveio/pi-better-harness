import { continuousClock, elapsedMsBetween, isNs, validAcquisition } from './batch-capture.mjs';

const id = sample => JSON.stringify([sample?.identity?.pid, sample?.identity?.start, sample?.identity?.boot]);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cpuTotal = sample => sample?.cpu?.totalMicros !== undefined
  ? sample.cpu.totalMicros : sample?.cpu?.user + sample?.cpu?.system;
const validIdentity = sample => Number.isSafeInteger(sample?.identity?.pid) && sample.identity.pid > 0
  && typeof sample.identity.start === 'string' && sample.identity.start.length > 0;

/** Exact timestamp cohorts only. Never interpolate or sum unrelated per-process peaks. */
export function aggregateCohort(previous, current, { required, generation, clock, sampleIntervalMs = 250 } = {}) {
  const issues = [];
  const native = Boolean(clock || [current, previous].some(frame => Array.isArray(frame) && frame.some(sample => sample?.cpu?.totalMicros !== undefined)));
  const check = (samples, label) => {
    if (!Array.isArray(samples) || !samples.length) { issues.push(`${label}:missing-samples`); return; }
    if (samples.some(sample => !validIdentity(sample))) issues.push(`${label}:invalid-identity`);
    const keys = samples.map(id);
    if (new Set(keys).size !== keys.length || new Set(samples.map(sample => sample?.identity?.pid)).size !== keys.length) issues.push(`${label}:duplicate-process`);
    if (JSON.stringify(keys.slice().sort()) !== JSON.stringify(required.map(id).sort())) issues.push(`${label}:process-coverage`);
    if (samples.some(sample => sample?.generation !== generation)) issues.push(`${label}:generation`);
    if (native) {
      const cohort = samples[0]?.sourceCohort;
      if (typeof cohort?.id !== 'string' || !cohort.id || cohort.capturedAt !== samples[0]?.at || !Number.isSafeInteger(cohort.captureStartedAt)
        || samples.some(sample => sample?.cpu?.totalMicros === undefined || JSON.stringify(sample.sourceCohort) !== JSON.stringify(cohort))
        || !Array.isArray(cohort.pids) || JSON.stringify([...cohort.pids].sort((a,b)=>a-b)) !== JSON.stringify(samples.map(sample => sample?.identity?.pid).sort((a,b)=>a-b))) issues.push(`${label}:invalid-source-cohort`);
      if (!cohort?.clock || cohort.clock !== continuousClock(cohort.platform) || clock && cohort.clock !== clock
        || !validAcquisition(cohort, samples)) issues.push(`${label}:invalid-continuous-time`);
    }
    if (samples.some(sample => !Number.isSafeInteger(sample?.at) || sample.at < 0)
      || new Set(samples.map(sample => sample?.at)).size !== 1) issues.push(`${label}:mixed-timestamps`);
    if (samples.some(sample => !Number.isSafeInteger(sample?.sequence) || sample.sequence < 1
      || !(sample?.cpu?.totalMicros !== undefined ? nonnegative(sample.cpu.totalMicros)
        && sample.cpu.user === undefined && sample.cpu.system === undefined
        : nonnegative(sample?.cpu?.user) && nonnegative(sample?.cpu?.system)) || !nonnegative(sample?.rss))) issues.push(`${label}:invalid-counter`);
  };
  if (!Array.isArray(required) || !required.length || required.some(sample => !validIdentity(sample)) || new Set(required.map(id)).size !== required.length
    || new Set(required.map(sample => sample.identity.pid)).size !== required.length
    || typeof generation !== 'string' || !generation.length) {
    return { qualified: false, issues: ['invalid-required-cohort'], cpuPercent: null, rssBytes: null, at: null };
  }
  check(current, 'current');
  if (previous !== null) check(previous, 'previous');
  if (issues.length) return { qualified: false, issues, cpuPercent: null, rssBytes: null, at: null };
  const at = current[0].at;
  const continuousNs = native ? current[0].sourceCohort.capturedContinuousNs : undefined;
  let cpuMicros = 0;
  let intervalMs;
  if (native && elapsedMsBetween(current[0].sourceCohort.captureStartedContinuousNs, continuousNs) > sampleIntervalMs) issues.push('invalid-acquisition-interval');
  if (previous !== null) {
    const sourceFields = ['kind', 'platform', 'cpuResolutionMs', 'nativeBindingId', 'clock'];
    if (native && sourceFields.some(key => current[0].sourceCohort[key] !== previous[0].sourceCohort[key])) issues.push('changed-counter-source');
    intervalMs = native ? elapsedMsBetween(previous[0].sourceCohort.capturedContinuousNs, continuousNs) : at - previous[0].at;
    if (intervalMs <= 0) issues.push('non-increasing-timestamp');
    if (!nonnegative(sampleIntervalMs) || sampleIntervalMs === 0 || intervalMs > sampleIntervalMs) issues.push('missing-cohort-interval');
    if (native && elapsedMsBetween(previous[0].sourceCohort.capturedContinuousNs, current[0].sourceCohort.captureStartedContinuousNs) < 0) issues.push('overlapping-acquisition');
    for (const sample of current) {
      const prior = previous.find(value => id(value) === id(sample));
      if (sample.sequence !== prior.sequence + 1) issues.push('missing-or-replayed-sample');
      if ((sample.cpu.totalMicros !== undefined) !== (prior.cpu.totalMicros !== undefined)) issues.push('changed-counter-source');
      if (cpuTotal(sample) < cpuTotal(prior) || sample.cpu.user < prior.cpu.user || sample.cpu.system < prior.cpu.system) issues.push('reset-cpu-counter');
      cpuMicros += cpuTotal(sample) - cpuTotal(prior);
    }
  }
  return { qualified: !issues.length, issues, at, ...(native ? { continuousNs } : {}),
    cpuPercent: issues.length || previous === null ? null : cpuMicros / (intervalMs * 10),
    rssBytes: issues.length ? null : current.reduce((sum, sample) => sum + sample.rss, 0) };
}

/** Fold retained stream observations; any gap prevents full-window peak qualification. */
export function summarizeCohorts(frames, options, { startedAt, endedAt, startedContinuousNs, endedContinuousNs }) {
  const issues = new Set(), samples = [], rssSamples = [];
  let previous = null, previousFingerprint, firstAt = null, lastAt = null, firstContinuousNs, lastContinuousNs;
  if (!Array.isArray(frames) || !frames.length) issues.add('missing-cohorts');
  for (const frame of Array.isArray(frames) ? frames : []) {
    // Repeated reads of the same atomic probe records are not new observations.
    // Include counters so changed bytes under the same sequence cannot disappear.
    const fingerprint = JSON.stringify(Array.isArray(frame) ? frame.slice().sort((a, b) => id(a).localeCompare(id(b))) : frame) ?? 'invalid-undefined-frame';
    if (fingerprint === previousFingerprint) continue;
    previousFingerprint = fingerprint;
    const result = aggregateCohort(previous, frame, options);
    if (!result.qualified) {
      for (const issue of result.issues) issues.add(issue);
      previous = null; // Never bridge a missing interval with a later delta.
      continue;
    }
    firstAt ??= result.at; lastAt = result.at;
    firstContinuousNs ??= result.continuousNs; lastContinuousNs = result.continuousNs;
    rssSamples.push(result.rssBytes);
    if (result.cpuPercent !== null) samples.push({ at: result.at, fromAt: previous[0].at,
      ...(result.continuousNs ? { continuousNs: result.continuousNs, fromContinuousNs: previous[0].sourceCohort.capturedContinuousNs } : {}),
      cpuPercent: result.cpuPercent, rssBytes: result.rssBytes });
    previous = frame;
  }
  const native = options?.clock || firstContinuousNs !== undefined;
  const covered = native
    ? [startedContinuousNs, endedContinuousNs, firstContinuousNs, lastContinuousNs].every(isNs)
      && elapsedMsBetween(startedContinuousNs, endedContinuousNs) > 0
      && elapsedMsBetween(firstContinuousNs, startedContinuousNs) >= 0 && elapsedMsBetween(endedContinuousNs, lastContinuousNs) >= 0
    : nonnegative(startedAt) && nonnegative(endedAt) && endedAt > startedAt && firstAt !== null && firstAt <= startedAt && lastAt !== null && lastAt >= endedAt;
  if (!covered) issues.add('incomplete-window-coverage');
  if (!samples.length) issues.add('missing-cpu-intervals');
  const qualified = issues.size === 0;
  return { scope: 'simultaneous-related-processes', method: 'exact-capture-timestamp-cohorts', qualified,
    generation: options?.generation, processIdentities: Array.isArray(options?.required) ? options.required.filter(validIdentity).map(sample => sample.identity) : [],
    firstAt, lastAt, ...(native && firstContinuousNs !== undefined ? { firstContinuousNs, lastContinuousNs } : {}), samples: samples.length, issues: [...issues],
    cpuPercent: qualified ? samples.reduce((peak, sample) => Math.max(peak, sample.cpuPercent), 0) : null,
    rssBytes: qualified ? rssSamples.reduce((peak, value) => Math.max(peak, value), 0) : null,
    intervals: samples };
}
