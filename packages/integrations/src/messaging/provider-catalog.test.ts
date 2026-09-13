import { describe, expect, it } from "vitest";
import {
  availableProviderDefinitions,
  messagingProviderCatalog,
  providerDefinition,
  requireCreatableProviderDefinition,
  supportsCapability,
} from "./provider-catalog";
import { createMessagingProvider } from "./provider-factory";
import { ProviderError } from "./types";
import { messagingProviderModules, providerModule } from "./modules";

describe("messaging provider catalog", () => {
  it("resolves each platform through an isolated module boundary", () => {
    expect(providerModule("meta", "whatsapp")?.moduleId).toBe("whatsapp.cloud");
    expect(providerModule("meta", "whatsapp")?.crm).toEqual({
      inbound: "canonical_message",
      outbound: "canonical_outbox",
      timeline: "crm_sync_job",
    });
    expect(providerModule("whatsapp_web", "whatsapp")?.adapterKind).toBe(
      "worker_runtime",
    );
    expect(providerModule("telegram", "telegram")?.adapterKind).toBe(
      "messaging",
    );
    expect(messagingProviderModules).toHaveLength(8);
  });

  it("exposes separate Cloud API and linked-device WhatsApp definitions", () => {
    const ready = messagingProviderCatalog.filter(
      (definition) => definition.isEnabled,
    );
    expect(ready.map((definition) => definition.key)).toEqual([
      "meta_whatsapp_cloud",
      "telegram_bot",
    ]);
    expect(providerDefinition("meta", "whatsapp")?.availability).toBe(
      "available",
    );
    expect(providerDefinition("whatsapp_web", "whatsapp")?.authMethod).toBe(
      "linked_device",
    );
    expect(providerDefinition("whatsapp_web", "whatsapp")?.availability).toBe(
      "coming_soon",
    );
    expect(providerDefinition("whatsapp_web", "whatsapp")?.webhookSupport).toBe(
      false,
    );
  });

  it("exposes Telegram as a creatable text provider", () => {
    expect(
      availableProviderDefinitions().map((definition) => definition.platform),
    ).toContain("telegram");
    expect(
      requireCreatableProviderDefinition({
        provider: "telegram",
        platform: "telegram",
      }),
    ).toMatchObject({ availability: "available", isEnabled: true });
  });

  it("enables the linked-device provider only with its runtime flag", () => {
    expect(() =>
      requireCreatableProviderDefinition({
        provider: "whatsapp_web",
        platform: "whatsapp",
      }),
    ).toThrowError("Messaging provider is not available");
    const enabled = requireCreatableProviderDefinition({
      provider: "whatsapp_web",
      platform: "whatsapp",
      enableWhatsAppWeb: true,
    });
    expect(enabled.availability).toBe("available");
    expect(enabled.isEnabled).toBe(true);
    expect(
      availableProviderDefinitions({ enableWhatsAppWeb: true }).find(
        (definition) => definition.provider === "whatsapp_web",
      ),
    ).toMatchObject({
      availability: "available",
      isEnabled: true,
    });
  });

  it("allows fake only when development mode is explicit", () => {
    expect(() =>
      requireCreatableProviderDefinition({
        provider: "fake",
        platform: "whatsapp",
      }),
    ).toThrow();
    expect(
      requireCreatableProviderDefinition({
        provider: "fake",
        platform: "whatsapp",
        includeDevelopment: true,
      }).availability,
    ).toBe("development_only");
  });

  it("uses capabilities instead of provider-name assumptions", () => {
    const meta = requireCreatableProviderDefinition({
      provider: "meta",
      platform: "whatsapp",
    });
    expect(supportsCapability(meta, "templates")).toBe(true);
    expect(supportsCapability(meta, "typing")).toBe(false);
    const web = providerDefinition("whatsapp_web", "whatsapp");
    expect(web).toBeDefined();
    expect(supportsCapability(web!, "templates")).toBe(false);
    expect(supportsCapability(web!, "typing")).toBe(true);
  });

  it("fails closed when an adapter has not been implemented", () => {
    expect(() =>
      createMessagingProvider({
        provider: "twilio",
        platform: "sms",
      }),
    ).toThrowError(ProviderError);
  });

  it("requires an explicit development flag for the fake adapter", () => {
    expect(() =>
      createMessagingProvider({
        provider: "fake",
        platform: "whatsapp",
      }),
    ).toThrowError(ProviderError);
    expect(
      createMessagingProvider({
        provider: "fake",
        platform: "whatsapp",
        allowDevelopmentFake: true,
      }).capabilities().textMessages,
    ).toBe(true);
  });
});
