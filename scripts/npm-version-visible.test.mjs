/**
 * publish.yml waits for a published version with scripts/npm-version-visible.mjs
 * (#332). The old 12 x 10 s `npm view` loop timed out on publishes that had
 * succeeded, which skipped the tag and GitHub release.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const script = join(repoRoot, "scripts", "npm-version-visible.mjs");

/** A registry that serves the version document only after `hiddenFor` requests. */
async function fakeRegistry(hiddenFor) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== "/pi-better-demo/1.2.3" || requests.length <= hiddenFor) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "pi-better-demo", version: "1.2.3" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((done) => server.close(done)) };
}

function run(args, registry) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        NPM_VERSION_REGISTRY: registry,
        NPM_VERSION_INITIAL_DELAY_MS: "20",
        NPM_VERSION_MAX_DELAY_MS: "80",
        NPM_VERSION_SKIP_NPM_VIEW: "1",
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => done({ code, output }));
  });
}

test("waits, with backoff, until the registry's version document appears", async () => {
  const registry = await fakeRegistry(4);
  try {
    const { code, output } = await run(["pi-better-demo", "1.2.3", "--wait-seconds", "5"], registry.url);
    assert.equal(code, 0, output);
    assert.match(output, /pi-better-demo@1\.2\.3 is on npm \(registry version document, attempt 5\)/);
    assert.deepEqual(registry.requests, Array(5).fill("/pi-better-demo/1.2.3"));
  } finally {
    await registry.close();
  }
});

test("fails once the deadline passes, and checks only once without --wait-seconds", async () => {
  const registry = await fakeRegistry(Number.POSITIVE_INFINITY);
  try {
    const once = await run(["pi-better-demo", "1.2.3"], registry.url);
    assert.equal(once.code, 1, once.output);
    assert.equal(registry.requests.length, 1);
    assert.match(once.output, /is not visible on npm: registry .* answered 404/);

    const started = Date.now();
    const waited = await run(["pi-better-demo", "1.2.3", "--wait-seconds", "0.5"], registry.url);
    assert.equal(waited.code, 1, waited.output);
    assert.ok(Date.now() - started < 5_000, "the wait is bounded by --wait-seconds");
    assert.ok(registry.requests.length > 3, `expected several checks, saw ${registry.requests.length}`);
  } finally {
    await registry.close();
  }
});

test("rejects a missing version", async () => {
  const { code } = await run(["pi-better-demo"], "http://127.0.0.1:9");
  assert.equal(code, 2);
});

function step(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `publish.yml has no "${name}" step`);
  const next = workflow.indexOf("\n      - name: ", start + 1);
  return { start, body: workflow.slice(start, next < 0 ? undefined : next) };
}

test("publish.yml waits about ten minutes on the registry document before tagging and releasing", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");
  const publish = step(workflow, "Publish package");
  const verify = step(workflow, "Verify npm version");
  const release = step(workflow, "Create GitHub release");

  assert.match(publish.body, /if node scripts\/npm-version-visible\.mjs "\$PACKAGE" "\$VERSION"; then/,
    "a rerun after a slow publish must see the version and skip republishing");
  assert.match(verify.body, /run: node scripts\/npm-version-visible\.mjs "\$PACKAGE" "\$VERSION" --wait-seconds (\d+)/);
  const waitSeconds = Number(verify.body.match(/--wait-seconds (\d+)/)[1]);
  assert.ok(waitSeconds >= 540 && waitSeconds <= 900, `verify waits ${waitSeconds} s`);
  const timeoutMinutes = Number(verify.body.match(/timeout-minutes: (\d+)/)?.[1]);
  assert.ok(timeoutMinutes * 60 > waitSeconds, "the step timeout must outlast the wait");
  assert.doesNotMatch(verify.body, /continue-on-error/);
  assert.ok(publish.start < verify.start && verify.start < release.start, "tag and release follow the verified publish");
  assert.match(release.body, /git tag -a "\$TAG"/);
  assert.match(release.body, /gh release create "\$TAG"/);
});
