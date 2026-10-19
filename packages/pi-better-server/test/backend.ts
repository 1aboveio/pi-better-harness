/** Where the daemon under test lives, as the CLI sees it. Local: default socket path. Remote: an SSH-forwarded socket. */
export interface Backend {
  /** Extra CLI args that select the daemon (empty for local, `--host ... --remote-dir ...` for remote). */
  flags: string[];
  /** Directory sessions work in; a git repo on branch `feature-x`. */
  cwd: string;
  env: Record<string, string>;
  /** Text of every user message the scripted model has been asked to answer, in order. */
  userTexts(): Promise<string[]>;
  gateStarted(name: string): Promise<boolean>;
  releaseGate(name: string): Promise<void>;
  cleanup(): Promise<void>;
}
