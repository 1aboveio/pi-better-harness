/**
 * External (stub) Mergify delivery watcher used by the whole-path acceptance
 * test. It is launched as a REAL supervised background process by the bundled
 * `watch_delivery` recipe through the installed-watcher resolution path; the
 * recipe never generates a polling predicate and never asks an LLM to wait.
 *
 * Writes its literal argv to PI_ACCEPTANCE_WATCH_MARKER and prints a terminal
 * verdict line that the parent reads back through bg_task_log.
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const marker = process.env.PI_ACCEPTANCE_WATCH_MARKER;
const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
};
const repo = flag("--repo") ?? "";
const pr = flag("--pr") ?? "";

if (marker) {
    writeFileSync(marker, JSON.stringify({ argv, pid: process.pid, repo, pr }));
}

// The verdict is the watcher's own domain evidence; it is not fabricated by the
// test process. A non-zero exit would settle the operation as failed.
console.log(JSON.stringify({
    source: "mergify/watch-pr-delivery",
    repo,
    pr: Number(pr),
    verdict: "merged",
    mergeCommit: "0123456789abcdef0123456789abcdef01234567",
    queued: true,
}));
process.exit(0);
