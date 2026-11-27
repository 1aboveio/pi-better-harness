import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { observeFixtureChild, stopFixtureChild } from "./fixture-child.mjs";

const launch = async () => {
    const child = fork(new URL("./fixtures/fixture-child-process.mjs", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    observeFixtureChild(child);
    await once(child, "message");
    return child;
};

test("fixture shutdown awaits a disconnected child and can repeat after exit", { timeout: 5000 }, async () => {
    const child = await launch();
    const disconnected = once(child, "disconnect");
    child.send("disconnect"); await disconnected;
    assert.equal(child.exitCode, null, "exercise disconnect before exit notification");
    await stopFixtureChild(child);
    assert.equal(child.exitCode, 0);
    await stopFixtureChild(child);
});

test("shutdown EPIPE during send still awaits the real child's exit", { timeout: 5000 }, async () => {
    const child = await launch();
    const send = child.send.bind(child);
    child.send = (_message, callback) => {
        send("disconnect");
        callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    };
    await stopFixtureChild(child);
    assert.equal(child.exitCode, 0, "closed pipe must not short circuit exit observation");
});

test("shutdown retains unexpected IPC errors after the real child exits", { timeout: 5000 }, async () => {
    const child = await launch();
    const send = child.send.bind(child);
    child.send = (_message, callback) => {
        send("stop");
        callback(Object.assign(new Error("unexpected fixture failure"), { code: "EACCES" }));
    };
    await assert.rejects(stopFixtureChild(child), /unexpected fixture failure/);
    assert.equal(child.exitCode, 0);
});

test("already exited fixture crashes are reported rather than hidden as closed IPC", { timeout: 5000 }, async () => {
    const child = await launch();
    const exited = once(child, "exit");
    child.send("fail"); await exited;
    await assert.rejects(stopFixtureChild(child), /exited \(2\)/);
});

test("exit-one fixture evidence survives the exit-before-cleanup gap", { timeout: 5000 }, async t => {
    const child = await launch();
    const closed = once(child, "close");
    child.send("crash"); await closed;
    const check = error => {
        assert.match(error.message, /exited \(1\): first fixture failure before cleanup/);
        assert.deepEqual(error.fixture, { pid: child.pid, stderr: "first fixture failure before cleanup\n", exitCode: 1, signal: null });
        t.diagnostic(JSON.stringify(error.fixture));
        return true;
    };
    await assert.rejects(stopFixtureChild(child), check);
    await assert.rejects(stopFixtureChild(child), check);
});

test("fixture evidence also accompanies an exit during the shutdown request", { timeout: 5000 }, async () => {
    const child = await launch();
    await assert.rejects(stopFixtureChild(child, "crash"), error => {
        assert.equal(error.fixture.exitCode, 1);
        assert.equal(error.fixture.stderr, "first fixture failure before cleanup\n");
        return true;
    });
});
