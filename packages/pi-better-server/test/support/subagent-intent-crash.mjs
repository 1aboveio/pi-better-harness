import { openLaunchJournal } from "../../src/runtime/domain/subagents/managed-launch-journal.mjs";
process.once("message", request => {
    const { journal } = openLaunchJournal(request.path);
    const epoch = journal.epoch("crashing-server");
    journal.accept("original-recipient", "one-launch", "same-request", epoch);
    const attempt = journal.prepare("original-recipient", "one-launch", epoch, request.input);
    process.send({ epoch, id: attempt.id, token: attempt.token }, () => process.kill(process.pid, "SIGKILL"));
});
