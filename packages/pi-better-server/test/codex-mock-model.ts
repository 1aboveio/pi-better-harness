/**
 * A stand-in model server for tests that run the real Codex app-server: it speaks the
 * Responses API over SSE on a loopback port. A request can be held open so a test can
 * act while a turn is in flight, and every request body is recorded so a test can see
 * which user messages the model was actually sent.
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MockModel {
  readonly port: number;
  /** Request bodies, in order. */
  readonly requests: Array<{ input: any[]; tools?: any[] }>;
  /** Answer the next request with a tool call instead of a message. */
  queueToolCall(name: string, args: Record<string, unknown>, namespace?: string): void;
  /** Hold the next response open until `release()`; resolves when the request arrived. */
  holdNext(): { arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function message(id: string, text: string): Record<string, unknown> {
  return { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] };
}

export async function startMockModel(): Promise<MockModel> {
  const requests: MockModel["requests"] = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; namespace?: string }> = [];
  const holds: Array<{ arrived: () => void; released: Promise<void> }> = [];
  let count = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      let parsed: { input: any[]; tools?: any[] } = { input: [] };
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep the empty body */
      }
      requests.push(parsed);
      const n = ++count;
      const id = `resp_${n}`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(sse([{ type: "response.created", response: { id } }]));
      const hold = holds.shift();
      if (hold) {
        hold.arrived();
        await hold.released;
      }
      const call = toolCalls.shift();
      const item = call
        ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), arguments: JSON.stringify(call.args) }
        : message(`msg_${n}`, `ack ${n}`);
      res.write(
        sse([
          ...(call ? [] : [{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }]),
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
        ]),
      );
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    queueToolCall(name, args, namespace) {
      toolCalls.push({ name, args, ...(namespace ? { namespace } : {}) });
    },
    holdNext() {
      let arrived!: () => void;
      let release!: () => void;
      const arrivedPromise = new Promise<void>((resolve) => (arrived = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      holds.push({ arrived, released });
      return { arrived: arrivedPromise, release };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Point a CODEX_HOME at the mock model with no sign-in needed. */
export function writeMockConfig(home: string, port: number): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.toml"),
    [
      'model = "mock-model"',
      'model_provider = "mock"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      "check_for_update_on_startup = false",
      "",
      "[model_providers.mock]",
      'name = "mock"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n"),
  );
}
