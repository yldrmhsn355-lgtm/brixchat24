export const channelPlatforms = [
  "whatsapp",
  "whatsapp_web",
  "instagram",
  "messenger",
  "telegram",
  "sms",
  "email",
  "web_chat",
] as const;

export type ChannelPlatform = (typeof channelPlatforms)[number];
export type ChannelPlatformFilter = "all" | ChannelPlatform;

export const channelPlatformLabels: Record<ChannelPlatform, string> = {
  whatsapp: "WhatsApp",
  whatsapp_web: "WhatsApp Web",
  instagram: "Instagram",
  messenger: "Messenger",
  telegram: "Telegram",
  sms: "SMS",
  email: "E-posta",
  web_chat: "Web Chat",
};

const knownPlatforms = new Set<string>(channelPlatforms);

export function readChannelPlatformFilter(
  search: string,
): ChannelPlatformFilter {
  const value = new URLSearchParams(search).get("platform");
  return value && knownPlatforms.has(value)
    ? (value as ChannelPlatform)
    : "all";
}

export function writeChannelPlatformFilter(
  search: string,
  platform: ChannelPlatformFilter,
) {
  const params = new URLSearchParams(search);
  if (platform === "all") params.delete("platform");
  else params.set("platform", platform);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function filterChannelsByPlatform<
  T extends { platform: string; provider?: string },
>(
  channels: T[],
  platform: ChannelPlatformFilter,
) {
  if (platform === "all") return channels;
  if (platform === "whatsapp_web")
    return channels.filter((channel) => channel.provider === "whatsapp_web");
  if (platform === "whatsapp")
    return channels.filter(
      (channel) =>
        channel.platform === "whatsapp" &&
        channel.provider !== "whatsapp_web",
    );
  return channels.filter((channel) => channel.platform === platform);
}

export function countChannelsByPlatform(
  channels: Array<{ platform: string; provider?: string }>,
) {
  const counts = Object.fromEntries(
    channelPlatforms.map((platform) => [platform, 0]),
  ) as Record<ChannelPlatform, number>;
  for (const channel of channels) {
    if (channel.provider === "whatsapp_web") {
      counts.whatsapp_web += 1;
      continue;
    }
    if (knownPlatforms.has(channel.platform))
      counts[channel.platform as ChannelPlatform] += 1;
  }
  return counts;
}

export function shouldPollWhatsAppWebSession(status?: string | null) {
  return status !== "connected" && status !== "logged_out";
}
