import { openStore } from "../../index.ts";
import { workerOwner } from "../support.ts";

const store = openStore({ path: process.argv[2]! });
store.acceptTaskCancellation({
    owner: workerOwner, idempotencyKey: "cancel-build", operationId: "op-build-1",
    expectedLaunchToken: "launch_op-build-1", expectedTerminalRevision: 0,
    expectedHostId: "host-1", reason: "explicit stop",
});
process.kill(process.pid, "SIGKILL");
