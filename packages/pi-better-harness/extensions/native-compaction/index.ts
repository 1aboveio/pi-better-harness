import { randomUUID } from "node:crypto";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  convertToLlm, getLatestCompactionEntry, sessionEntryToContextMessages,
  type CompactionEntry, type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";
import { compactWindow, route, supportsCompaction, type Item } from "./provider.ts";

const key = "openaiNativeCompaction";
const summaryPrefix = "OpenAI compacted the earlier conversation. Checkpoint ";
const responsesProviders = new Set(["openai", "openai-codex", "opencode"]);
type Checkpoint = CompactionEntry & { details: { format: "openai-responses-v1"; route: string; output: Item[] } };

function native(entry?: SessionEntry | null): entry is Checkpoint {
  return entry?.type === "compaction" && entry.fromHook === true &&
    (entry.details as Partial<Checkpoint["details"]>)?.format === "openai-responses-v1";
}

// Encrypted items belong to one route. Recover the archived Pi messages for other
// models or for a subsequent ordinary Pi compaction. Keep earlier Pi summaries.
function archivedPrefix(branch: SessionEntry[], checkpoint: Checkpoint) {
  const cut = branch.findIndex(entry => entry.id === checkpoint.firstKeptEntryId);
  const before = branch.slice(0, branch.findIndex(entry => entry.id === checkpoint.id));
  const ordinary = getLatestCompactionEntry(before.filter(entry => !native(entry)));
  const start = ordinary ? branch.findIndex(entry => entry.id === ordinary.firstKeptEntryId) : 0;
  return [...(ordinary ? sessionEntryToContextMessages(ordinary) : []),
    ...branch.slice(Math.max(0, start), cut).filter(entry => entry.type !== "compaction").flatMap(sessionEntryToContextMessages)];
}

export default function nativeCompaction(pi: ExtensionAPI) {
  const toggle = {
    id: "native-compaction", label: "OpenAI native compaction", values: ["Off", "On"],
    description: "Use native compaction for GPT models on supported Responses endpoints. Applies to future compactions.",
    get: () => readHarnessSetting(key) === true ? "On" : "Off",
    change: (value: string) => { updateHarnessSetting(key, () => value === "On"); },
  };
  pi.events.on("harness-settings:request", () => pi.events.emit("harness-settings:register", toggle));

  const marker = randomUUID();
  let replay: Checkpoint | undefined;
  let portable: ReturnType<typeof archivedPrefix> | undefined;
  function select(entry: CompactionEntry | null) {
    replay = native(entry) ? entry : undefined;
    portable = undefined;
  }
  const restore = (_event: unknown, ctx: ExtensionContext) => select(getLatestCompactionEntry(ctx.sessionManager.getBranch()));
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_compact", event => select(event.compactionEntry));
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, signal } = event;
    const previous = getLatestCompactionEntry(branchEntries);
    const model = ctx.model;
    const previousNative = native(previous) ? previous : undefined;
    const restoreForPi = () => {
      if (!previousNative) return;
      preparation.messagesToSummarize.unshift(...archivedPrefix(branchEntries, previousNative));
      preparation.previousSummary = undefined;
    };
    if (!supportsCompaction(model) || readHarnessSetting(key) !== true) {
      restoreForPi();
      return;
    }

    try {
      let prefix: Item[] = [];
      let messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      if (previousNative && previousNative.details.route === route(model)) {
        prefix = previousNative.details.output;
      } else if (previous) {
        const history = previousNative ? archivedPrefix(branchEntries, previousNative) : sessionEntryToContextMessages(previous);
        messages = [...history, ...messages];
      }
      const items = convertResponsesMessages(model, { messages: convertToLlm(messages) }, responsesProviders);
      const output = await compactWindow(ctx, model, [...prefix, ...items], event.customInstructions, signal);
      signal.throwIfAborted();
      if (!output) {
        restoreForPi();
        return;
      }
      // Pi commits summary, cut point and output as one journal entry after the hook returns.
      return { compaction: {
        summary: summaryPrefix + randomUUID(), firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore, details: { format: "openai-responses-v1", route: route(model), output },
      } };
    } catch (error) {
      if (!signal.aborted) ctx.ui.notify(`Native compaction stopped: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return { cancel: true };
    }
  });

  pi.on("context", (event, ctx) => {
    if (!replay) return;
    const index = event.messages.findIndex(message => message.role === "compactionSummary" && message.summary === replay?.summary);
    if (index < 0) return;
    const summary = event.messages[index];
    const replacement = supportsCompaction(ctx.model) && replay.details.route === route(ctx.model)
      ? [{ role: "user" as const, content: marker, timestamp: summary.timestamp }]
      : (portable ??= archivedPrefix(ctx.sessionManager.getBranch(), replay));
    const tail = event.messages.slice(index + 1).filter(message => message.role !== "compactionSummary");
    return { messages: [...event.messages.slice(0, index), ...replacement, ...tail] };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!replay || !supportsCompaction(ctx.model) || replay.details.route !== route(ctx.model)) return;
    const payload = event.payload as { model?: string; input?: Item[]; instructions?: string } | undefined;
    if (payload?.model !== ctx.model.id || !Array.isArray(payload.input)) return;
    const index = payload.input.findIndex(item => item.role === "user" && Array.isArray(item.content) &&
      item.content.length === 1 && item.content[0]?.type === "input_text" && item.content[0].text === marker);
    if (index < 0) return;
    // Some Responses gateways insert a long, uncached instructions suffix when
    // the field is absent. Pi already sends its full system prompt in input.
    return { ...payload, instructions: payload.instructions ?? "Follow the instructions in the conversation.",
      input: [...payload.input.slice(0, index), ...replay.details.output, ...payload.input.slice(index + 1)] };
  });
}
