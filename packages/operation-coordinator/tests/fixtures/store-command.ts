/**
 * Test fixture: drive the coordinator store from a separate process.
 *
 * Cross-process tests use this to prove that a record written by one process is
 * visible to another, and that two processes racing on one wait admit exactly one
 * resume claim. The fixture prints a single JSON line and sets a non-zero exit
 * code for a refusal; it never decides policy of its own.
 *
 * Usage: node --import tsx tests/fixtures/store-command.ts <dbPath> <command> [json]
 */
import { isStoreError, openStore } from "../../index.ts";

const [path, command, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};

function output(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (!path || !command) {
    output({ ok: false, code: "usage" });
    process.exitCode = 2;
} else {
    const store = openStore({ path });
    try {
        if (command === "settle") {
            const result = store.recordTerminalOutcome(args as never);
            output({
                ok: true,
                recorded: result.recorded,
                phase: result.operation.phase,
                revision: result.operation.terminalRevision,
                ready: result.ready.length,
                outbox: result.outbox.length,
            });
        } else if (command === "claim") {
            const result = store.claimResume(args as never);
            output({ ok: true, claimId: result.claim.claimId, state: result.claim.state });
        } else if (command === "snapshot") {
            const waitId = String(args.waitId);
            const wait = store.getWait({ waitId });
            output({
                ok: true,
                phase: wait?.phase ?? null,
                generation: wait?.generation ?? null,
                outbox: store.listOutbox({ waitId }).map((event) => ({
                    state: event.state,
                    evidence: event.evidence.length,
                })),
            });
        } else {
            output({ ok: false, code: "unknown-command" });
            process.exitCode = 2;
        }
    } catch (error) {
        if (isStoreError(error)) {
            output({ ok: false, code: error.code, message: error.message });
        } else {
            output({
                ok: false,
                code: "unexpected",
                message: error instanceof Error ? error.message : String(error),
            });
        }
        process.exitCode = 3;
    } finally {
        store.close();
    }
}
