type SessionEntryLike = {
  type: string;
  message?: unknown;
};

export function normalizeTextForSpeech(input: string, options: { includeCode?: boolean; maxChars?: number } = {}): string {
  const withoutCode = options.includeCode === true
    ? input
    : input.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]+)`/g, "$1");
  const withoutImages = withoutCode.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const withReadableLinks = withoutImages.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  const withoutMarkup = withReadableLinks
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  return withoutMarkup.length > maxChars ? withoutMarkup.slice(0, maxChars).trimEnd() : withoutMarkup;
}

export function latestAssistantText(entries: SessionEntryLike[], options: { includeCode?: boolean; maxChars?: number } = {}): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message as any;
    if (message?.role !== "assistant") continue;
    const text = assistantMessageText(message);
    const normalized = normalizeTextForSpeech(text, options);
    if (normalized) return normalized;
  }
  return null;
}

export function assistantMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typed = item as { type?: string; text?: string; thinking?: string };
    if (typed.type === "text" && typed.text) parts.push(typed.text);
  }
  return parts.join("\n\n");
}