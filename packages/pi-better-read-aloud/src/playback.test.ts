import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { playAudio, stopPlayback } from "./playback.js";

describe("read-aloud playback", () => {
  it("writes audio and starts the configured player", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "pi-tts-test-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const child = new EventEmitter() as any;
    child.pid = 1234;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    const spawnImpl = ((command: string, args: string[]) => {
      calls.push({ command, args });
      return child;
    }) as any;

    const previousPlayer = process.env.PI_TTS_PLAYER;
    process.env.PI_TTS_PLAYER = "test-player";
    try {
      const result = await playAudio({ bytes: Buffer.from("audio"), format: "mp3", contentType: "audio/mpeg" }, { tmpRoot, spawnImpl });

      expect(result.player).toBe("test-player");
      expect(result.pid).toBe(1234);
      expect(await readFile(result.filePath, "utf8")).toBe("audio");
      expect(calls).toEqual([{ command: "test-player", args: [result.filePath] }]);
      expect(stopPlayback()).toBe(true);
      expect(child.killed).toBe(true);
      expect(stopPlayback()).toBe(false);
    } finally {
      if (previousPlayer === undefined) delete process.env.PI_TTS_PLAYER;
      else process.env.PI_TTS_PLAYER = previousPlayer;
    }
  });
});