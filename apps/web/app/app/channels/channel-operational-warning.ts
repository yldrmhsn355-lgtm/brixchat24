type ChannelWarningInput = {
  provider: string;
  webhookHealth: "HEALTHY" | "WARNING" | "UNHEALTHY" | "UNKNOWN";
  session: { lastErrorCode: string | null } | null;
};

export function channelOperationalWarning(
  channel: ChannelWarningInput,
): string | null {
  if (channel.provider === "whatsapp_web")
    return channel.session?.lastErrorCode
      ? `Oturum hatası: ${channel.session.lastErrorCode}`
      : null;

  if (channel.provider !== "meta") return null;
  if (channel.webhookHealth === "UNHEALTHY")
    return "Webhook olayı işlenemedi. Kanal health testini çalıştırın.";
  if (channel.webhookHealth === "WARNING")
    return "Webhook olayı yeniden deneniyor. Kanal health testini çalıştırın.";
  return null;
}
