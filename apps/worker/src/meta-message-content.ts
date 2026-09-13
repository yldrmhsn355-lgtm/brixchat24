type MetaMessage = Record<string, unknown> & {
  type?: unknown;
  text?: { body?: unknown };
  reaction?: { emoji?: unknown };
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function metaMessageContent(
  message: MetaMessage,
  type = nonEmpty(message.type) ?? "unsupported",
): string {
  if (type === "text") return nonEmpty(message.text?.body) ?? "";
  if (type === "reaction")
    return nonEmpty(message.reaction?.emoji) ?? "[reaction]";

  const metadata = message[type];
  const item = record(metadata);
  if (type === "image" || type === "video")
    return nonEmpty(item.caption) ?? `[${type}]`;
  if (type === "document")
    return nonEmpty(item.caption) ?? nonEmpty(item.filename) ?? "[document]";
  if (type === "location")
    return nonEmpty(item.name) ?? nonEmpty(item.address) ?? "Paylaşılan konum";
  if (type === "contacts" && Array.isArray(metadata)) {
    const first = record(metadata[0]);
    const name = record(first.name);
    return (
      nonEmpty(name.formatted_name) ??
      nonEmpty(name.formatted) ??
      "Paylaşılan kişi"
    );
  }
  if (type === "interactive") {
    const button = record(item.button_reply);
    const list = record(item.list_reply);
    return (
      nonEmpty(button.title) ??
      nonEmpty(list.title) ??
      nonEmpty(list.description) ??
      "[interactive]"
    );
  }
  if (type === "button") return nonEmpty(item.text) ?? "[button]";

  return `[${type}]`;
}
