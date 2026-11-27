import test from "node:test";
import assert from "node:assert/strict";
import { affectsProjectionPerformance, selectPerformance } from "./performance/ci-selection.mjs";

const pr = { number: 726, changed_files: 1, head: { sha: "head" }, base: { sha: "base" } };
const eventFor = (count = 1) => ({ repository: { full_name: "owner/repo" }, pull_request: { ...pr, changed_files: count } });
const response = (value) => ({ ok: true, json: async () => value });

test("performance paths include the runtime, tests, generated modules and configuration", () => {
  for (const path of ["packages/pi-better-subagents/index.ts", "packages/pi-better-subagents/assignment-projection.d.mts",
    "packages/pi-better-subagents/navigator.mjs", "packages/pi-better-goal/src/shared-assignment-projection.mjs",
    "packages/pi-better-goal/src/subagents.ts", "packages/pi-better-goal/src/activity.ts", "packages/pi-better-goal/package.json",
    "scripts/performance/assignment-projection-stress.mjs", "package-lock.json", ".github/workflows/ci.yml"])
    assert.equal(affectsProjectionPerformance(path), true, path);
  for (const path of ["README.md", "docs/plans/cpu.md", "packages/pi-better-subagents/README.md", "scripts/performance/README.md",
    "packages/pi-better-ssh/src/index.ts", ".github/workflows/publish.yml"])
    assert.equal(affectsProjectionPerformance(path), false, path);
});

test("manual runs select performance without calling the API", async () => {
  assert.deepEqual(await selectPerformance({ eventName: "workflow_dispatch", event: {}, fetchImpl: () => { throw new Error("unexpected API"); } }),
    { run: true, reason: "manual run" });
});

test("docs-only PRs skip, including PRs from forks using only the read token", async () => {
  const event = eventFor();
  event.pull_request.head.repo = { full_name: "fork/repo" };
  const result = await selectPerformance({ eventName: "pull_request", event, token: "test-read-token", fetchImpl: async (url, options) => {
    assert.ok(url.startsWith("https://api.github.com/repos/owner/repo/pulls/726"));
    assert.equal(options.headers.Authorization, "Bearer test-read-token");
    assert.equal(options.method, undefined);
    return response(url.includes("/files?") ? [{ filename: "docs/cpu.md" }] : pr);
  } });
  assert.equal(result.run, false);
});

test("pagination discovers a relevant file after the first hundred paths", async () => {
  const urls = [];
  const result = await selectPerformance({ eventName: "pull_request", event: eventFor(101), token: "token", fetchImpl: async (url) => {
    urls.push(url);
    if (new URL(url).searchParams.get("page") === "1") return response(Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })));
    if (new URL(url).searchParams.get("page") === "2") return response([{ filename: "packages/pi-better-subagents/index.ts" }]);
    return response(pr);
  } });
  assert.equal(result.run, true);
  assert.equal(result.files, 101);
  assert.equal(urls.length, 3);
});

test("large docs-only PRs skip after all pages have been checked", async () => {
  const result = await selectPerformance({ eventName: "pull_request", event: eventFor(101), token: "token", fetchImpl: async (url) => {
    if (new URL(url).searchParams.get("page") === "1") return response(Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })));
    if (new URL(url).searchParams.get("page") === "2") return response([{ filename: "README.md" }]);
    return response(pr);
  } });
  assert.equal(result.run, false);
  assert.equal(result.files, 101);
});

test("the API's 3,000-file cap cannot silently omit a relevant later file", async () => {
  let pages = 0;
  const result = await selectPerformance({ eventName: "pull_request", event: eventFor(3001), token: "token", fetchImpl: async () => {
    pages++;
    return response(Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })));
  } });
  assert.equal(result.run, true);
  assert.equal(result.reason, "incomplete PR file list");
  assert.equal(pages, 30);
});

test("renaming a relevant source to an unrelated path still selects performance", async () => {
  const result = await selectPerformance({ eventName: "pull_request", event: eventFor(), token: "token", fetchImpl: async (url) =>
    response(url.includes("/files?") ? [{ filename: "docs/retired.txt", previous_filename: "packages/pi-better-subagents/index.ts" }] : pr) });
  assert.equal(result.run, true);
});

test("incomplete or failed discovery and stale PR revisions run conservatively", async () => {
  for (const kind of ["incomplete", "error", "stale"]) {
    const result = await selectPerformance({ eventName: "pull_request", event: eventFor(kind === "incomplete" ? 2 : 1), token: "token", fetchImpl: async (url) => {
      if (kind === "error") return { ok: false, status: 403 };
      return response(url.includes("/files?") ? [{ filename: "docs/a.md" }] : { ...pr, head: { sha: "newer-head" } });
    } });
    assert.equal(result.run, true, kind);
  }
});
