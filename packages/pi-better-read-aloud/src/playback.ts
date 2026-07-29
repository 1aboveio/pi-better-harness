import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SpeechAudio } from "./client.js";

export type PlaybackResult = {
  filePath: string;
  player: string;
  pid?: number;
};

export type SpawnLike = typeof spawn;

let currentPlayer: ChildProcess | undefined;

export async function playAudio(audio: SpeechAudio, options: { spawnImpl?: SpawnLike; tmpRoot?: string } = {}): Promise<PlaybackResult> {
  const dir = join(options.tmpRoot || tmpdir(), "pi-better-read-aloud");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `tts-${Date.now()}-${Math.random().toString(36).slice(2)}.${audio.format}`);
  await writeFile(filePath, audio.bytes);
  const command = resolvePlayer();
  const child = startPlayer(command, filePath, options.spawnImpl || spawn);
  currentPlayer = child;
  child.once("exit", () => {
    if (currentPlayer === child) currentPlayer = undefined;
  });
  return { filePath, player: command, pid: child.pid };
}

export function stopPlayback(): boolean {
  if (!currentPlayer || currentPlayer.killed) return false;
  currentPlayer.kill("SIGTERM");
  currentPlayer = undefined;
  return true;
}

function resolvePlayer(): string {
  if (process.env.PI_TTS_PLAYER) return process.env.PI_TTS_PLAYER;
  if (process.platform === "darwin") return "afplay";
  if (process.platform === "win32") return "powershell";
  return "ffplay";
}

function startPlayer(command: string, filePath: string, spawnImpl: SpawnLike): ChildProcess {
  const args = playerArgs(command, filePath);
  const child = spawnImpl(command, args, { stdio: "ignore", detached: false });
  child.once("error", (error) => {
    if (currentPlayer === child) currentPlayer = undefined;
    console.error(`read-aloud playback failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return child;
}

function playerArgs(command: string, filePath: string): string[] {
  if (command === "ffplay") return ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath];
  if (command === "powershell") {
    return ["-NoProfile", "-Command", `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync();`];
  }
  return [filePath];
}