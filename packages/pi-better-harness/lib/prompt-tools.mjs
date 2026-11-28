import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { defaultAgentDir } from "./install-settings.mjs";
import { activatePrompt, promptSource } from "./instructions.mjs";
import { activeRevision, begin, createCandidate, end, history, readRevision, recordEvaluation } from "./prompt-revisions.mjs";

function difference(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let first = 0;
  while (first < a.length && a[first] === b[first]) first++;
  let tail = 0;
  while (tail < Math.min(a.length, b.length) - first && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++;
  return { line: first + 1, removed: a.slice(first, a.length - tail), added: b.slice(first, b.length - tail) };
}

function swapModule(payload, baseline, candidate) {
  const body = structuredClone(payload);
  const expected = [begin, baseline.rendered, end].join("\n");
  const systems = body.messages.filter(m => ["system", "developer"].includes(m.role) && typeof m.content === "string");
  const matches = systems.filter(m => m.content.replaceAll("\r\n", "\n").includes(expected));
  if (matches.length !== 1) throw Error("The active managed block was shadowed or the captured session loaded a different revision.");
  const message = matches[0];
  const block = message.content.includes(expected) ? expected : expected.replaceAll("\n", "\r\n");
  if (message.content.split(block).length !== 2) throw Error("Ambiguous managed block in the captured input");
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  message.content = message.content.replace(block, () => [begin, candidate.rendered.replaceAll("\n", eol), end].join(eol));
  return body;
}

async function generate(payload, model, ctx, signal) {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw Error(auth.error);
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ baseURL: model.baseUrl, apiKey: auth.apiKey ?? "unused",
    defaultHeaders: { ...model.headers, ...auth.headers }, maxRetries: 0 });
  const stream = await client.chat.completions.create(payload, { signal });
  let text = "";
  let requiresTurnReplay = false;
  let finish;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    text += choice.delta.content ?? "";
    requiresTurnReplay ||= !!(choice.delta.tool_calls?.length || choice.delta.function_call);
    finish = choice.finish_reason ?? finish;
  }
  if (!finish) throw Error("Incomplete response replay");
  return { text, finish, requiresTurnReplay: requiresTurnReplay || ["tool_calls", "function_call"].includes(finish) };
}

export default function registerPromptTools(pi) {
  const dir = defaultAgentDir();
  if (promptSource(dir) !== "modular") return;
  let capture;
  let run;
  const string = Type.String({ minLength: 1 });
  const tool = (name, description, fields, execute) => pi.registerTool({
    name, label: name, description, parameters: Type.Object(fields),
    async execute(_call, args, signal, _update, ctx) {
      const details = await execute(args, ctx, signal);
      return { details, content: [{ type: "text", text: JSON.stringify(details) }] };
    },
  });
  function active() {
    if (promptSource(dir) !== "modular") throw Error("Enable modular Harness instructions and reload.");
    return activeRevision(dir);
  }
  tool("prompt_list", "Inspect modular instructions, selected revision and last captured answer.", {}, (_, ctx) => {
    const current = activeRevision(dir);
    const system = ctx.getSystemPrompt().replaceAll("\r\n", "\n");
    const start = system.indexOf(begin + "\n");
    const finish = system.indexOf("\n" + end, start);
    const loaded = start >= 0 && finish > start ? system.slice(start + begin.length + 1, finish) : undefined;
    return { source: promptSource(dir), active: current.id, modules: Object.keys(current.modules),
      loadedDigest: loaded === undefined ? undefined : createHash("sha256").update(loaded).digest("hex"),
      activeLoaded: loaded === current.rendered,
      history: history(dir), captured: capture?.reference ? capture.id : undefined };
  });
  tool("prompt_read", "Read a module at a specific revision.", { revision: string, module: string }, args => {
    const source = readRevision(dir, args.revision);
    if (!Object.hasOwn(source.modules, args.module)) throw Error("Unknown module. Use prompt_list.");
    return { revision: source.id, text: source.modules[args.module] };
  });
  tool("prompt_edit", "Create a candidate by replacing one module.", { base: string, module: string, text: string },
    args => createCandidate(dir, active().id, args.base, args.module, args.text));

  pi.registerCommand("prompt-capture", { description: "Keep the next response input in memory for paired replay.",
    handler: async (_, ctx) => {
      if (ctx.model?.api !== "openai-completions") throw Error("Response capture supports openai-completions models.");
      active();
      capture = { id: randomUUID() };
      run = undefined;
      ctx.ui.notify(`Capturing the next response for case ${capture.id}.`, "info");
    } });
  pi.on("before_provider_request", (event, ctx) => {
    if (!capture || capture.reference || !Array.isArray(event.payload?.messages)) return;
    capture.payload = structuredClone(event.payload);
    capture.model = structuredClone(ctx.model);
  });
  pi.on("message_end", event => {
    if (capture?.payload && !capture.reference && event.message.role === "assistant") {
      if (["error", "aborted"].includes(event.message.stopReason)) {
        capture = undefined;
        return;
      }
      capture.reference = structuredClone(event.message.content.filter(part => part.type !== "thinking"));
    }
  });
  pi.on("session_shutdown", () => { capture = undefined; run = undefined; });
  tool("prompt_replay", "Generate both arms from a captured writing input. No requested tools are executed.",
    { caseId: string, candidate: string }, async (args, ctx, signal) => {
      const selected = capture;
      if (!selected?.reference || selected.id !== args.caseId) throw Error("Missing pre-answer input. Run /prompt-capture before the selected answer.");
      const { payload, model } = selected;
      if (model?.api !== "openai-completions" || payload.stream !== true || (payload.n ?? 1) !== 1)
        throw Error("Replay requires a single streamed openai-completions response");
      const baseline = active();
      const candidate = readRevision(dir, args.candidate);
      if (candidate.template !== baseline.template || Object.keys(baseline.modules).filter(k => candidate.modules[k] !== baseline.modules[k]).length !== 1)
        throw Error("Choose a candidate with exactly one changed module.");
      const original = swapModule(payload, baseline, baseline);
      const changed = swapModule(payload, baseline, candidate);
      const baselineOutput = await generate(original, model, ctx, signal);
      const candidateOutput = await generate(changed, model, ctx, signal);
      const { messages, tools, ...settings } = payload;
      run = { id: randomUUID(), caseId: selected.id, active: baseline.id, candidate: candidate.id,
        provider: model.provider, model: model.id, settings, inputDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        reference: selected.reference, baselineOutput, candidateOutput,
        difference: difference(baselineOutput.text, candidateOutput.text),
        requiresTurnReplay: baselineOutput.requiresTurnReplay || candidateOutput.requiresTurnReplay };
      return run;
    });
  tool("prompt_compare", "Record the rubric and judgment for a paired replay.",
    { runId: string, rubric: string, judgment: string }, args => {
      if (!run || run.id !== args.runId) throw Error("Unknown run. Use the ID returned by prompt_replay.");
      const result = { ...run, rubric: args.rubric, judgment: args.judgment };
      return { evaluation: recordEvaluation(dir, result), ...result };
    });
  for (const action of ["promote", "rollback"]) {
    const fields = { from: string, to: string };
    if (action === "promote") fields.evidence = string;
    tool("prompt_" + action, "Request maintainer approval to " + action + " a revision.", fields, async (args, ctx) => {
      const from = readRevision(dir, args.from);
      const to = readRevision(dir, args.to);
      const { removed, added } = difference(from.rendered, to.rendered);
      const changes = [...removed.map(line => "- " + line), ...added.map(line => "+ " + line)];
      const question = [`Change active revision from ${args.from} to ${args.to}?`, "", ...changes].join("\n");
      if (!ctx.hasUI || !await ctx.ui.confirm("Harness prompt " + action, question))
        throw Error("Activation requires explicit maintainer confirmation.");
      activatePrompt(dir, { ...args, action });
      return { active: active().id };
    });
  }
}
