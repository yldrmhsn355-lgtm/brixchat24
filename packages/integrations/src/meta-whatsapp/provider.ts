import {
  normalizeProviderError,
  verifyMetaSignature,
} from "../messaging/utils";
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

type MetaTemplate = {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  quality_score?: { score?: string };
  rejected_reason?: string;
  components?: Array<{
    type?: string;
    format?: string;
    text?: string;
    buttons?: unknown[];
    example?: { body_text?: string[][] };
  }>;
};

export async function subscribeMetaAppToWaba(input: {
  businessAccountId: string;
  accessToken: string;
  apiVersion?: string;
  timeoutMs?: number;
  overrideCallbackUri: string;
  verifyToken: string;
}): Promise<void> {
  if (!input.overrideCallbackUri || !input.verifyToken)
    throw new ProviderError(
      "PROVIDER_INVALID_CONFIGURATION",
      false,
      "Meta WABA callback override requires a callback URL and verify token",
    );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 15000,
  );
  try {
    const subscriptionUrl =
      `https://graph.facebook.com/${input.apiVersion ?? "v25.0"}/${input.businessAccountId}/subscribed_apps`;
    const response = await fetch(
      subscriptionUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          override_callback_uri: input.overrideCallbackUri,
          verify_token: input.verifyToken,
        }),
        signal: controller.signal,
      },
    );
    if (response.ok) {
      const confirmation = await fetch(subscriptionUrl, {
        headers: { authorization: `Bearer ${input.accessToken}` },
        signal: controller.signal,
      });
      if (!confirmation.ok) {
        const normalized = normalizeProviderError(confirmation.status);
        throw new ProviderError(
          confirmation.status === 401
            ? "CHANNEL_AUTH_FAILED"
            : confirmation.status === 403
              ? "CHANNEL_PERMISSION_DENIED"
              : normalized.code,
          normalized.retryable,
          "Meta WABA webhook subscription verification failed",
        );
      }
      let confirmationBody: unknown;
      try {
        confirmationBody = await confirmation.json();
      } catch {
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          true,
          "Meta WABA webhook subscription verification returned invalid JSON",
        );
      }
      const subscriptions =
        typeof confirmationBody === "object" && confirmationBody !== null
          ? (confirmationBody as { data?: unknown }).data
          : null;
      const callbackConfirmed =
        Array.isArray(subscriptions) &&
        subscriptions.some(
          (subscription) =>
            typeof subscription === "object" &&
            subscription !== null &&
            (subscription as { override_callback_uri?: unknown })
              .override_callback_uri === input.overrideCallbackUri,
        );
      if (!callbackConfirmed)
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          true,
          "Meta WABA webhook callback override was not confirmed",
        );
      return;
    }
    const normalized = normalizeProviderError(response.status);
    throw new ProviderError(
      response.status === 401
        ? "CHANNEL_AUTH_FAILED"
        : response.status === 403
          ? "CHANNEL_PERMISSION_DENIED"
          : normalized.code,
      normalized.retryable,
      "Meta WABA webhook subscription failed",
    );
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        true,
        "Meta WABA webhook subscription timed out",
      );
    throw new ProviderError(
      "PROVIDER_NETWORK_ERROR",
      true,
      "Meta WABA webhook subscription failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function unsubscribeMetaAppFromWaba(input: {
  businessAccountId: string;
  accessToken: string;
  apiVersion?: string;
  timeoutMs?: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 15000,
  );
  try {
    const response = await fetch(
      `https://graph.facebook.com/${input.apiVersion ?? "v25.0"}/${input.businessAccountId}/subscribed_apps`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${input.accessToken}` },
        signal: controller.signal,
      },
    );
    if (response.ok) return;
    const normalized = normalizeProviderError(response.status);
    throw new ProviderError(
      response.status === 401
        ? "CHANNEL_AUTH_FAILED"
        : response.status === 403
          ? "CHANNEL_PERMISSION_DENIED"
          : normalized.code,
      normalized.retryable,
      "Meta WABA webhook unsubscription failed",
    );
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        true,
        "Meta WABA webhook unsubscription timed out",
      );
    throw new ProviderError(
      "PROVIDER_NETWORK_ERROR",
      true,
      "Meta WABA webhook unsubscription failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export class MetaWhatsAppCloudProvider implements MessagingProvider {
  capabilities(): MessagingProviderCapabilities {
    return {
      textMessages: true,
      templateMessages: true,
      mediaMessages: true,
      reactions: true,
      locations: true,
      contacts: true,
      groupConversations: false,
      templateManagement: { create: true, update: true, delete: true },
    };
  }
  constructor(
    private readonly apiVersion: string,
    private readonly timeoutMs = 15000,
    private readonly baseUrl = "https://graph.facebook.com",
  ) {}
  private async graph(
    url: string,
    accessToken: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, ...init?.headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { code?: unknown; message?: unknown } }
          | null;
        const normalized = normalizeProviderError(response.status);
        const metaCode =
          typeof payload?.error?.code === "number" ||
          typeof payload?.error?.code === "string"
            ? `META_${String(payload.error.code)}`
            : normalized.code;
        const metaMessage =
          typeof payload?.error?.message === "string"
            ? payload.error.message
            : "Meta request failed";
        throw new ProviderError(
          response.status === 401
            ? "CHANNEL_AUTH_FAILED"
            : response.status === 403
              ? "CHANNEL_PERMISSION_DENIED"
              : metaCode,
          normalized.retryable,
          metaMessage,
        );
      }
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ProviderError("PROVIDER_TIMEOUT", true, "Provider timeout");
      throw new ProviderError(
        "PROVIDER_NETWORK_ERROR",
        true,
        "Provider network error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  async sendMessage(input: SendMessageInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    const body = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.recipient,
          type: "text",
          text: { body: input.text },
          ...(input.replyToMessageId
            ? { context: { message_id: input.replyToMessageId } }
            : {}),
        }),
      },
    );
    const id = (body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (!id)
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        true,
        "Meta response missing message id",
      );
    return { providerMessageId: id, acceptedAt: new Date() };
  }
  async sendTemplate(input: SendTemplateInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    const grouped = new Map<
      string,
      Array<{ component: string; position: number; value: string }>
    >();
    for (const parameter of input.componentParameters ?? []) {
      const component = parameter.component.toLowerCase();
      grouped.set(component, [...(grouped.get(component) ?? []), parameter]);
    }
    const components = grouped.size
      ? [...grouped.entries()].map(([component, values]) => ({
          type: component,
          parameters: values
            .sort((left, right) => left.position - right.position)
            .map(({ value }) => ({ type: "text", text: value })),
        }))
      : input.variables.length
        ? [
            {
              type: "body",
              parameters: input.variables.map((text) => ({
                type: "text",
                text,
              })),
            },
          ]
        : [];
    const body = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.recipient,
          type: "template",
          template: {
            name: input.templateName,
            language: { code: input.language },
            components,
          },
        }),
      },
    );
    const id = (body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (!id)
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        true,
        "Meta response missing message id",
      );
    return { providerMessageId: id, acceptedAt: new Date() };
  }
  async sendReaction(input: SendReactionInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError("PROVIDER_CREDENTIALS_MISSING", false, "Provider credentials missing");
    const body = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.recipient,
          type: "reaction",
          reaction: { message_id: input.messageId, emoji: input.emoji },
        }),
      },
    );
    const id = (body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (!id) throw new ProviderError("PROVIDER_INVALID_RESPONSE", true, "Meta response missing message id");
    return { providerMessageId: id, acceptedAt: new Date() };
  }
  async sendInteractive(input: SendInteractiveInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError("PROVIDER_CREDENTIALS_MISSING", false, "Provider credentials missing");
    const body = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.recipient,
          type: "interactive",
          interactive: input.interactive,
        }),
      },
    );
    const id = (body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (!id) throw new ProviderError("PROVIDER_INVALID_RESPONSE", true, "Meta response missing message id");
    return { providerMessageId: id, acceptedAt: new Date() };
  }
  async sendMedia(input: SendMediaInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    if (!input.link && !input.mediaId)
      throw new ProviderError("MEDIA_REFERENCE_MISSING", false, "Media link or id is required");
    const media: Record<string, string> = input.mediaId
      ? { id: input.mediaId }
      : { link: input.link as string };
    if (input.caption) media.caption = input.caption;
    if (input.mediaType === "document" && input.filename)
      media.filename = input.filename;
    const body = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: input.recipient,
          type: input.mediaType,
          [input.mediaType]: media,
        }),
      },
    );
    const id = (body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
    if (!id)
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        true,
        "Meta response missing message id",
      );
    return { providerMessageId: id, acceptedAt: new Date() };
  }
  async uploadMedia(input: UploadMediaInput): Promise<ProviderMediaUploadResult> {
    if (!input.accessToken)
      throw new ProviderError("PROVIDER_CREDENTIALS_MISSING", false, "Provider credentials missing");
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", input.contentType);
    form.set("file", new Blob([Buffer.from(input.bytes)], { type: input.contentType }), input.filename);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/media`,
        { method: "POST", headers: { authorization: `Bearer ${input.accessToken}` }, body: form, signal: controller.signal },
      );
      if (!response.ok) {
        const normalized = normalizeProviderError(response.status);
        throw new ProviderError(
          response.status === 401 ? "CHANNEL_AUTH_FAILED" : response.status === 403 ? "CHANNEL_PERMISSION_DENIED" : normalized.code,
          normalized.retryable,
          "Meta media upload failed",
        );
      }
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id)
        throw new ProviderError("PROVIDER_INVALID_RESPONSE", true, "Meta response missing media id");
      return { mediaId: body.id };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ProviderError("PROVIDER_TIMEOUT", true, "Provider timeout");
      throw new ProviderError("PROVIDER_NETWORK_ERROR", true, "Provider network error");
    } finally {
      clearTimeout(timeout);
    }
  }
  async listTemplates(input: ListTemplatesInput): Promise<ProviderTemplate[]> {
    if (!input.accessToken || !input.businessAccountId)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    let url: string | undefined =
      `${this.baseUrl}/${this.apiVersion}/${input.businessAccountId}/message_templates?limit=100`;
    const output: ProviderTemplate[] = [];
    while (url) {
      const page = await this.graph(url, input.accessToken);
      for (const raw of (page.data as MetaTemplate[] | undefined) ?? []) {
        if (!raw.id || !raw.name || !raw.language) continue;
        const body = raw.components?.find(
          (c) => c.type?.toUpperCase() === "BODY",
        );
        const header = raw.components?.find(
          (c) => c.type?.toUpperCase() === "HEADER",
        );
        const footer = raw.components?.find(
          (c) => c.type?.toUpperCase() === "FOOTER",
        );
        const matches = [...(body?.text?.matchAll(/\{\{(\d+)\}\}/g) ?? [])];
        output.push({
          providerTemplateId: raw.id,
          name: raw.name,
          language: raw.language,
          category: raw.category ?? "UNKNOWN",
          status: (raw.status ?? "UNKNOWN").toLowerCase(),
          ...(raw.quality_score?.score
            ? { qualityScore: raw.quality_score.score }
            : {}),
          ...(raw.rejected_reason
            ? { rejectionReason: raw.rejected_reason }
            : {}),
          ...(header?.format
            ? { headerType: header.format.toLowerCase() }
            : {}),
          ...(header?.text ? { headerText: header.text } : {}),
          bodyText: body?.text ?? "",
          ...(footer?.text ? { footerText: footer.text } : {}),
          ...(raw.components?.flatMap((c) => c.buttons ?? []).length
            ? { buttons: raw.components.flatMap((c) => c.buttons ?? []) }
            : {}),
          ...(raw.components
            ? {
                components:
                  raw.components as Array<Record<string, unknown>>,
              }
            : {}),
          parameterFormat: "positional",
          variables: matches.map((match, index) => ({
            component: "body",
            position: Number(match[1]),
            variableName: `body_${match[1]}`,
            ...(body?.example?.body_text?.[0]?.[index]
              ? { exampleValue: body.example.body_text[0][index] }
              : {}),
          })),
          providerPayload: raw as Record<string, unknown>,
        });
      }
      const paging = page.paging as { next?: unknown } | undefined;
      url = typeof paging?.next === "string" ? paging.next : undefined;
    }
    return output;
  }
  async createTemplate(
    input: CreateTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    if (!input.accessToken || !input.businessAccountId)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    const raw = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.businessAccountId}/message_templates`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          language: input.language,
          category: input.category,
          components: input.components,
          ...(input.parameterFormat === "named"
            ? { parameter_format: "NAMED" }
            : {}),
        }),
      },
    );
    const providerTemplateId =
      typeof raw.id === "string" ? raw.id : undefined;
    if (!providerTemplateId)
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        true,
        "Meta template response missing id",
      );
    return {
      providerTemplateId,
      status: typeof raw.status === "string" ? raw.status.toLowerCase() : "pending",
      ...(typeof raw.category === "string" ? { category: raw.category } : {}),
      raw,
    };
  }
  async updateTemplate(
    input: UpdateTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    if (!input.category && !input.components)
      throw new ProviderError(
        "TEMPLATE_UPDATE_EMPTY",
        false,
        "Template update has no supported fields",
      );
    const raw = await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.providerTemplateId}`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(input.category ? { category: input.category } : {}),
          ...(input.components ? { components: input.components } : {}),
        }),
      },
    );
    return {
      providerTemplateId: input.providerTemplateId,
      status: "pending",
      ...(input.category ? { category: input.category } : {}),
      raw,
    };
  }
  async deleteTemplate(
    input: DeleteTemplateInput,
  ): Promise<ProviderTemplateMutationResult> {
    if (!input.accessToken || !input.businessAccountId)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    if (!input.providerTemplateId && !input.name)
      throw new ProviderError(
        "TEMPLATE_IDENTITY_REQUIRED",
        false,
        "Template id or name is required",
      );
    const endpoint = `${this.baseUrl}/${this.apiVersion}/${input.businessAccountId}/message_templates`;
    let raw: Record<string, unknown>;
    if (input.providerTemplateId) {
      try {
        raw = await this.graph(
          `${endpoint}?hsm_id=${encodeURIComponent(input.providerTemplateId)}`,
          input.accessToken,
          { method: "DELETE" },
        );
      } catch (error) {
        if (!(error instanceof ProviderError) || !input.name) throw error;
        raw = await this.graph(
          `${endpoint}?name=${encodeURIComponent(input.name)}`,
          input.accessToken,
          { method: "DELETE" },
        );
      }
    } else {
      raw = await this.graph(
        `${endpoint}?name=${encodeURIComponent(input.name!)}`,
        input.accessToken,
        { method: "DELETE" },
      );
    }
    return {
      ...(input.providerTemplateId
        ? { providerTemplateId: input.providerTemplateId }
        : {}),
      status: "deleted",
      raw,
    };
  }
  async markAsRead(input: MarkAsReadInput): Promise<void> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    await this.graph(
      `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}/messages`,
      input.accessToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: input.providerMessageId,
        }),
      },
    );
  }
  async downloadMedia(input: DownloadMediaInput): Promise<ProviderMediaResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "PROVIDER_CREDENTIALS_MISSING",
        false,
        "Provider credentials missing",
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const query = input.phoneNumberId
        ? `?phone_number_id=${encodeURIComponent(input.phoneNumberId)}`
        : "";
      const metadataResponse = await fetch(
        `${this.baseUrl}/${this.apiVersion}/${encodeURIComponent(input.mediaId)}${query}`,
        {
          headers: { authorization: `Bearer ${input.accessToken}` },
          signal: controller.signal,
        },
      );
      if (!metadataResponse.ok) {
        const normalized = normalizeProviderError(metadataResponse.status);
        throw new ProviderError(
          metadataResponse.status === 401
            ? "CHANNEL_AUTH_FAILED"
            : metadataResponse.status === 403
              ? "CHANNEL_PERMISSION_DENIED"
              : normalized.code,
          normalized.retryable,
          "Meta media metadata request failed",
        );
      }
      const metadata = (await metadataResponse.json()) as {
        url?: unknown;
        mime_type?: unknown;
      };
      if (typeof metadata.url !== "string" || !metadata.url)
        throw new ProviderError(
          "PROVIDER_INVALID_RESPONSE",
          true,
          "Meta media response missing URL",
        );
      const mediaResponse = await fetch(metadata.url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
        signal: controller.signal,
      });
      if (!mediaResponse.ok) {
        const normalized = normalizeProviderError(mediaResponse.status);
        throw new ProviderError(
          mediaResponse.status === 401
            ? "CHANNEL_AUTH_FAILED"
            : mediaResponse.status === 403
              ? "CHANNEL_PERMISSION_DENIED"
              : normalized.code,
          normalized.retryable,
          "Meta media download failed",
        );
      }
      return {
        mediaId: input.mediaId,
        contentType:
          mediaResponse.headers.get("content-type") ??
          (typeof metadata.mime_type === "string"
            ? metadata.mime_type
            : "application/octet-stream"),
        bytes: new Uint8Array(await mediaResponse.arrayBuffer()),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError")
        throw new ProviderError("PROVIDER_TIMEOUT", true, "Media download timed out");
      throw new ProviderError(
        "PROVIDER_NETWORK_ERROR",
        true,
        "Meta media download network error",
      );
    } finally {
      clearTimeout(timeout);
    }
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
    _input: ProcessWebhookInput,
  ): Promise<NormalizedWebhookEvent[]> {
    return [];
  }
  async healthCheck(
    input: ProviderHealthCheckInput,
  ): Promise<ProviderHealthResult> {
    if (!input.phoneNumberId || !input.accessToken)
      return {
        healthy: false,
        status: "configuration_required",
        checkedAt: new Date(),
        code: !input.accessToken
          ? "CHANNEL_TOKEN_MISSING"
          : "CHANNEL_PHONE_NUMBER_ID_MISSING",
      };
    try {
      const body = await this.graph(
        `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type`,
        input.accessToken,
      );
      let webhookRouteSource: string | null = null;
      let webhookRouteMatches: string | null = null;
      let webhookRouteUnverified = false;
      try {
        const webhookBody = await this.graph(
          `${this.baseUrl}/${this.apiVersion}/${input.phoneNumberId}?fields=webhook_configuration`,
          input.accessToken,
        );
        const webhookConfiguration =
          typeof webhookBody.webhook_configuration === "object" &&
          webhookBody.webhook_configuration !== null
            ? (webhookBody.webhook_configuration as Record<string, unknown>)
            : {};
        const candidates = [
          ["phone_number", webhookConfiguration.phone_number],
          [
            "whatsapp_business_account",
            webhookConfiguration.whatsapp_business_account,
          ],
          ["application", webhookConfiguration.application],
        ] as const;
        const effectiveRoute = candidates.find(
          ([, value]) => typeof value === "string" && value.length > 0,
        );
        webhookRouteSource = effectiveRoute?.[0] ?? null;
        if (input.expectedWebhookCallbackUri && effectiveRoute)
          webhookRouteMatches = String(
            effectiveRoute[1] === input.expectedWebhookCallbackUri,
          );
      } catch {
        webhookRouteUnverified = true;
      }
      const profile = {
        displayPhoneNumber:
          typeof body.display_phone_number === "string"
            ? body.display_phone_number
            : null,
        verifiedName:
          typeof body.verified_name === "string" ? body.verified_name : null,
        qualityRating:
          typeof body.quality_rating === "string" ? body.quality_rating : null,
        codeVerificationStatus:
          typeof body.code_verification_status === "string"
            ? body.code_verification_status
            : null,
        platformType:
          typeof body.platform_type === "string" ? body.platform_type : null,
        webhookRouteSource,
        webhookRouteMatches,
      };
      if (input.expectedWebhookCallbackUri && webhookRouteMatches === "false")
        return {
          healthy: false,
          status: "unhealthy",
          checkedAt: new Date(),
          code: "CHANNEL_WEBHOOK_ROUTE_MISMATCH",
          profile,
        };
      if (input.expectedWebhookCallbackUri && webhookRouteUnverified)
        return {
          healthy: true,
          status: "warning",
          checkedAt: new Date(),
          code: "CHANNEL_WEBHOOK_ROUTE_UNVERIFIED",
          profile,
        };
      return {
        healthy: true,
        status: "healthy",
        checkedAt: new Date(),
        profile,
      };
    } catch (error) {
      return {
        healthy: false,
        status: "unhealthy",
        checkedAt: new Date(),
        code:
          error instanceof ProviderError
            ? error.code
            : "CHANNEL_META_UNREACHABLE",
      };
    }
  }
}
