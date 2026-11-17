import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkReadModel } from "../../pi-better-server/src/runtime/read-model.ts";
import { WorkQueries } from "../../pi-better-server/src/runtime/queries.ts";

// Replace only the OS transport. The client, collector, queries and source model
// execute normally, with a response held across actual initial publication.
const transportKey = "__workObservationBootstrapTransport";
const hooks = registerHooks({
    resolve(specifier, context, next) {
        if (specifier === "node:net" && context.parentURL?.endsWith("/shared-work-client.mjs"))
            return { url: "fixture:bootstrap-net", shortCircuit: true };
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url === "fixture:bootstrap-net") return { format: "module", shortCircuit: true,
            source: `export const connect = () => globalThis.${transportKey}();` };
        return next(url, context);
    },
});
const { startWorkObservation, stopWorkObservation, workObservation } = await import("../work-observation.ts");

for (const mode of ["ready", "stopped"]) test(`initial recipient collection drains readiness received during a rebuilding page: ${mode}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "recipient-bootstrap-")));
    writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
    const model = new WorkReadModel(root, "recipient-bootstrap", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.destroy = () => {};
    const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
        write: line => { socket.emit("data", line); return true; } });
    const queries = new WorkQueries(model, stream);
    let held = false, activeReads = 0;
    const errors = [];
    const reply = (id, data) => socket.emit("data", JSON.stringify({ id, success: true, data }) + "\n");
    socket.write = line => {
        const command = JSON.parse(line);
        queueMicrotask(async () => {
            try {
                if (command.type === "hello") { reply(command.id, {}); return; }
                const value = queries.handle(command);
                if (command.type === "runtime_get_snapshot" && command.scope.active === true) {
                    activeReads++;
                    if (!held) {
                        held = true;
                        assert.equal(value.status, "rebuilding");
                        assert.equal(value.observedRevisionVector.coordinator, "unknown");
                        await model.reconcile();
                        assert.equal(model.snapshot().status, "ready");
                    }
                }
                reply(command.id, value);
            } catch (error) { errors.push(error); reply(command.id, undefined); }
        });
        return true;
    };
    globalThis[transportKey] = () => socket;
    const seen = [];
    try {
        await startWorkObservation(root, { cwd: root, sessionId: "parent" }, () => {
            seen.push(workObservation());
            if (mode === "stopped" && held && workObservation()?.status === "rebuilding") stopWorkObservation();
        });
        assert.deepEqual(errors, []);
        assert.equal(held, true, "the original rebuilding response crosses real ready publication");
        assert.ok(seen.some(value => value?.status === "rebuilding"), "rebuilding is observable, not verified empty");
        if (mode === "stopped") {
            assert.equal(workObservation(), undefined, "queued readiness cannot restore a stopped generation");
            assert.equal(activeReads, 1, "stopping cancels the queued collection");
        } else {
            assert.equal(workObservation()?.status, "ready", "the admitted ready notification must survive the older page");
            assert.deepEqual(workObservation().rows, []);
            assert.ok(activeReads >= 2, "the newer notification receives its own collection");
        }
        const settledReads = activeReads;
        await new Promise(setImmediate);
        assert.equal(activeReads, settledReads, "settlement does not schedule another collection without demand");
    } finally {
        stopWorkObservation(); queries.close(); await model.close();
        delete globalThis[transportKey];
        rmSync(root, { recursive: true, force: true });
    }
});

test.after(() => hooks.deregister());
