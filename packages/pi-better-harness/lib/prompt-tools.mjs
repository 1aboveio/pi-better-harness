import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { loadedBlock } from "./prompt-manager.mjs";
import { openPromptManager } from "./prompt-tui.mjs";
import { shareSession } from "./prompt-web.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { evaluateCases, inspectSuite, moduleSlot, proposalCases, writingCases } from "./prompt-cases.mjs";
import { defaultAgentDir } from "./install-settings.mjs";
import { activatePrompt, promptSource } from "./instructions.mjs";
import { recordedDispatch, recordedTools, replayTurn } from "./prompt-turn.mjs";
import { checkpoint, taskArm } from "./prompt-task.mjs";
import { activeRevision, attribution, begin, createCandidate, end, history, orderedModules, readRevision, recordEvaluation } from "./prompt-revisions.mjs";

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
  const calls = [];
  let requiresTurnReplay = false;
  let finish;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    text += choice.delta.content ?? "";
    for (const part of choice.delta.tool_calls ?? []) {
      const call = calls[part.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      call.id += part.id ?? "";
      call.function.name += part.function?.name ?? "";
      call.function.arguments += part.function?.arguments ?? "";
    }
    requiresTurnReplay ||= !!(choice.delta.tool_calls?.length || choice.delta.function_call);
    finish = choice.finish_reason ?? finish;
  }
  if (!finish) throw Error("Incomplete response replay");
  return { text, calls, finish, requiresTurnReplay: requiresTurnReplay || ["tool_calls", "function_call"].includes(finish) };
}

export default function registerPromptTools(pi) {
  const dir = defaultAgentDir();
  let shared;
  let suiteLabel = "Imported reviewed suite";
  const connection = ctx => {
    const name = [ctx.sessionManager?.getSessionName?.() ?? ctx.cwd, ctx.sessionManager?.getSessionId?.()].filter(Boolean).join(" / ");
    const suites = () => [{ id: "bundled", label: "Bundled writing cases", cases: writingCases },
      ...(cases === writingCases ? [] : [{ id: createHash("sha256").update(JSON.stringify(cases)).digest("hex"), label: suiteLabel, cases }])];
    const models = () => [...new Map([ctx.model, ...(ctx.modelRegistry?.getAvailable?.() ?? [])].filter(m => m?.api === "openai-completions")
      .map(m => [m.provider + "/" + m.id, m])).entries()];
    return {
      describe() {
        const lastUser = capture?.payload?.messages.findLast(m => m.role === "user");
        return { name, loaded: loadedBlock(ctx), captures: capture?.reference ? [{ id: capture.id,
          label: typeof lastUser?.content === "string" ? lastUser.content.slice(0, 100) : "Captured user request",
          model: capture.model.provider + "/" + capture.model.id }] : [],
          suites: suites().map(({ id, label }) => ({ id, label })), models: models().map(([key]) => key) };
      },
      async run(args) {
        if (active().id !== args.base) throw Error("Active revision changed; refresh the candidate.");
        if (args.action === "replay") return replay(args, ctx, undefined);
        if (args.action !== "evaluate") throw Error("Unknown experiment.");
        const revision = readRevision(dir, args.candidate);
        const suite = suites().find(s => s.id === args.suite);
        const model = models().find(([key]) => key === args.model)?.[1];
        if (!suite) throw Error("Suite changed or is unavailable. Refresh the selection.");
        if (!model || !Number.isInteger(args.samples) || args.samples < 1 || args.samples > 16)
          throw Error("Select a supported openai-completions model and 1 to 16 samples.");
        return { ...await evaluateCases(suite.cases, active(), revision, args.samples, () => model,
          body => generate(body, model, ctx), undefined), suite: suite.label, model: args.model, session: name };
      },
    };
  };
  const openManager = ctx => {
    const session = connection(ctx);
    return openPromptManager(dir, ctx.ui, session, async () => {
      if (shared) { shared.close(); shared = undefined; return "Browser connection closed."; }
      shared = await shareSession(dir, session.describe().name, session);
      return "Session available in the browser connection selector.";
    }, () => Boolean(shared));
  };
  pi.events?.on("harness-settings:request", () => pi.events.emit("harness-settings:register",
    { id: "prompt-manager", label: "Prompt manager", command: "/prompt-manager", open: openManager }));
  pi.registerCommand("prompt-manager", { description: "Manage Harness prompt revisions", handler: (_, ctx) => openManager(ctx) });
  let capture;
  let run;
  let cases = writingCases;
  let comparison;
  let learning = false;
  let proposal;
  let task;
  pi.on("session_shutdown", () => {
    shared?.close();
    shared = undefined;
    task?.snapshot.dispose();
    task = undefined;
    capture = undefined;
    run = undefined;
    cases = writingCases;
    comparison = undefined;
    learning = false;
    proposal = undefined;
  });
  if (promptSource(dir) !== "modular") return;
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
    const modules = orderedModules(current);
    return { source: promptSource(dir), active: current.id, modules, bundled:modules.filter(r => r.origin === "bundled"),
      user:modules.filter(r => r.origin === "user"), composition:attribution(current),
      loadedDigest: loaded === undefined ? undefined : createHash("sha256").update(loaded).digest("hex"),
      activeLoaded: loaded === current.rendered,
      history: history(dir), captured: capture?.reference ? capture.id : undefined };
  });
  tool("prompt_read", "Read a module at a specific revision.", { revision: string, module: string }, args => {
    const source = readRevision(dir, args.revision);
    const row = orderedModules(source).find(r => r.id === args.module || r.id === "bundled:" + args.module);
    if (!row) throw Error("Unknown module. Use prompt_list.");
    return { revision: source.id, ...row };
  });
  tool("prompt_edit", "Create or edit a user:name module in a candidate. Bundled text is read-only.", { base: string, module: string, text: string },
    args => createCandidate(dir, active().id, args.base, args.module, args.text));

  pi.registerCommand("prompt-capture", { description: "Keep the next response input in memory for paired replay.",
    handler: async (_, ctx) => {
      if (ctx.model?.api !== "openai-completions") throw Error("Response capture supports openai-completions models.");
      active();
      task?.snapshot.dispose();
      task = undefined;
      capture = { id: randomUUID(), recording: true, records: [] };
      run = undefined;
      ctx.ui.notify(`Capturing the next response for case ${capture.id}.`, "info");
    } });
  pi.registerCommand("prompt-task-capture", { description: "Checkpoint the current workspace before a task and capture its user turns.",
    handler: async (path, ctx) => {
      if (ctx.model?.api !== "openai-completions" || !path.trim()) throw Error("Choose an openai-completions model and a task manifest.");
      const spec = JSON.parse(await readFile(resolve(ctx.cwd, path.trim()), "utf8"));
      const snapshot = await checkpoint(ctx.cwd, spec);
      task?.snapshot.dispose();
      task = { snapshot, inputs: [], next: true };
      capture = { id: randomUUID(), recording: true, records: [] };
      run = undefined;
      ctx.ui.notify(`Checkpointed ${snapshot.head} for ${spec.turns} user turns.`, "info");
    } });
  pi.on("before_provider_request", (event, ctx) => {
    if (task && task.inputs.length < task.snapshot.spec.turns) {
      const { messages, ...settings } = event.payload ?? {};
      if (!Array.isArray(messages)) { task.problem = "Missing task request messages"; return; }
      if (task.next) {
        const input = messages.at(-1);
        if (input?.role !== "user") task.problem = "Missing original user input";
        else task.inputs.push(structuredClone(input));
        if (task.previous && (messages.length !== task.previous.length + 2 || messages.at(-2).role !== "assistant" ||
          !isDeepStrictEqual(messages.slice(0, -2), task.previous))) task.problem = "Task history changed between user turns";
        task.next = false;
      }
      if (task.settings && (!isDeepStrictEqual(settings, task.settings) || ctx.model?.provider !== capture?.model?.provider))
        task.problem = "Task model, provider options or tool definitions changed";
      task.settings = structuredClone(settings);
      task.previous = structuredClone(messages);
    }
    if (!capture?.recording || !Array.isArray(event.payload?.messages)) return;
    if (capture.reference) {
      capture.records = recordedTools(event.payload.messages, capture.payload.messages.length);
      return;
    }
    capture.payload = structuredClone(event.payload);
    capture.model = structuredClone(ctx.model);
  });
  pi.on("agent_end", () => { if (capture) capture.recording = false; if (task) task.next = true; });
  pi.on("message_end", event => {
    if (capture?.payload && !capture.reference && event.message.role === "assistant") {
      if (["error", "aborted"].includes(event.message.stopReason)) {
        capture = undefined;
        return;
      }
      capture.reference = structuredClone(event.message.content.filter(part => part.type !== "thinking"));
    }
  });
  tool("prompt_task_replay", "Restore a captured workspace independently for two bounded multi-turn task runs.",
    { caseId: string, candidate: string, budget: Type.Integer({ minimum: 1, maximum: 64 }) }, async (args, ctx, signal) => {
      if (!task || !capture?.reference || args.caseId !== capture.id || task.inputs.length !== task.snapshot.spec.turns)
        throw Error("Missing task checkpoint or original task inputs.");
      if (task.problem) throw Error(task.problem);
      const baseline = active();
      const candidate = readRevision(dir, args.candidate);
      const { snapshot, inputs } = task;
      const { payload, model } = capture;
      const arm = revision => taskArm(snapshot, swapModule(payload, baseline, revision), inputs.slice(1),
        body => generate(body, model, ctx, signal), args.budget, signal);
      return { caseId: args.caseId, active: baseline.id, candidate: candidate.id, restored: { head: snapshot.head, entries: snapshot.entries },
        inputs, baselineOutput: await arm(baseline), candidateOutput: await arm(candidate) };
    });
  pi.registerCommand("prompt-export", { description: "Review and export the last replay case to a new JSON file.",
    handler: async (path, ctx) => {
      if (!ctx.hasUI || !path.trim() || !capture || !run || run.caseId !== capture.id)
        throw Error("Replay the captured input first, then use /prompt-export <new-file.json> in the UI.");
      const payload = swapModule(capture.payload, readRevision(dir, run.active), { rendered: moduleSlot });
      const draft = { version: 1, cases: [{ id: capture.id, level: "response", provider: run.provider, model: run.model, payload,
        expected: "", counterexample: "", failure: "", rubric: { required: [], forbidden: [] } }] };
      const reviewed = await ctx.ui.editor("Review and redact captured input. Add expected behavior, counterexample and rubric.", JSON.stringify(draft, null, 2));
      if (!reviewed) return;
      inspectSuite(JSON.parse(reviewed));
      await writeFile(resolve(ctx.cwd, path.trim()), reviewed + "\n", { flag: "wx", mode: 0o600 });
    } });
  pi.registerCommand("prompt-import", { description: "Load a reviewed case suite, or use the bundled writing cases with no argument.",
    handler: async (path, ctx) => {
      cases = path.trim() ? inspectSuite(JSON.parse(await readFile(resolve(ctx.cwd, path.trim()), "utf8"))) : writingCases;
      suiteLabel = path.trim();
      comparison = undefined;
      ctx.ui.notify(`Loaded ${cases.length} prompt cases.`, "info");
    } });
  const evaluate = (selected, candidate, count, ctx, signal, model = ctx.model) => evaluateCases(selected, active(), candidate, count,
    c => c.model ? ctx.modelRegistry.find(c.provider, c.model) : model,
    (body, model) => generate(body, model, ctx, signal), signal);
  tool("prompt_evaluate", "Compare revisions on the imported suite or bundled writing cases.",
    { candidate: Type.Optional(string), samples: Type.Integer({ minimum: 1, maximum: 16 }) }, async (args, ctx, signal) => {
      comparison = await evaluate(cases, args.candidate ? readRevision(dir, args.candidate) : active(), args.samples, ctx, signal);
      return comparison;
    });
  pi.registerCommand("prompt-learning", { description: "Enable case-based proposals for this session (on/off), or discard the pending proposal.",
    handler: async (args, ctx) => {
      if (!["on", "off", "discard"].includes(args.trim())) throw Error("Use /prompt-learning on, off or discard.");
      if (args.trim() !== "discard") learning = args.trim() === "on";
      proposal = undefined;
      ctx.ui.notify(`Case-based proposals ${learning ? "enabled" : "disabled"}. Pending proposal cleared.`, "info");
    } });
  tool("prompt_propose", "Propose one module edit for repeated observed failures and rerun those cases and a counterexample.",
    { module: string, text: string, failures: Type.Array(string, { minItems: 2 }), counterexample: string },
    async (args, ctx, signal) => {
      if (!learning || !comparison || comparison.active !== active().id)
        throw Error("Enable /prompt-learning on and evaluate the current active revision.");
      const selected = proposalCases(comparison, args.failures, args.counterexample, cases);
      const before = comparison.results.filter(row => selected.some(c => c.id === row.id));
      const edit = createCandidate(dir, comparison.active, comparison.active, args.module, args.text);
      const after = await evaluate(selected, readRevision(dir, edit.id), comparison.sampleCount, ctx, signal);
      proposal = { id: edit.id, edit, before, after, cases: selected, counterexample: args.counterexample };
      return proposal;
    });
  tool("prompt_judge_proposal", "Record a judgment for the pending proposal and produce evidence for explicit promotion.",
    { candidate: string, judgment: string }, args => {
      if (!learning || !proposal || proposal.id !== args.candidate) throw Error("Unknown or discarded proposal.");
      const result = { ...proposal.after, proposal, judgment: args.judgment };
      if (result.results.some(row => row.status !== "scored" || row.samples.some(s => [s.baseline, s.candidate].some(a => a.status === "inconclusive"))))
        throw Error("Incomplete comparisons cannot authorize promotion. Inspect the proposal results.");
      return { evaluation: recordEvaluation(dir, result), judgment: args.judgment };
    });
  tool("prompt_turn_replay", "Replay a captured user turn using its recorded tool results.",
    { caseId: string, candidate: string, budget: Type.Integer({ minimum: 1, maximum: 64 }) }, async (args, ctx, signal) => {
      if (!capture?.reference || capture.id !== args.caseId) throw Error("Missing captured turn.");
      const baseline = active();
      const candidate = readRevision(dir, args.candidate);
      const { payload, records, model } = capture;
      const arm = revision => replayTurn(swapModule(payload, baseline, revision), {
        generate: body => generate(body, model, ctx, signal), dispatch: recordedDispatch(records), budget: args.budget, signal });
      return { caseId: args.caseId, active: baseline.id, candidate: candidate.id, baselineOutput: await arm(baseline), candidateOutput: await arm(candidate) };
    });
  async function replay(args, ctx, signal) {
      const selected = capture;
      if (promptSource(dir) !== "modular") throw Error("Replay requires enabled modular Harness instructions.");
      if (!selected?.reference || selected.id !== args.caseId) throw Error("Missing pre-answer input. Run /prompt-capture before the selected answer.");
      const { payload, model } = selected;
      if (model?.api !== "openai-completions" || payload.stream !== true || (payload.n ?? 1) !== 1)
        throw Error("Replay requires a single streamed openai-completions response");
      const baseline = active();
      const candidate = readRevision(dir, args.candidate);
      const original = swapModule(payload, baseline, baseline);
      const changed = swapModule(payload, baseline, candidate);
      const baselineOutput = await generate(original, model, ctx, signal);
      const candidateOutput = await generate(changed, model, ctx, signal);
      const { messages, tools, ...settings } = payload;
      run = { id: randomUUID(), caseId: selected.id, active: baseline.id, candidate: candidate.id, session: ctx.sessionManager?.getSessionId?.() ?? ctx.cwd,
        provider: model.provider, model: model.id, settings, inputDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        reference: selected.reference, baselineOutput, candidateOutput,
        difference: difference(baselineOutput.text, candidateOutput.text),
        requiresTurnReplay: baselineOutput.requiresTurnReplay || candidateOutput.requiresTurnReplay };
      return run;
    }
  tool("prompt_replay", "Generate both arms from a captured writing input. No requested tools are executed.",
    { caseId: string, candidate: string }, replay);
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
