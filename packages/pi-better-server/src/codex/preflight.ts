/**
 * Before a Codex thread is fenced: ask the source which model provider the thread has, then ask the target
 * whether its Codex can use that provider (or the one `--codex-provider` rebinds the thread to). Nothing is
 * fenced, written or sent when the target says no.
 */
import type { MoveEndpoint } from "../move/orchestrate.ts";
import { assertChecks, type CheckResult } from "../move/preflight.ts";

export async function preflightCodexProvider(source: MoveEndpoint, target: MoveEndpoint, sessionId: string, rebindProvider: string | undefined): Promise<void> {
  const described = await source.call({ type: "move_preflight", sessionId });
  const modelProvider = (described.data as { session?: { modelProvider?: string } }).session?.modelProvider;
  if (!modelProvider && !rebindProvider) return;
  const answer = await target.call({ type: "move_preflight", ...(modelProvider ? { modelProvider } : {}), ...(rebindProvider ? { rebindProvider } : {}) });
  assertChecks((answer.data as { checks: CheckResult[] }).checks);
}
