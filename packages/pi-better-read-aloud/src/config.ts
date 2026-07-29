export type ReadAloudConfigInput = {
  url?: string;
  api_key?: string;
  apikey?: string;
  model?: string;
  voice?: string;
  format?: string;
  speed?: number;
  max_chars?: number;
};

export type ReadAloudConfig = {
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm";
  speed?: number;
  maxChars: number;
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "tts-1";
const DEFAULT_VOICE = "alloy";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_MAX_CHARS = 6000;
const FORMATS = new Set(["mp3", "wav", "opus", "aac", "flac", "pcm"]);

export function resolveReadAloudConfig(input: ReadAloudConfigInput = {}, env: NodeJS.ProcessEnv = process.env): ReadAloudConfig {
  const rawUrl = input.url || env.PI_TTS_URL || env.PI_TTS_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = input.api_key || input.apikey || env.PI_TTS_API_KEY || env.OPENAI_API_KEY || "";
  const model = input.model || env.PI_TTS_MODEL || DEFAULT_MODEL;
  const voice = input.voice || env.PI_TTS_VOICE || DEFAULT_VOICE;
  const format = normalizeFormat(input.format || env.PI_TTS_FORMAT || DEFAULT_FORMAT);
  const speed = input.speed ?? numberFromEnv(env.PI_TTS_SPEED);
  const maxChars = input.max_chars ?? numberFromEnv(env.PI_TTS_MAX_CHARS) ?? DEFAULT_MAX_CHARS;

  if (!apiKey) {
    throw new Error("Missing TTS API key. Set PI_TTS_API_KEY or pass api_key.");
  }
  if (!model.trim()) throw new Error("Missing TTS model. Set PI_TTS_MODEL or pass model.");
  if (!voice.trim()) throw new Error("Missing TTS voice. Set PI_TTS_VOICE or pass voice.");
  if (maxChars < 1) throw new Error("max_chars must be greater than 0.");
  if (speed !== undefined && (speed < 0.25 || speed > 4)) throw new Error("speed must be between 0.25 and 4.");

  return {
    url: normalizeSpeechUrl(rawUrl),
    apiKey,
    model,
    voice,
    format,
    speed,
    maxChars: Math.floor(maxChars),
  };
}

export function normalizeSpeechUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("TTS url cannot be empty.");
  if (/\/audio\/speech$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/audio/speech`;
  return `${trimmed}/v1/audio/speech`;
}

function normalizeFormat(value: string): ReadAloudConfig["format"] {
  const normalized = value.trim().toLowerCase();
  if (!FORMATS.has(normalized)) throw new Error(`Unsupported TTS response format: ${value}`);
  return normalized as ReadAloudConfig["format"];
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric TTS config value: ${value}`);
  return parsed;
}