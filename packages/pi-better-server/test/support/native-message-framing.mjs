/** Pi 1.x may persist one empty system frame before the conversation. */
export function splitNativeFraming(messages) {
  const framing = messages[0]?.role === "system" ? messages.slice(0, 1) : [];
  if (framing.length && framing[0].text !== "") throw new Error("Unexpected nonempty native system framing");
  const conversation = messages.slice(framing.length);
  if (conversation.some(message => !["user", "assistant", "toolResult"].includes(message.role))) throw new Error("Unexpected native conversation role or framing position");
  return { framing, conversation };
}
