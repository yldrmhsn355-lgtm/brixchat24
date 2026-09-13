export type BitrixTimelineCommentContext = {
  body?: unknown;
  direction?: unknown;
  contact_name?: unknown;
  normalized_phone?: unknown;
  sender_name?: unknown;
  message_type?: unknown;
  status?: unknown;
  provider_message_id?: unknown;
  sent_at?: unknown;
  conversation_id?: unknown;
  channel_id?: unknown;
  channel_name?: unknown;
  channel_phone?: unknown;
  phone_number_id?: unknown;
  business_account_id?: unknown;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function displayPhone(value: unknown) {
  const phone = clean(value);
  if (/^00\d{8,15}$/.test(phone)) return `+${phone.slice(2)}`;
  if (/^\d{8,15}$/.test(phone)) return `+${phone}`;
  return phone;
}

export function bitrixTimelineComment(context: BitrixTimelineCommentContext) {
  const inbound = clean(context.direction) === "inbound";
  const phone = clean(context.normalized_phone);
  const channelName = clean(context.channel_name) || "Bilinmeyen kanal";
  const channelPhone = displayPhone(context.channel_phone) || "Bilinmiyor";
  const message = clean(context.body).slice(0, 1000);
  // Deliberately minimal: operators asked for only the channel, the customer
  // number, and the message — no technical identifiers in the timeline.
  const lines = [
    `📱 WhatsApp — ${inbound ? "Gelen" : "Giden"} mesaj`,
    `Kanal: ${channelName} (${channelPhone})`,
    `Müşteri numarası: ${phone || "Bilinmiyor"}`,
    "",
    message,
  ];
  return lines.join("\n");
}
