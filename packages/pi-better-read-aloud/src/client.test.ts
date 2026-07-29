import { describe, expect, it } from "vitest";
import { synthesizeSpeech } from "./client.js";
import type { ReadAloudConfig } from "./config.js";

describe("synthesizeSpeech", () => {
  it("posts an OpenAI-compatible audio speech request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    };

    const config: ReadAloudConfig = {
      url: "https://proxy.example.com/v1/audio/speech",
      apiKey: "secret-key",
      model: "tts-model",
      voice: "alloy",
      format: "mp3",
      bodyFormat: "json",
      speed: 1.1,
      maxChars: 6000,
    };

    const audio = await synthesizeSpeech(config, { text: "hello", instructions: "calm" }, fetchImpl as typeof fetch);

    expect(audio.bytes).toEqual(Buffer.from([1, 2, 3]));
    expect(audio.contentType).toBe("audio/mpeg");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://proxy.example.com/v1/audio/speech");
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "tts-model",
      input: "hello",
      voice: "alloy",
      response_format: "mp3",
      speed: 1.1,
      instructions: "calm",
    });
  });

  it("can send form-encoded speech requests for compatible proxies", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ init: init! });
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    };

    const audio = await synthesizeSpeech({
      url: "https://proxy.example.com/v1/audio/speech",
      apiKey: "secret-key",
      model: "tts-model",
      voice: "alloy",
      format: "mp3",
      bodyFormat: "form",
      maxChars: 6000,
    }, { text: "hello" }, fetchImpl as typeof fetch);

    expect(audio.format).toBe("wav");
    expect(calls[0]!.init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "audio/mpeg",
    });
    expect(String(calls[0]!.init.body)).toBe("model=tts-model&input=hello&voice=alloy&response_format=mp3");
  });

  it("surfaces provider errors without leaking request body", async () => {
    const fetchImpl = async () => new Response("bad key", { status: 401, statusText: "Unauthorized" });
    await expect(synthesizeSpeech({
      url: "https://proxy.example.com/v1/audio/speech",
      apiKey: "secret-key",
      model: "tts-model",
      voice: "alloy",
      format: "mp3",
      bodyFormat: "json",
      maxChars: 6000,
    }, { text: "hello" }, fetchImpl as typeof fetch)).rejects.toThrow(/401.*bad key/);
  });
});