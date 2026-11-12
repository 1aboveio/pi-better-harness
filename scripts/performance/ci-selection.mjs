import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function affectsProjectionPerformance(path) {
  if (["package.json", "package-lock.json", ".github/workflows/ci.yml", "scripts/sync-operation-coordinator.mjs",
    "scripts/performance-ci-selection.test.mjs"].includes(path)) return true;
  if (/^scripts\/performance\/.*\.(?:[cm]?[jt]s|json)$/.test(path)) return true;
  if (/^packages\/(?:pi-better-subagents|pi-better-goal|operation-coordinator|navigator)\/(?:package\.json|tsconfig[^/]*\.json)$/.test(path)) return true;
  if (/^packages\/pi-better-subagents\/(?:assignment-projection\.(?:mjs|d\.mts)|index\.ts|navigator\.(?:mjs|d\.mts)|shared-navigator\.ts|registry\.ts|session-store\.ts|goal-provider\.ts)$/.test(path)) return true;
  if (/^packages\/pi-better-subagents\/tests\/(?:assignment_projection[^/]*|navigator[^/]*|owned_registry_index)\.test\.mjs$/.test(path)) return true;
  if (/^packages\/pi-better-goal\/src\/(?:subagents|activity|index|types)\.ts$/.test(path)) return true;
  if (/^packages\/pi-better-goal\/src\/shared-assignment-(?:projection|observation)\.(?:mjs|d\.mts)$/.test(path)) return true;
  return /^packages\/operation-coordinator\/(?:src\/.*\.(?:ts|mjs)|assignment-observation\.mjs)$/.test(path)
    || /^packages\/navigator\/(?:src\/.*|[^/]+)\.(?:ts|mjs)$/.test(path);
}

export async function selectPerformance({ eventName, event, token, fetchImpl = fetch }) {
  if (eventName !== "pull_request") return { run: true, reason: eventName === "workflow_dispatch" ? "manual run" : "unknown event" };
  const pr = event.pull_request;
  const repository = event.repository?.full_name;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !Number.isSafeInteger(pr?.number)) {
    return { run: true, reason: "PR metadata or read token unavailable" };
  }
  const request = async (suffix) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${pr.number}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub PR file selection returned HTTP ${response.status}`);
    return response.json();
  };
  try {
    let count = 0;
    let relevant = false;
    // GitHub's endpoint returns at most 3,000 files. Incomplete results run the
    // budget check conservatively instead of silently skipping an affected PR.
    for (let page = 1; page <= 30; page++) {
      const files = await request(`/files?per_page=100&page=${page}`);
      if (!Array.isArray(files) || files.some((file) => typeof file.filename !== "string")) throw new Error("Malformed PR file list");
      count += files.length;
      relevant ||= files.some((file) => affectsProjectionPerformance(file.filename)
        || (typeof file.previous_filename === "string" && affectsProjectionPerformance(file.previous_filename)));
      if (files.length < 100 || count >= pr.changed_files) break;
    }
    if (count !== pr.changed_files) return { run: true, reason: "incomplete PR file list" };
    // The files endpoint describes the current PR. An older queued workflow
    // must not skip based on a newer head or base revision.
    const current = await request("");
    if (current.head?.sha !== pr.head?.sha || current.base?.sha !== pr.base?.sha) return { run: true, reason: "PR revision changed during selection" };
    return { run: relevant, reason: relevant ? "affected performance paths" : "unrelated paths", files: count };
  } catch (error) {
    return { run: true, reason: `path detection unavailable: ${error.message}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const result = await selectPerformance({ eventName: process.env.GITHUB_EVENT_NAME, event, token: process.env.GH_TOKEN });
  console.log(JSON.stringify(result));
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${result.run}\n`);
}
