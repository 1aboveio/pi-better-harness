import assert from "node:assert/strict";
import test from "node:test";

import { componentPackages, run } from "../lib/cli.mjs";

function output() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    read: () => value,
  };
}

test("install configures every component as a standalone Pi package", () => {
  const calls = [];
  const status = run(["install"], {
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.args), componentPackages.map((name) => ["install", `npm:${name}`]));
  assert.ok(calls.every((call) => call.options.stdio === "inherit"));
});

test("uninstall removes every component with project-local scope", () => {
  const calls = [];
  const status = run(["uninstall", "--local"], {
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, componentPackages.map((name) => ["remove", `npm:${name}`, "--local"]));
});

test("stops at the first failed Pi command and returns its status", () => {
  const calls = [];
  const status = run(["install"], {
    spawn: (_command, args) => {
      calls.push(args);
      return { status: calls.length === 2 ? 7 : 0 };
    },
  });

  assert.equal(status, 7);
  assert.equal(calls.length, 2);
});

test("reports process launch errors", () => {
  const stderr = output();
  const status = run(["uninstall"], {
    spawn: () => ({ error: new Error("pi not found"), status: null }),
    stderr: stderr.stream,
  });

  assert.equal(status, 1);
  assert.match(stderr.read(), /pi not found/);
});

test("rejects unknown arguments without running Pi", () => {
  const stderr = output();
  const status = run(["update"], {
    spawn: () => assert.fail("spawn should not run"),
    stderr: stderr.stream,
  });

  assert.equal(status, 2);
  assert.match(stderr.read(), /Usage:/);
});