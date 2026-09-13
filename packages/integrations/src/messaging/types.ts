export type NormalizedMessageType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "contact"
  | "unsupported";
export interface ProviderMessageResult {
  providerMessageId: string;
  acceptedAt: Date;
}
export interface SendMessageInput {
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  text: string;
  idempotencyKey: string;
  accessToken?: string;
  replyToMessageId?: string;
}
export interface SendTemplateInput {
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  templateName: string;
  language: string;
  variables: string[];
  componentParameters?: Array<{
    component: string;
    position: number;
    value: string;
  }>;
  idempotencyKey: string;
  accessToken?: string;
}
export interface SendReactionInput {
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  messageId: string;
  emoji: string;
  idempotencyKey: string;
  accessToken?: string;
}
export interface SendInteractiveInput {
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  interactive: Record<string, unknown>;
  idempotencyKey: string;
  accessToken?: string;
}
export interface SendMediaInput {
  channelId: string;
  phoneNumberId: string;
  recipient: string;
  mediaType: "image" | "video" | "audio" | "document";
  link?: string;
  mediaId?: string;
  filename?: string;
  caption?: string;
  idempotencyKey: string;
  accessToken?: string;
}
export interface UploadMediaInput {
  phoneNumberId: string;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
  accessToken?: string;
}
export interface ProviderMediaUploadResult {
  mediaId: string;
}
export interface MarkAsReadInput {
  phoneNumberId: string;
  providerMessageId: string;
  accessToken?: string;
}
export interface DownloadMediaInput {
  mediaId: string;
  phoneNumberId?: string;
  accessToken?: string;
}
export interface ProviderMediaResult {
  mediaId: string;
  contentType: string;
  bytes?: Uint8Array;
}
export interface MessagingProviderCapabilities {
  textMessages: boolean;
  templateMessages: boolean;
  mediaMessages: boolean;
  reactions: boolean;
  locations: boolean;
  contacts: boolean;
  groupConversations: boolean;
  templateManagement: {
    create: boolean;
    update: boolean;
    delete: boolean;
  };
}
export interface VerifyWebhookInput {
  rawBody: string;
  signature: string;
  appSecret: string;
}
export interface WebhookVerificationResult {
  valid: boolean;
}
export interface ProcessWebhookInput {
  payload: unknown;
  channelId: string;
}
export interface NormalizedWebhookEvent {
  eventKey: string;
  eventType: "message" | "status";
  payload: Record<string, unknown>;
}
export interface ProviderHealthCheckInput {
  phoneNumberId?: string;
  accessToken?: string;
  expectedWebhookCallbackUri?: string;
}
export interface ProviderHealthResult {
  healthy: boolean;
  status?: "healthy" | "warning" | "unhealthy" | "configuration_required";
  checkedAt: Date;
  code?: string;
  profile?: Record<string, string | null>;
}
export interface ProviderTemplate {
  providerTemplateId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  qualityScore?: string;
  rejectionReason?: string;
  headerType?: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttons?: unknown[];
  components?: Array<Record<string, unknown>>;
  parameterFormat?: "positional" | "named";
  previousCategory?: string;
  variables: Array<{
    component: string;
    position: number;
    variableName: string;
    exampleValue?: string;
  }>;
  providerPayload: Record<string, unknown>;
}
export interface ListTemplatesInput {
  businessAccountId?: string;
  accessToken?: string;
}
export interface CreateTemplateInput {
  businessAccountId?: string;
  accessToken?: string;
  name: string;
  language: string;
  category: string;
  components: Array<Record<string, unknown>>;
  parameterFormat?: "positional" | "named";
}
export interface UpdateTemplateInput {
  providerTemplateId: string;
  accessToken?: string;
  category?: string;
  components?: Array<Record<string, unknown>>;
}
export interface DeleteTemplateInput {
  businessAccountId?: string;
  accessToken?: string;
  providerTemplateId?: string;
  name?: string;
}
export interface ProviderTemplateMutationResult {
  providerTemplateId?: string;
  status: string;
  category?: string;
  raw: Record<string, unknown>;
}
export interface MessagingProvider {
  capabilities(): MessagingProviderCapabilities;
  sendMessage(input: SendMessageInput): Promise<ProviderMessageResult>;
  sendTemplate(input: SendTemplateInput): Promise<ProviderMessageResult>;
  sendReaction(input: SendReactionInput): Promise<ProviderMessageResult>;
  sendInteractive(input: SendInteractiveInput): Promise<ProviderMessageResult>;
  sendMedia(input: SendMediaInput): Promise<ProviderMessageResult>;
  uploadMedia(input: UploadMediaInput): Promise<ProviderMediaUploadResult>;
  listTemplates(input: ListTemplatesInput): Promise<ProviderTemplate[]>;
  createTemplate(
    input: CreateTemplateInput,
  ): Promise<ProviderTemplateMutationResult>;
  updateTemplate(
    input: UpdateTemplateInput,
  ): Promise<ProviderTemplateMutationResult>;
  deleteTemplate(
    input: DeleteTemplateInput,
  ): Promise<ProviderTemplateMutationResult>;
  markAsRead(input: MarkAsReadInput): Promise<void>;
  downloadMedia(input: DownloadMediaInput): Promise<ProviderMediaResult>;
  verifyWebhook(input: VerifyWebhookInput): Promise<WebhookVerificationResult>;
  processWebhook(input: ProcessWebhookInput): Promise<NormalizedWebhookEvent[]>;
  healthCheck(input: ProviderHealthCheckInput): Promise<ProviderHealthResult>;
}
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
