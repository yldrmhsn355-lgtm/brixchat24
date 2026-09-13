import type { MessagingProviderModule } from "./types";

export function futurePlatformModule(
  moduleId: string,
  provider: string,
  platform: string,
): MessagingProviderModule {
  return {
    moduleId,
    provider,
    platform,
    adapterKind: "none",
    crm: {
      inbound: "canonical_message",
      outbound: "canonical_outbox",
      timeline: "crm_sync_job",
    },
  };
}
