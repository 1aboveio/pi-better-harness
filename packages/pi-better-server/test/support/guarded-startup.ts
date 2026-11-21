import { WorkClient } from "../../src/runtime/work-client.mjs";

/** Keep the announced server alive while the separate SDK frontend loads. */
export async function retainGuardedStartup(client: Pick<WorkClient, "ready" | "close">, socket: string) {
  try {
    const hello = await client.ready;
    return { ready: { ready: socket, instanceId: hello.instanceId }, release: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}
