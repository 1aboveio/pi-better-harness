import { EventEmitter } from "node:events";
import type { RemoteRunner } from "../remote-task-preset.js";
import type { CommandResult, CommandSpec } from "../types.js";

export class FakeRemoteRunner implements RemoteRunner {
  readonly spawnCalls: Array<{ spec: CommandSpec; logPath: string; detached: boolean }> = [];
  readonly runCalls: CommandSpec[] = [];
  private readonly children: EventEmitter[] = [];
  private readonly scriptedResults: Array<CommandResult | Error>;

  constructor(results: Array<CommandResult | Error> = [successfulResult("done\n")]) {
    this.scriptedResults = [...results];
  }

  spawn(spec: CommandSpec, logPath: string, detached: boolean) {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined as number | undefined,
      unref() {},
    });
    this.spawnCalls.push({ spec, logPath, detached });
    this.children.push(child);
    return { child: child as never };
  }

  async runOnce(spec: CommandSpec): Promise<CommandResult> {
    this.runCalls.push(spec);
    const scripted = this.scriptedResults.shift() ?? successfulResult("");
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }

  closeSpawn(exitCode: number | null, index = this.children.length - 1): void {
    const child = this.children[index];
    if (!child) throw new Error(`no fake remote spawn at index ${index}`);
    child.emit("close", exitCode, null);
  }
}

export function successfulResult(stdout: string): CommandResult {
  const now = Date.now();
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    startedAt: now,
    endedAt: now,
  };
}
