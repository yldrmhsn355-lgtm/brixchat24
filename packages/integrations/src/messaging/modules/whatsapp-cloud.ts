import { MetaWhatsAppCloudProvider } from "../../meta-whatsapp/provider";
import type { MessagingProviderModule } from "./types";

export const whatsappCloudModule: MessagingProviderModule = {
  moduleId: "whatsapp.cloud",
  provider: "meta",
  platform: "whatsapp",
  adapterKind: "messaging",
  crm: {
    inbound: "canonical_message",
    outbound: "canonical_outbox",
    timeline: "crm_sync_job",
  },
  create: (input) =>
    new MetaWhatsAppCloudProvider(input.apiVersion ?? "v25.0", input.timeoutMs),
};
