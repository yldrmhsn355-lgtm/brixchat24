import {
  ProviderError,
  type MessagingProvider,
  type ProviderMessageResult,
} from "../messaging/types";
import type {
  CreateTemplateInput,
  DeleteTemplateInput,
  DownloadMediaInput,
  ListTemplatesInput,
  MarkAsReadInput,
  ProcessWebhookInput,
  ProviderHealthCheckInput,
  SendInteractiveInput,
  SendMediaInput,
  SendMessageInput,
  SendReactionInput,
  SendTemplateInput,
  UpdateTemplateInput,
  UploadMediaInput,
  VerifyWebhookInput,
} from "../messaging/types";

type TelegramResponse<T> = { ok: boolean; result?: T; description?: string };

async function telegramCall<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: body ? "POST" : "GET",
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
        signal: controller.signal,
      },
    );
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok)
      throw new ProviderError(
        response.status === 401
          ? "CHANNEL_AUTH_FAILED"
          : "PROVIDER_REQUEST_FAILED",
        response.status === 429 || response.status >= 500,
        payload.description ?? "Telegram Bot API request failed",
      );
    if (payload.result === undefined)
      throw new ProviderError(
        "PROVIDER_INVALID_RESPONSE",
        true,
        "Telegram response has no result",
      );
    return payload.result;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      error instanceof Error && error.name === "AbortError"
        ? "PROVIDER_TIMEOUT"
        : "PROVIDER_NETWORK_ERROR",
      true,
      "Telegram Bot API request failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function configureTelegramWebhook(input: {
  accessToken: string;
  callbackUrl: string;
  secretToken: string;
  timeoutMs?: number;
}) {
  const bot = await telegramCall<{
    id: number;
    username?: string;
    first_name?: string;
  }>(input.accessToken, "getMe", undefined, input.timeoutMs);
  await telegramCall<boolean>(
    input.accessToken,
    "setWebhook",
    {
      url: input.callbackUrl,
      secret_token: input.secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    },
    input.timeoutMs,
  );
  return bot;
}

export async function removeTelegramWebhook(input: {
  accessToken: string;
  timeoutMs?: number;
}) {
  await telegramCall<boolean>(
    input.accessToken,
    "deleteWebhook",
    { drop_pending_updates: false },
    input.timeoutMs,
  );
}

export function normalizeTelegramWebhookUpdate(updateValue: unknown) {
  if (!updateValue || typeof updateValue !== "object") return null;
  const update = updateValue as Record<string, unknown>;
  const message = update.message as Record<string, unknown> | undefined;
  const chat = message?.chat as Record<string, unknown> | undefined;
  const sender = message?.from as Record<string, unknown> | undefined;
  if (
    !Number.isInteger(update.update_id) ||
    !message ||
    chat?.type !== "private" ||
    typeof chat.id !== "number" ||
    typeof sender?.id !== "number" ||
    typeof message.message_id !== "number" ||
    typeof message.text !== "string"
  )
    return null;
  const chatId = String(chat.id);
  const displayName =
    [sender.first_name, sender.last_name]
      .filter((value): value is string => typeof value === "string")
      .join(" ") || String(sender.username ?? chatId);
  return {
    eventKey: `telegram:${String(update.update_id)}`,
    payload: {
      changes: [
        {
          field: "messages",
          value: {
            contacts: [{ wa_id: chatId, profile: { name: displayName } }],
            messages: [
              {
                id: `${chatId}:${String(message.message_id)}`,
                from: chatId,
                timestamp: String(
                  message.date ?? Math.floor(Date.now() / 1000),
                ),
                type: "text",
                text: { body: message.text },
                telegram: { chatId, username: sender.username ?? null },
              },
            ],
          },
        },
      ],
    },
  };
}

const unsupported = (operation: string): never => {
  throw new ProviderError(
    "PROVIDER_CAPABILITY_UNSUPPORTED",
    false,
    `Telegram ${operation} is not enabled`,
  );
};

export class TelegramBotProvider implements MessagingProvider {
  constructor(private readonly timeoutMs = 15_000) {}
  capabilities() {
    return {
      textMessages: true,
      templateMessages: false,
      mediaMessages: false,
      reactions: false,
      locations: false,
      contacts: false,
      groupConversations: false,
      templateManagement: { create: false, update: false, delete: false },
    };
  }
  async sendMessage(input: SendMessageInput): Promise<ProviderMessageResult> {
    if (!input.accessToken)
      throw new ProviderError(
        "CHANNEL_AUTH_FAILED",
        false,
        "Telegram bot token is missing",
      );
    const result = await telegramCall<{ message_id: number; date: number }>(
      input.accessToken,
      "sendMessage",
      {
        chat_id: input.recipient.replace(/^\+/, ""),
        text: input.text,
        ...(input.replyToMessageId
          ? {
              reply_parameters: {
                message_id: Number(input.replyToMessageId.split(":").at(-1)),
              },
            }
          : {}),
      },
      this.timeoutMs,
    );
    return {
      providerMessageId: `${input.recipient.replace(/^\+/, "")}:${result.message_id}`,
      acceptedAt: new Date(result.date * 1000),
    };
  }
  async healthCheck(input: ProviderHealthCheckInput) {
    if (!input.accessToken)
      return {
        healthy: false,
        status: "configuration_required" as const,
        checkedAt: new Date(),
        code: "CHANNEL_AUTH_REQUIRED",
      };
    const bot = await telegramCall<{
      id: number;
      username?: string;
      first_name?: string;
    }>(input.accessToken, "getMe", undefined, this.timeoutMs);
    return {
      healthy: true,
      status: "healthy" as const,
      checkedAt: new Date(),
      profile: {
        id: String(bot.id),
        name: bot.first_name ?? null,
        username: bot.username ?? null,
      },
    };
  }
  async sendTemplate(
    _input: SendTemplateInput,
  ): Promise<ProviderMessageResult> {
    return unsupported("templates");
  }
  async sendReaction(
    _input: SendReactionInput,
  ): Promise<ProviderMessageResult> {
    return unsupported("reactions");
  }
  async sendInteractive(
    _input: SendInteractiveInput,
  ): Promise<ProviderMessageResult> {
    return unsupported("interactive messages");
  }
  async sendMedia(_input: SendMediaInput): Promise<ProviderMessageResult> {
    return unsupported("media");
  }
  async uploadMedia(_input: UploadMediaInput) {
    return unsupported("media upload");
  }
  async listTemplates(_input: ListTemplatesInput) {
    return [];
  }
  async createTemplate(_input: CreateTemplateInput) {
    return unsupported("template creation");
  }
  async updateTemplate(_input: UpdateTemplateInput) {
    return unsupported("template updates");
  }
  async deleteTemplate(_input: DeleteTemplateInput) {
    return unsupported("template deletion");
  }
  async markAsRead(_input: MarkAsReadInput) {}
  async downloadMedia(_input: DownloadMediaInput) {
    return unsupported("media download");
  }
  async verifyWebhook(_input: VerifyWebhookInput) {
    return { valid: false };
  }
  async processWebhook(_input: ProcessWebhookInput) {
    return [];
  }
}
