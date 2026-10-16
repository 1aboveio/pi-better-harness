import { createAgentSession, SessionManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

/**
 * Dry-run a provider's credentials the way a session would use them: build an
 * in-memory session (so extension-registered providers are known) and resolve
 * the provider's auth. No model call is made and nothing is written.
 */
export async function checkProviderAuth(provider: string, cwd: string, options: Omit<CreateAgentSessionOptions, "cwd" | "sessionManager"> = {}): Promise<void> {
  const { session } = await createAgentSession({ ...options, cwd, sessionManager: SessionManager.inMemory(cwd) });
  try {
    const auth = await session.modelRuntime.getAuth(provider);
    if (!auth) throw new Error("no usable credentials (log in or set the provider's API key there)");
  } finally {
    session.dispose();
  }
}
