import { Duplex } from "node:stream";
import { checkHello } from "../handshake.ts";
import { WorkClient } from "./work-client.mjs";
import type { WorkQueryExecutor } from "./query-executor.ts";

/** Hosted reads use the same bounded executor and client sequencing without a socket. */
export function createLocalWorkClient(executor: WorkQueryExecutor, agentDir: string): WorkClient {
  let connection: ReturnType<WorkQueryExecutor["connect"]>;
  const transport = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      const command = JSON.parse(String(chunk));
      if (command.type === "hello") {
        const result = checkHello(command, { agentDir, instanceId: executor.instanceId });
        this.push(JSON.stringify({ id: command.id, type: "response", success: result.ok, ...result }) + "\n");
      } else {
        void connection.handle(command).then(
          result => { if (!this.destroyed) this.push(`{"id":${JSON.stringify(command.id)},"success":true,"data":${result.json}}\n`); },
          error => { if (!this.destroyed) this.push(JSON.stringify({ id: command.id, success: false, error: String(error) }) + "\n"); },
        );
      }
      done();
    },
    destroy(error, done) { connection?.close(); done(error); },
  });
  // The worker's event output feeds the readable side; client requests use the writable side.
  const events = new Duplex({
    read() {},
    write(chunk, _encoding, done) { if (!transport.destroyed) transport.push(chunk); done(); },
  });
  connection = executor.connect(events);
  transport.once("close", () => events.destroy());
  return new WorkClient(transport, agentDir, ["runtime-background-state-v1"]);
}
