import type { MessagingProviderModule } from "./types";

// WhatsApp Web owns a separate Baileys worker runtime. It intentionally does
// not implement the Cloud MessagingProvider contract.
export const whatsappWebModule: MessagingProviderModule = {
  moduleId: "whatsapp.web",
  provider: "whatsapp_web",
  platform: "whatsapp",
  adapterKind: "worker_runtime",
  crm: {
    inbound: "canonical_message",
    outbound: "canonical_outbox",
    timeline: "crm_sync_job",
  },
};
