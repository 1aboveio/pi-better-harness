import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { HostedSession } from "../src/hosted-session.ts";
import { SessionRegistry } from "../src/registry.ts";
import { makeEnv } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function registryWithClosedSession() {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir, { recursive: true });
  const registry = new SessionRegistry({ serverDir: env.serverDir });
  cleanups.push(() => registry.shutdown());
  const { sessionId } = await registry.create({ type: "create_session", cwd: env.cwd });
  await registry.close(sessionId);
  return { registry, sessionId };
}

describe("registry open/close races", () => {
  it("close during an open that is still creating the session leaves it closed and refusing commands", async () => {
    const { registry, sessionId } = await registryWithClosedSession();
    const opening = registry.open(sessionId);
    const closing = registry.close(sessionId);
    await Promise.allSettled([opening, closing]);
    assert.equal(registry.get(sessionId), undefined);
    assert.equal(registry.entry(sessionId)?.status, "closed");
    assert.equal(registry.list().find((s) => s.sessionId === sessionId)?.live, false);
  });

  it("open during a close waits for the old session to dispose before building a new one", async () => {
    const { registry, sessionId } = await registryWithClosedSession();
    await registry.open(sessionId);
    const order: string[] = [];
    const dispose = HostedSession.prototype.dispose;
    const bindUi = HostedSession.prototype.bindUi;
    HostedSession.prototype.dispose = async function (this: HostedSession, options) {
      order.push("dispose-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await dispose.call(this, options);
      order.push("dispose-end");
    };
    HostedSession.prototype.bindUi = function (this: HostedSession) {
      order.push("bind");
      return bindUi.call(this);
    };
    cleanups.push(() => {
      HostedSession.prototype.dispose = dispose;
      HostedSession.prototype.bindUi = bindUi;
    });
    const closing = registry.close(sessionId);
    const reopening = registry.open(sessionId);
    await Promise.all([closing, reopening]);
    assert.deepEqual(order, ["dispose-start", "dispose-end", "bind"]);
    assert.ok(registry.get(sessionId));
    assert.equal(registry.entry(sessionId)?.status, "running");
  });

  function slowDispose() {
    const dispose = HostedSession.prototype.dispose;
    HostedSession.prototype.dispose = async function (this: HostedSession, options) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await dispose.call(this, options);
    };
    cleanups.push(() => {
      HostedSession.prototype.dispose = dispose;
    });
  }

  it("close, open, close in quick succession ends closed with nothing hosted", async () => {
    const { registry, sessionId } = await registryWithClosedSession();
    await registry.open(sessionId);
    slowDispose();
    const calls = [registry.close(sessionId), registry.open(sessionId), registry.close(sessionId)];
    await Promise.allSettled(calls);
    assert.equal(registry.entry(sessionId)?.status, "closed");
    assert.equal(registry.get(sessionId), undefined);
    assert.equal(registry.list().find((s) => s.sessionId === sessionId)?.live, false);
  });

  it("retire followed by open ends running and hosted, never closed with a live session", async () => {
    const { registry, sessionId } = await registryWithClosedSession();
    await registry.open(sessionId);
    slowDispose();
    await Promise.allSettled([registry.retire(sessionId), registry.open(sessionId)]);
    assert.equal(registry.entry(sessionId)?.status, "running");
    assert.ok(registry.get(sessionId));
  });

  it("open followed by retire ends closed with nothing hosted", async () => {
    const { registry, sessionId } = await registryWithClosedSession();
    slowDispose();
    await Promise.allSettled([registry.open(sessionId), registry.retire(sessionId)]);
    assert.equal(registry.entry(sessionId)?.status, "closed");
    assert.equal(registry.get(sessionId), undefined);
  });
});
