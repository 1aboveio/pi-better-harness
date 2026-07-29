import type { ReadAloudConfig } from "./config.js";

export type SpeechRequest = {
  text: string;
  instructions?: string;
};

export type SpeechAudio = {
  bytes: Buffer;
  format: ReadAloudConfig["format"];
  contentType: string;
};

export async function synthesizeSpeech(config: ReadAloudConfig, request: SpeechRequest, fetchImpl: typeof fetch = fetch): Promise<SpeechAudio> {
  const payload: Record<string, string | number> = {
    model: config.model,
    input: request.text,
    voice: config.voice,
    response_format: config.format,
  };
  if (config.speed !== undefined) payload.speed = config.speed;
  if (request.instructions) payload.instructions = request.instructions;

  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": config.bodyFormat === "form" ? "application/x-www-form-urlencoded" : "application/json",
      Accept: audioAcceptHeader(config.format),
    },
    body: requestBody(config, payload),
  });

  if (!response.ok) {
    const errorText = await safeResponseText(response);
    throw new Error(`TTS request failed (${response.status}): ${errorText || response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || audioAcceptHeader(config.format);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    format: inferFormat(contentType) || config.format,
    contentType,
  };
}

function requestBody(config: ReadAloudConfig, payload: Record<string, string | number>): string {
  if (config.bodyFormat === "form") {
    return new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString();
  }
  return JSON.stringify(payload);
}

function audioAcceptHeader(format: ReadAloudConfig["format"]): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/opus";
  if (format === "aac") return "audio/aac";
  if (format === "flac") return "audio/flac";
  return "audio/pcm";
}

function inferFormat(contentType: string): ReadAloudConfig["format"] | undefined {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("audio/wav") || normalized.includes("audio/x-wav")) return "wav";
  if (normalized.includes("audio/mpeg") || normalized.includes("audio/mp3")) return "mp3";
  if (normalized.includes("audio/opus")) return "opus";
  if (normalized.includes("audio/aac")) return "aac";
  if (normalized.includes("audio/flac")) return "flac";
  if (normalized.includes("audio/pcm")) return "pcm";
  return undefined;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return "";
  }
}