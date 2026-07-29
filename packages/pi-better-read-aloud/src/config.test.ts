import { describe, expect, it } from "vitest";
import { normalizeSpeechUrl, resolveReadAloudConfig } from "./config.js";

describe("read-aloud config", () => {
  it("normalizes OpenAI-compatible base URLs to /v1/audio/speech", () => {
    expect(normalizeSpeechUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/audio/speech");
    expect(normalizeSpeechUrl("https://proxy.example.com")).toBe("https://proxy.example.com/v1/audio/speech");
    expect(normalizeSpeechUrl("https://proxy.example.com/v1/audio/speech")).toBe("https://proxy.example.com/v1/audio/speech");
  });

  it("resolves url, api key, and model from explicit params before env", () => {
    const config = resolveReadAloudConfig({
      url: "https://tts.example.com/v1",
      api_key: "param-key",
      model: "tts-param",
      voice: "nova",
      format: "wav",
      max_chars: 123,
    }, {
      PI_TTS_API_KEY: "env-key",
      PI_TTS_MODEL: "tts-env",
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({
      url: "https://tts.example.com/v1/audio/speech",
      apiKey: "param-key",
      model: "tts-param",
      voice: "nova",
      format: "wav",
      maxChars: 123,
    });
  });

  it("requires an API key", () => {
    expect(() => resolveReadAloudConfig({}, {} as NodeJS.ProcessEnv)).toThrow(/Missing TTS API key/);
  });

  it("accepts apikey as an alias for api_key", () => {
    expect(resolveReadAloudConfig({ apikey: "alias-key" }, {} as NodeJS.ProcessEnv).apiKey).toBe("alias-key");
  });
});