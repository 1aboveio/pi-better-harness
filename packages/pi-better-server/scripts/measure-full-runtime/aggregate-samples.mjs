const id = sample => `${sample?.identity?.pid}:${sample?.identity?.start}`;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cpuTotal = sample => sample?.cpu?.totalMicros !== undefined
  ? sample.cpu.totalMicros : sample?.cpu?.user + sample?.cpu?.system;
const validIdentity = sample => Number.isSafeInteger(sample?.identity?.pid) && sample.identity.pid > 0
  && typeof sample.identity.start === 'string' && sample.identity.start.length > 0;

/** Exact timestamp cohorts only. Never interpolate or sum unrelated per-process peaks. */
export function aggregateCohort(previous, current, { required, generation, sampleIntervalMs = 250 } = {}) {
  const issues = [];
  const check = (samples, label) => {
    if (!Array.isArray(samples) || !samples.length) { issues.push(`${label}:missing-samples`); return; }
    if (samples.some(sample => !validIdentity(sample))) issues.push(`${label}:invalid-identity`);
    const keys = samples.map(id);
    if (new Set(keys).size !== keys.length || new Set(samples.map(sample => sample?.identity?.pid)).size !== keys.length) issues.push(`${label}:duplicate-process`);
    if (JSON.stringify(keys.slice().sort()) !== JSON.stringify(required.map(id).sort())) issues.push(`${label}:process-coverage`);
    if (samples.some(sample => sample?.generation !== generation)) issues.push(`${label}:generation`);
    if (samples.some(sample => sample?.cpu?.totalMicros !== undefined)) {
      const cohort = samples[0]?.sourceCohort;
      if (typeof cohort?.id !== 'string' || !cohort.id || cohort.capturedAt !== samples[0]?.at || !Number.isSafeInteger(cohort.captureStartedAt)
        || cohort.captureStartedAt > cohort.capturedAt || samples.some(sample => JSON.stringify(sample.sourceCohort) !== JSON.stringify(cohort))
        || !Array.isArray(cohort.pids) || JSON.stringify([...cohort.pids].sort((a,b)=>a-b)) !== JSON.stringify(samples.map(sample => sample?.identity?.pid).sort((a,b)=>a-b))) issues.push(`${label}:invalid-source-cohort`);
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
  let cpuMicros = 0;
  if (previous !== null) {
    if (current[0].cpu.totalMicros !== undefined && JSON.stringify(['kind','platform','cpuResolutionMs','nativeBindingId'].map(key => current[0].sourceCohort?.[key]))
      !== JSON.stringify(['kind','platform','cpuResolutionMs','nativeBindingId'].map(key => previous[0].sourceCohort?.[key]))) issues.push('changed-counter-source');
    if (at <= previous[0].at) issues.push('non-increasing-timestamp');
    if (!nonnegative(sampleIntervalMs) || sampleIntervalMs === 0 || at - previous[0].at > sampleIntervalMs) issues.push('missing-cohort-interval');
    for (const sample of current) {
      const prior = previous.find(value => id(value) === id(sample));
      if (sample.sequence !== prior.sequence + 1) issues.push('missing-or-replayed-sample');
      if ((sample.cpu.totalMicros !== undefined) !== (prior.cpu.totalMicros !== undefined)) issues.push('changed-counter-source');
      if (cpuTotal(sample) < cpuTotal(prior) || sample.cpu.user < prior.cpu.user || sample.cpu.system < prior.cpu.system) issues.push('reset-cpu-counter');
      cpuMicros += cpuTotal(sample) - cpuTotal(prior);
    }
  }
  return { qualified: !issues.length, issues, at,
    cpuPercent: issues.length || previous === null ? null : cpuMicros / ((at - previous[0].at) * 10),
    rssBytes: issues.length ? null : current.reduce((sum, sample) => sum + sample.rss, 0) };
}

/** Fold retained stream observations; any gap prevents full-window peak qualification. */
export function summarizeCohorts(frames, options, { startedAt, endedAt }) {
  const issues = new Set(), samples = [], rssSamples = [];
  let previous = null, previousFingerprint, firstAt = null, lastAt = null;
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
    rssSamples.push(result.rssBytes);
    if (result.cpuPercent !== null) samples.push({ at: result.at, fromAt: previous[0].at, cpuPercent: result.cpuPercent, rssBytes: result.rssBytes });
    previous = frame;
  }
  if (!nonnegative(startedAt) || !nonnegative(endedAt) || endedAt <= startedAt || firstAt === null || firstAt > startedAt || lastAt === null || lastAt < endedAt) issues.add('incomplete-window-coverage');
  if (!samples.length) issues.add('missing-cpu-intervals');
  const qualified = issues.size === 0;
  return { scope: 'simultaneous-related-processes', method: 'exact-capture-timestamp-cohorts', qualified,
    generation: options?.generation, processIdentities: Array.isArray(options?.required) ? options.required.filter(validIdentity).map(sample => sample.identity) : [],
    firstAt, lastAt, samples: samples.length, issues: [...issues],
    cpuPercent: qualified ? samples.reduce((peak, sample) => Math.max(peak, sample.cpuPercent), 0) : null,
    rssBytes: qualified ? rssSamples.reduce((peak, value) => Math.max(peak, value), 0) : null,
    intervals: samples };
}
