import { TelegramBotProvider } from "../../telegram/provider";
import type { MessagingProviderModule } from "./types";

export const telegramBotModule: MessagingProviderModule = {
  moduleId: "telegram.bot",
  provider: "telegram",
  platform: "telegram",
  adapterKind: "messaging",
  crm: {
    inbound: "canonical_message",
    outbound: "canonical_outbox",
    timeline: "crm_sync_job",
  },
  create: (input) => new TelegramBotProvider(input.timeoutMs),
};
