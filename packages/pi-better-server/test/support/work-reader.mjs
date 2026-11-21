import { WorkClient } from "../../src/runtime/work-client.mjs";

const client = new WorkClient(process.env.WORK_SOCKET, process.env.WORK_AGENT_DIR);
const scope = JSON.parse(process.env.WORK_SCOPE);
await client.subscribe(scope);
process.send({ snapshot: client.snapshot });
process.on("message", async command => {
    if (command === "stop") { client.close(); process.exit(0); }
    else process.send({ snapshot: await client.get(scope) });
});
process.on("disconnect", () => { client.close(); process.exit(0); });
