import type { Subcommand } from "./context.ts";

export const command: Subcommand = {
  usage: 'new [--host <ssh-alias>] --cwd <dir> [--name <name>] [--model <provider/id>] "<prompt>"',
  options: { cwd: { type: "string" }, name: { type: "string" }, model: { type: "string" } },
  async run({ values, positionals }, context) {
    const prompt = positionals.join(" ").trim();
    if (!prompt) throw new Error('new needs a prompt: pi-remote new --cwd <dir> "<prompt>"');
    const cwd = typeof values.cwd === "string" ? values.cwd : context.host ? undefined : process.cwd();
    if (context.host && !cwd) throw new Error("new --host needs --cwd: the directory on the remote host to work in");
    let model: { provider: string; modelId: string } | undefined;
    if (typeof values.model === "string") {
      const slash = values.model.indexOf("/");
      if (slash < 1) throw new Error("--model must look like provider/model-id");
      model = { provider: values.model.slice(0, slash), modelId: values.model.slice(slash + 1) };
    }
    const client = await context.connect();
    const created = await client.call({
      type: "create_session",
      ...(cwd ? { cwd } : {}),
      ...(typeof values.name === "string" ? { name: values.name } : {}),
      ...(model ? { model } : {}),
    });
    const sessionId = created.sessionId as string;
    // The daemon answers once the turn is accepted; it keeps running after we disconnect.
    try {
      await client.call({ type: "prompt", sessionId, message: prompt });
    } catch (error) {
      // The session already exists; name it so the user can retry or inspect it instead of hunting through `ls`.
      context.stdout(context.json ? `${JSON.stringify(created.data)}\n` : `${sessionId}\n`);
      context.stderr(`session ${sessionId} was created but its prompt was refused\n`);
      throw error;
    }
    context.stdout(context.json ? `${JSON.stringify(created.data)}\n` : `${sessionId}\n`);
    return 0;
  },
};
