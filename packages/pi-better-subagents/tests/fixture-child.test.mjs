import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { stopFixtureChild } from "./fixture-child.mjs";

const launch = async () => {
    const child = fork(new URL("./fixtures/fixture-child-process.mjs", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
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
