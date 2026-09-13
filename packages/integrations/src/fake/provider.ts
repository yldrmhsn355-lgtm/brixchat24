import { deterministicEventKey, verifyMetaSignature } from "../messaging/utils";
import {
  ProviderError,
  type CreateTemplateInput,
  type DeleteTemplateInput,
  type DownloadMediaInput,
  type ListTemplatesInput,
  type MarkAsReadInput,
  type MessagingProvider,
  type MessagingProviderCapabilities,
  type NormalizedWebhookEvent,
  type ProcessWebhookInput,
  type ProviderHealthCheckInput,
  type ProviderHealthResult,
  type ProviderMediaResult,
  type ProviderMediaUploadResult,
  type ProviderMessageResult,
  type ProviderTemplate,
  type ProviderTemplateMutationResult,
  type SendMessageInput,
  type SendInteractiveInput,
  type SendReactionInput,
  type SendMediaInput,
  type SendTemplateInput,
  type UploadMediaInput,
  type UpdateTemplateInput,
  type VerifyWebhookInput,
  type WebhookVerificationResult,
} from "../messaging/types";

export type FakeMode =
  | "success"
  | "temporary_error"
  | "permanent_error"
  | "auth_failure"
  | "token_expired"
  | "permission_denied";

const templates: ProviderTemplate[] = [
  {
    providerTemplateId: "fake-welcome-en",
    name: "welcome_patient",
    language: "en_US",
    category: "UTILITY",
    status: "approved",
    bodyText: "Hello {{1}}, your appointment is on {{2}}.",
    variables: [
      {
        component: "body",
        position: 1,
        variableName: "patient_name",
        exampleValue: "Elena",
      },
      {
        component: "body",
        position: 2,
        variableName: "appointment_date",
        exampleValue: "July 24",
      },
    ],
    providerPayload: { id: "fake-welcome-en" },
  },
  {
    providerTemplateId: "fake-pending-tr",
    name: "appointment_pending",
    language: "tr",
    category: "UTILITY",
    status: "pending",
    bodyText: "Merhaba {{1}}",
    variables: [
      {
        component: "body",
        position: 1,
        variableName: "name",
        exampleValue: "Deniz",
      },
    ],
    providerPayload: { id: "fake-pending-tr" },
  },
  {
    providerTemplateId: "fake-rejected-en",
    name: "old_offer",
    language: "en_US",
    category: "MARKETING",
    status: "rejected",
    rejectionReason: "Example policy rejection",
    bodyText: "Offer for {{1}}",
    variables: [{ component: "body", position: 1, variableName: "name" }],
    providerPayload: { id: "fake-rejected-en" },
  },
];

export class FakeMessagingProvider implements MessagingProvider {
  constructor(
    private readonly mode: FakeMode = "success",
    private readonly latencyMs = 10,
  ) {}
  capabilities(): MessagingProviderCapabilities {
    return {
      textMessages: true,
      templateMessages: true,
      mediaMessages: true,
      reactions: false,
      locations: true,
      contacts: true,
      groupConversations: false,
      templateManagement: { create: true, update: true, delete: true },
    };
  }
  private async ready() {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (this.mode === "temporary_error")
      throw new ProviderError(
        "FAKE_TEMPORARY",
        true,
        "Temporary provider failure",
      );
    if (this.mode === "permanent_error")
      throw new ProviderError(
        "FAKE_PERMANENT",
        false,
        "Permanent provider failure",
      );
    if (this.mode === "auth_failure" || this.mode === "token_expired")
      throw new ProviderError(
        "CHANNEL_AUTH_FAILED",
        false,
        "Fake authentication failure",
      );
    if (this.mode === "permission_denied")
      throw new ProviderError(
        "CHANNEL_PERMISSION_DENIED",
        false,
        "Fake permission failure",
      );
  }
  async sendMessage(input: SendMessageInput): Promise<ProviderMessageResult> {
    await this.ready();
    return {
      providerMessageId: `fake_${deterministicEventKey(input.idempotencyKey).slice(0, 24)}`,
      acceptedAt: new Date(),
    };
  }
  async sendTemplate(input: SendTemplateInput): Promise<ProviderMessageResult> {
    await this.ready();
    const template = templates.find(
      (item) =>
        item.name === input.templateName && item.language === input.language,
    );
    if (!template || template.status !== "approved")
      throw new ProviderError(
        "TEMPLATE_NOT_APPROVED",
        false,
        "Template is unavailable",
      );
    if (input.variables.length !== template.variables.length)
      throw new ProviderError(
        "TEMPLATE_VARIABLES_INVALID",
        false,
        "Template variables are invalid",
      );
    return {
      providerMessageId: `fake_tpl_${deterministicEventKey(input.idempotencyKey).slice(0, 20)}`,
      acceptedAt: new Date(),
    };
  }
  async sendReaction(input: SendReactionInput): Promise<ProviderMessageResult> {
    await this.ready();
    return {
      providerMessageId: `fake_reaction_${deterministicEventKey(input.idempotencyKey).slice(0, 18)}`,
      acceptedAt: new Date(),
    };
  }
  async sendInteractive(
    input: SendInteractiveInput,
  ): Promise<ProviderMessageResult> {
    await this.ready();
    return {
      providerMessageId: `fake-interactive-${input.idempotencyKey}`,
      acceptedAt: new Date(),
    };
  }
  async sendMedia(input: SendMediaInput): Promise<ProviderMessageResult> {
    await this.ready();
    return {
      providerMessageId: `fake_media_${deterministicEventKey(input.idempotencyKey).slice(0, 18)}`,
      acceptedAt: new Date(),
    };
  }
  async uploadMedia(
    input: UploadMediaInput,
  ): Promise<ProviderMediaUploadResult> {
    await this.ready();
    return {
      mediaId: `fake_upload_${deterministicEventKey(input.filename + input.contentType).slice(0, 18)}`,
    };
  }
  async listTemplates(_input: ListTemplatesInput): Promise<ProviderTemplate[]> {
    await this.ready();
    return templates.map((item) => structuredClone(item));
  }
  async createTemplate(
    input: CreateTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    await this.ready();
    return {
      providerTemplateId: `fake-created-${deterministicEventKey([
        input.businessAccountId,
        input.name,
        input.language,
      ]).slice(0, 16)}`,
      status: "pending",
      category: input.category,
      raw: { success: true, fixture: true },
    };
  }
  async updateTemplate(
    input: UpdateTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    await this.ready();
    return {
      providerTemplateId: input.providerTemplateId,
      status: "pending",
      ...(input.category ? { category: input.category } : {}),
      raw: { success: true, fixture: true },
    };
  }
  async deleteTemplate(
    input: DeleteTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    await this.ready();
    return {
      ...(input.providerTemplateId
        ? { providerTemplateId: input.providerTemplateId }
        : {}),
      status: "deleted",
      raw: { success: true, fixture: true },
    };
  }
  async markAsRead(_input: MarkAsReadInput): Promise<void> {}
  async downloadMedia(input: DownloadMediaInput): Promise<ProviderMediaResult> {
    await this.ready();
    return {
      mediaId: input.mediaId,
      contentType: "image/png",
      bytes: Uint8Array.from(
        Buffer.from(
          [
            "iVBORw0KGgoAAAANSUhEUgAA",
            "AAEAAAABCAQAAAC1HAwCAAAA",
            "C0lEQVR42mNk+A8AAQUBAScY",
            "42YAAAAASUVORK5CYII=",
          ].join(""),
          "base64",
        ),
      ),
    };
  }
  async verifyWebhook(
    input: VerifyWebhookInput,
  ): Promise<WebhookVerificationResult> {
    return {
      valid: verifyMetaSignature(
        input.rawBody,
        input.signature,
        input.appSecret,
      ),
    };
  }
  async processWebhook(
    input: ProcessWebhookInput,
  ): Promise<NormalizedWebhookEvent[]> {
    const payload = input.payload as Record<string, unknown>;
    return [
      {
        eventKey: deterministicEventKey(payload),
        eventType: "message",
        payload,
      },
    ];
  }
  async healthCheck(
    _input: ProviderHealthCheckInput,
  ): Promise<ProviderHealthResult> {
    try {
      await this.ready();
      return {
        healthy: true,
        status: "healthy",
        checkedAt: new Date(),
        profile: {
          displayPhoneNumber: "+90 850 555 2400",
          verifiedName: "Brixchat24 Fake",
          qualityRating: "GREEN",
          messagingLimit: "TIER_1K",
        },
      };
    } catch (error) {
      const code =
        error instanceof ProviderError
          ? error.code
          : "CHANNEL_META_UNREACHABLE";
      return {
        healthy: false,
        status: "unhealthy",
        checkedAt: new Date(),
        code,
      };
    }
  }
}
