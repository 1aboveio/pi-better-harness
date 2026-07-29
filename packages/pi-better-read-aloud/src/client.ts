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
  const body: Record<string, unknown> = {
    model: config.model,
    input: request.text,
    voice: config.voice,
    response_format: config.format,
  };
  if (config.speed !== undefined) body.speed = config.speed;
  if (request.instructions) body.instructions = request.instructions;

  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: audioAcceptHeader(config.format),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await safeResponseText(response);
    throw new Error(`TTS request failed (${response.status}): ${errorText || response.statusText}`);
  }

  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    format: config.format,
    contentType: response.headers.get("content-type") || audioAcceptHeader(config.format),
  };
}

function audioAcceptHeader(format: ReadAloudConfig["format"]): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "wav") return "audio/wav";
  if (format === "opus") return "audio/opus";
  if (format === "aac") return "audio/aac";
  if (format === "flac") return "audio/flac";
  return "audio/pcm";
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 1000);
  } catch {
    return "";
  }
}