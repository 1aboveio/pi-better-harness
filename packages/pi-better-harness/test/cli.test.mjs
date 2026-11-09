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

const pi = process.platform === "win32" ? "pi.cmd" : "pi";
const noHarness = () => ({ harnessRegistered: false });

test("install configures every component as a standalone Pi package", () => {
  const calls = [];
  const status = run(["install"], {
    preflight: noHarness,
    configure: () => {},
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.args), [...componentPackages, "pi-better-harness"].map((name) => ["install", `npm:${name}`]));
  assert.ok(calls.every((call) => call.command === pi));
  assert.ok(calls.every((call) => call.options.stdio === "inherit"));
});

test("install leaves consent prompts and scope selection to Pi", () => {
  const calls = [];
  const configured = [];
  const status = run(["install", "--local"], {
    preflight: (local) => {
      assert.equal(local, true);
      return { harnessRegistered: false };
    },
    configure: (local) => configured.push(local),
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.deepEqual(configured, [true]);
  for (const args of calls) {
    assert.deepEqual(args.slice(2), ["--local"]);
    assert.ok(!args.includes("--approve"));
    assert.ok(!args.includes("--no-approve"));
  }
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
  assert.deepEqual(calls, [...componentPackages, "pi-better-harness"].map((name) => ["remove", `npm:${name}`, "--local"]));
});

test("stops at the first failed Pi command and returns its status", () => {
  const calls = [];
  const status = run(["install"], {
    preflight: noHarness,
    configure: () => assert.fail("configure should not run"),
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

test("a preflight failure aborts before Pi installs anything", () => {
  const stderr = output();
  const status = run(["install"], {
    preflight: () => {
      throw new Error("unexpected settings shape");
    },
    spawn: () => assert.fail("spawn should not run"),
    stderr: stderr.stream,
  });

  assert.equal(status, 1);
  assert.match(stderr.read(), /Refusing to install: unexpected settings shape/);
});

test("a failed filter write removes the Harness registration this run added", () => {
  const calls = [];
  const stderr = output();
  const status = run(["install", "--local"], {
    preflight: noHarness,
    configure: () => {
      throw new Error("settings are read-only");
    },
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0 };
    },
    stderr: stderr.stream,
  });

  assert.equal(status, 1);
  assert.deepEqual(calls.at(-1), ["remove", "npm:pi-better-harness", "--local"]);
  assert.equal(calls.filter((args) => args[0] === "remove").length, 1);
  assert.match(stderr.read(), /Failed to configure Harness resources: settings are read-only/);
  assert.match(stderr.read(), /Removed the unfiltered Harness registration/);
});

test("a failed filter write keeps a Harness registration that predates this run", () => {
  const calls = [];
  const stderr = output();
  const status = run(["install"], {
    preflight: () => ({ harnessRegistered: true }),
    configure: () => {
      throw new Error("lock unavailable");
    },
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0 };
    },
    stderr: stderr.stream,
  });

  assert.equal(status, 1);
  assert.ok(calls.every((args) => args[0] === "install"));
  assert.match(stderr.read(), /Kept the existing Harness registration unchanged/);
});

test("a failed recovery tells the user how to remove the Harness registration", () => {
  const stderr = output();
  const status = run(["install"], {
    preflight: noHarness,
    configure: () => {
      throw new Error("write failed");
    },
    spawn: (_command, args) => (args[0] === "remove" ? { status: 4 } : { status: 0 }),
    stderr: stderr.stream,
  });

  assert.equal(status, 1);
  assert.match(stderr.read(), /Could not remove the unfiltered Harness registration \(exit 4\)/);
  assert.match(stderr.read(), /Run `pi remove npm:pi-better-harness` before starting Pi/);
});
