import { futurePlatformModule } from "./future";
import { whatsappCloudModule } from "./whatsapp-cloud";
import { whatsappWebModule } from "./whatsapp-web";
import { telegramBotModule } from "./telegram";
import type { MessagingProviderModule } from "./types";

export const messagingProviderModules: readonly MessagingProviderModule[] = [
  whatsappCloudModule,
  whatsappWebModule,
  telegramBotModule,
  futurePlatformModule("instagram.direct", "meta", "instagram"),
  futurePlatformModule("facebook.messenger", "meta", "messenger"),
  futurePlatformModule("sms.twilio", "twilio", "sms"),
  futurePlatformModule("email.smtp", "smtp", "email"),
  futurePlatformModule("webchat.brixchat", "web", "web_chat"),
];

export function providerModule(
  provider: string,
  platform?: string,
): MessagingProviderModule | undefined {
  return messagingProviderModules.find(
    (module) =>
      module.provider === provider &&
      (!platform || module.platform === platform),
  );
}
