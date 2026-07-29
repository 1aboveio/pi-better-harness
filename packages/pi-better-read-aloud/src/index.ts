import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveReadAloudConfig, type ReadAloudConfigInput } from "./config.js";
import { synthesizeSpeech } from "./client.js";
import { playAudio, stopPlayback } from "./playback.js";
import { latestAssistantText, normalizeTextForSpeech } from "./text.js";

const ConfigFields = {
  url: Type.Optional(Type.String({ description: "OpenAI-compatible TTS base URL or full /audio/speech URL. Defaults to PI_TTS_URL, PI_TTS_BASE_URL, OPENAI_BASE_URL, or https://api.openai.com/v1." })),
  api_key: Type.Optional(Type.String({ description: "TTS API key. Defaults to PI_TTS_API_KEY or OPENAI_API_KEY. This value is never echoed in tool output." })),
  apikey: Type.Optional(Type.String({ description: "Alias for api_key for OpenAI-compatible configuration." })),
  model: Type.Optional(Type.String({ description: "OpenAI-compatible TTS model. Defaults to PI_TTS_MODEL or tts-1." })),
  voice: Type.Optional(Type.String({ description: "TTS voice. Defaults to PI_TTS_VOICE or alloy." })),
  format: Type.Optional(Type.String({ description: "Audio response format: mp3, wav, opus, aac, flac, or pcm. Defaults to PI_TTS_FORMAT or mp3." })),
  body_format: Type.Optional(Type.String({ description: "Request body format: json for OpenAI-compatible APIs, or form for form-encoded proxies. Defaults to PI_TTS_BODY_FORMAT or json." })),
  speed: Type.Optional(Type.Number({ description: "Optional speech speed, 0.25 to 4. Defaults to PI_TTS_SPEED when set." })),
  max_chars: Type.Optional(Type.Number({ description: "Maximum characters sent to TTS. Defaults to PI_TTS_MAX_CHARS or 6000." })),
};

const ReadTextParams = Type.Object({
  text: Type.String({ description: "Text to read aloud." }),
  include_code: Type.Optional(Type.Boolean({ description: "Include fenced/inline code in spoken text. Default false." })),
  instructions: Type.Optional(Type.String({ description: "Optional provider-specific voice instructions for compatible APIs." })),
  ...ConfigFields,
});

const ReadLastParams = Type.Object({
  include_code: Type.Optional(Type.Boolean({ description: "Include fenced/inline code from the latest assistant response. Default false." })),
  instructions: Type.Optional(Type.String({ description: "Optional provider-specific voice instructions for compatible APIs." })),
  ...ConfigFields,
});

const StopParams = Type.Object({});

export default function readAloudExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read_aloud",
    label: "Read Aloud",
    description: "Synthesize provided text with an OpenAI-compatible text-to-speech API and start local audio playback. Configure url, api_key, and model via params or PI_TTS_URL/PI_TTS_API_KEY/PI_TTS_MODEL.",
    parameters: ReadTextParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(await readText(params.text, params, ctx));
    },
  });

  pi.registerTool({
    name: "read_aloud_last",
    label: "Read Last",
    description: "Read the latest assistant response in the current session using an OpenAI-compatible text-to-speech API. Configure url, api_key, and model via params or PI_TTS_URL/PI_TTS_API_KEY/PI_TTS_MODEL.",
    parameters: ReadLastParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = latestAssistantText(ctx.sessionManager.getBranch(), { includeCode: params.include_code === true, maxChars: resolveMaxChars(params) });
      if (!input) return text("No assistant response text found to read aloud.");
      return text(await readText(input, params, ctx));
    },
  });

  pi.registerTool({
    name: "read_aloud_stop",
    label: "Stop Read",
    description: "Stop the currently playing read-aloud audio, if any.",
    parameters: StopParams,
    async execute() {
      return text(stopPlayback() ? "Stopped read-aloud playback." : "No read-aloud playback is active.");
    },
  });

  pi.registerCommand("read-aloud", {
    description: "Read text aloud, or read the latest assistant response when no text is provided.",
    async handler(args, ctx) {
      try {
        const spoken = args.trim()
          ? await readText(args.trim(), {}, ctx)
          : await readLatest(ctx);
        ctx.ui.notify(spoken, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("read-aloud-stop", {
    description: "Stop read-aloud playback.",
    async handler(_args, ctx) {
      ctx.ui.notify(stopPlayback() ? "Stopped read-aloud playback." : "No read-aloud playback is active.", "info");
    },
  });
}

async function readLatest(ctx: ExtensionContext): Promise<string> {
  const config = resolveReadAloudConfig();
  const input = latestAssistantText(ctx.sessionManager.getBranch(), { maxChars: config.maxChars });
  if (!input) return "No assistant response text found to read aloud.";
  return readWithConfig(input, config);
}

async function readText(rawText: string, params: ReadAloudConfigInput & { include_code?: boolean; instructions?: string }, _ctx: ExtensionContext): Promise<string> {
  const config = resolveReadAloudConfig(params);
  const input = normalizeTextForSpeech(rawText, { includeCode: params.include_code === true, maxChars: config.maxChars });
  if (!input) return "No readable text found after normalization.";
  return readWithConfig(input, config, params.instructions);
}

async function readWithConfig(input: string, config: ReturnType<typeof resolveReadAloudConfig>, instructions?: string): Promise<string> {
  stopPlayback();
  const audio = await synthesizeSpeech(config, { text: input, instructions });
  const playback = await playAudio(audio);
  return `Started read-aloud playback (${input.length} chars, model ${config.model}, voice ${config.voice}, player ${playback.player}).`;
}

function resolveMaxChars(params: ReadAloudConfigInput): number | undefined {
  if (params.max_chars !== undefined) return params.max_chars;
  const value = process.env.PI_TTS_MAX_CHARS;
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }], details: undefined };
}