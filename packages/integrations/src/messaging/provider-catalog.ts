export const messagingProviderKeys = [
  "meta",
  "whatsapp_web",
  "telegram",
  "twilio",
  "smtp",
  "web",
  "fake",
] as const;
export type MessagingProviderKey = (typeof messagingProviderKeys)[number];

export const messagingPlatforms = [
  "whatsapp",
  "instagram",
  "messenger",
  "telegram",
  "sms",
  "email",
  "web_chat",
] as const;
export type MessagingPlatform = (typeof messagingPlatforms)[number];

export type ProviderAvailability =
  "available" | "coming_soon" | "unavailable" | "development_only";
export type ProviderAuthMethod =
  | "access_token"
  | "linked_device"
  | "oauth2"
  | "api_key"
  | "smtp_credentials"
  | "none";

export type MessagingCapability =
  | "text"
  | "media"
  | "templates"
  | "reactions"
  | "interactive"
  | "read_receipts"
  | "delivery_receipts"
  | "typing"
  | "webhooks"
  | "template_sync";

export type ProviderConfigurationField = {
  key: string;
  label: string;
  type: "text" | "password" | "url";
  required: boolean;
  secret?: boolean;
};

export type MessagingProviderDefinition = {
  key: string;
  provider: MessagingProviderKey;
  platform: MessagingPlatform;
  displayName: string;
  description: string;
  availability: ProviderAvailability;
  authMethod: ProviderAuthMethod;
  webhookSupport: boolean;
  capabilities: readonly MessagingCapability[];
  configurationSchema: readonly ProviderConfigurationField[];
  branding: {
    label: string;
    color: string;
    icon: string;
  };
  isEnabled: boolean;
};

const future = (
  input: Omit<
    MessagingProviderDefinition,
    "availability" | "isEnabled" | "configurationSchema"
  >,
): MessagingProviderDefinition => ({
  ...input,
  availability: "coming_soon",
  isEnabled: false,
  configurationSchema: [],
});

export const messagingProviderCatalog = [
  {
    key: "meta_whatsapp_cloud",
    provider: "meta",
    platform: "whatsapp",
    displayName: "WhatsApp Cloud API",
    description: "Meta Business Platform üzerinden resmî WhatsApp kanalı.",
    availability: "available",
    authMethod: "access_token",
    webhookSupport: true,
    capabilities: [
      "text",
      "media",
      "templates",
      "reactions",
      "interactive",
      "read_receipts",
      "delivery_receipts",
      "webhooks",
      "template_sync",
    ],
    configurationSchema: [
      {
        key: "phoneNumber",
        label: "WhatsApp telefon numarası",
        type: "text",
        required: true,
      },
      {
        key: "phoneNumberId",
        label: "Phone Number ID",
        type: "text",
        required: true,
      },
      {
        key: "businessAccountId",
        label: "WhatsApp Business Account ID",
        type: "text",
        required: true,
      },
      {
        key: "accessToken",
        label: "Access token",
        type: "password",
        required: true,
        secret: true,
      },
      {
        key: "appSecret",
        label: "App secret",
        type: "password",
        required: false,
        secret: true,
      },
    ],
    branding: {
      label: "Meta",
      color: "#25d366",
      icon: "message-circle",
    },
    isEnabled: true,
  },
  {
    key: "whatsapp_web_baileys",
    provider: "whatsapp_web",
    platform: "whatsapp",
    displayName: "WhatsApp Web",
    description:
      "Bağlı cihaz ve oturum tabanlı alternatif WhatsApp bağlantısı.",
    availability: "coming_soon",
    authMethod: "linked_device",
    webhookSupport: false,
    capabilities: [
      "text",
      "media",
      "reactions",
      "read_receipts",
      "delivery_receipts",
      "typing",
    ],
    configurationSchema: [],
    branding: {
      label: "Bağlı cihaz",
      color: "#128c7e",
      icon: "qr-code",
    },
    isEnabled: false,
  },
  future({
    key: "meta_instagram_direct",
    provider: "meta",
    platform: "instagram",
    displayName: "Instagram Direct",
    description: "Instagram profesyonel hesap mesajlaşması.",
    authMethod: "oauth2",
    webhookSupport: true,
    capabilities: ["text", "media", "webhooks"],
    branding: { label: "Meta", color: "#e1306c", icon: "instagram" },
  }),
  future({
    key: "meta_messenger",
    provider: "meta",
    platform: "messenger",
    displayName: "Facebook Messenger",
    description: "Facebook sayfa mesajlaşması.",
    authMethod: "oauth2",
    webhookSupport: true,
    capabilities: ["text", "media", "webhooks"],
    branding: { label: "Meta", color: "#0084ff", icon: "message-circle" },
  }),
  {
    key: "telegram_bot",
    provider: "telegram",
    platform: "telegram",
    displayName: "Telegram",
    description: "Telegram Bot API mesajlaşması.",
    authMethod: "access_token",
    webhookSupport: true,
    availability: "available",
    capabilities: ["text", "webhooks"],
    configurationSchema: [
      {
        key: "accessToken",
        label: "Bot token",
        type: "password",
        required: true,
        secret: true,
      },
    ],
    branding: { label: "Telegram", color: "#229ed9", icon: "send" },
    isEnabled: true,
  },
  future({
    key: "twilio_sms",
    provider: "twilio",
    platform: "sms",
    displayName: "SMS",
    description: "SMS sağlayıcısı üzerinden mesajlaşma.",
    authMethod: "api_key",
    webhookSupport: true,
    capabilities: ["text", "delivery_receipts", "webhooks"],
    branding: { label: "SMS", color: "#f22f46", icon: "smartphone" },
  }),
  future({
    key: "smtp_email",
    provider: "smtp",
    platform: "email",
    displayName: "E-posta",
    description: "Gelen ve giden e-posta konuşmaları.",
    authMethod: "smtp_credentials",
    webhookSupport: false,
    capabilities: ["text", "media"],
    branding: { label: "E-posta", color: "#5b6b7a", icon: "mail" },
  }),
  future({
    key: "brixchat_web_chat",
    provider: "web",
    platform: "web_chat",
    displayName: "Web chat",
    description: "Web siteleri için gömülebilir sohbet kanalı.",
    authMethod: "none",
    webhookSupport: false,
    capabilities: ["text", "media", "typing", "read_receipts"],
    branding: {
      label: "Brixchat24",
      color: "#7c3aed",
      icon: "messages-square",
    },
  }),
  {
    key: "fake_test",
    provider: "fake",
    platform: "whatsapp",
    displayName: "Fake test provider",
    description: "Yalnız otomatik test ve yerel geliştirme için.",
    availability: "development_only",
    authMethod: "none",
    webhookSupport: true,
    capabilities: [
      "text",
      "media",
      "templates",
      "delivery_receipts",
      "webhooks",
      "template_sync",
    ],
    configurationSchema: [
      {
        key: "phoneNumber",
        label: "Test telefon numarası",
        type: "text",
        required: true,
      },
    ],
    branding: { label: "Test", color: "#64748b", icon: "flask-conical" },
    isEnabled: false,
  },
] as const satisfies readonly MessagingProviderDefinition[];

export function providerDefinition(
  provider: string,
  platform?: string,
): MessagingProviderDefinition | undefined {
  return messagingProviderCatalog.find(
    (definition) =>
      definition.provider === provider &&
      (!platform || definition.platform === platform),
  );
}

export function availableProviderDefinitions(input?: {
  includeDevelopment?: boolean;
  enableWhatsAppWeb?: boolean;
}): MessagingProviderDefinition[] {
  return messagingProviderCatalog
    .filter(
      (definition) =>
        definition.availability !== "development_only" ||
        input?.includeDevelopment === true,
    )
    .map((definition) =>
      definition.provider === "whatsapp_web" &&
      input?.enableWhatsAppWeb === true
        ? {
            ...definition,
            availability: "available" as const,
            isEnabled: true,
          }
        : definition,
    );
}

export function requireCreatableProviderDefinition(input: {
  provider: string;
  platform?: string;
  includeDevelopment?: boolean;
  enableWhatsAppWeb?: boolean;
}): MessagingProviderDefinition {
  const definition = providerDefinition(input.provider, input.platform);
  const developmentAllowed =
    definition?.availability === "development_only" &&
    input.includeDevelopment === true;
  const whatsappWebAllowed =
    definition?.provider === "whatsapp_web" &&
    input.enableWhatsAppWeb === true;
  if (
    !definition ||
    (!definition.isEnabled && !developmentAllowed && !whatsappWebAllowed) ||
    (!["available", "development_only"].includes(definition.availability) &&
      !whatsappWebAllowed)
  )
    throw Object.assign(new Error("Messaging provider is not available"), {
      code: "CHANNEL_PROVIDER_UNAVAILABLE",
    });
  return whatsappWebAllowed
    ? {
        ...definition,
        availability: "available",
        isEnabled: true,
      }
    : definition;
}

export function supportsCapability(
  definition: Pick<MessagingProviderDefinition, "capabilities">,
  capability: MessagingCapability,
): boolean {
  return definition.capabilities.includes(capability);
}
