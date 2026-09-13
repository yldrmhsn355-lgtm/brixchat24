/**
 * Core domain types for the AI agent platform.
 *
 * This package holds provider-neutral orchestration logic. It never touches
 * the database directly: all persistence goes through the gateway interfaces
 * below, implemented by the worker/API using the AiRepository. Channel
 * delivery always goes through the existing outbound pipeline (messages +
 * outbox_jobs); this package only decides what, whether, and when.
 */

export type AiMode = "observe" | "copilot" | "approval" | "autopilot";

export type AiRunDecision =
  | "observed"
  | "suggested"
  | "draft_created"
  | "auto_sent"
  | "blocked"
  | "handoff"
  | "skipped";

export type HandoffReason =
  | "LOW_CONFIDENCE"
  | "HUMAN_REQUESTED"
  | "MISSING_KNOWLEDGE"
  | "RESTRICTED_TOPIC"
  | "TOOL_FAILURE"
  | "NEGATIVE_SENTIMENT"
  | "BUSINESS_RULE"
  | "UNSUPPORTED_MEDIA"
  | "MODEL_FAILURE";

export type ToolAccess = "allowed" | "approval" | "denied";

export type ToolClass = "read_only" | "mutating" | "sensitive";

/** Immutable snapshot of an agent version, resolved from ai_agent_versions. */
export interface AgentVersionConfig {
  agentId: string;
  agentVersionId: string;
  agentName: string;
  version: number;
  mode: AiMode;
  model: string;
  fallbackModel: string | null;
  temperature: number;
  maxSteps: number;
  maxCostPerRunUsd: number;
  defaultLanguage: string;
  allowedLanguages: string[];
  systemInstruction: string;
  businessObjective: string;
  persona: {
    tone?: string;
    personality?: string;
    communicationStyle?: string;
    responseLength?: "short" | "medium" | "long";
    emojiPolicy?: "none" | "sparse" | "free";
  };
  behaviorRules: string[];
  forbiddenTopics: string[];
  exampleResponses: Array<{ customer: string; reply: string }>;
  handoffRules: {
    onHumanRequest?: boolean;
    onNegativeSentiment?: boolean;
    onMissingKnowledge?: boolean;
    restrictedIntents?: string[];
    maxConsecutiveAiMessages?: number;
  };
  confidenceThreshold: number;
  workingHours: {
    timezone?: string;
    /** "1".."7" (ISO weekday) -> [{ start: "09:00", end: "18:00" }] */
    schedule?: Record<string, Array<{ start: string; end: string }>>;
    outsideHoursMode?: "off" | "observe" | "normal";
  };
  responseDelayMinMs: number;
  responseDelayMaxMs: number;
  toolPermissions: Record<string, ToolAccess>;
  config: {
    debounceMs?: number;
    webSearchEnabled?: boolean;
    visionEnabled?: boolean;
    maxOutputTokens?: number;
    citeSources?: boolean;
  };
}

/** Strict per-run scope. Every tool and query is bound to these ids. */
export interface RunScope {
  organizationId: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  runId: string;
  correlationId: string;
}

export interface ConversationMessageDto {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  body: string;
  senderName?: string | null;
  origin?: string | null;
  sentAt: string;
  /**
   * Base64 data URL of an image attachment, populated by the orchestrator
   * only when the agent has vision enabled and the attachment passed the
   * malware scan. Never persisted; used for the current model call only.
   */
  imageDataUrl?: string | null;
}

export interface CustomerContextDto {
  displayName: string;
  language: string | null;
  country: string | null;
  phoneMasked: string;
  tags: string[];
  customFields: Record<string, unknown>;
  memory: Record<string, unknown>;
}

export interface ChannelContextDto {
  name: string;
  provider: string;
  platform: string;
  phoneNumber: string | null;
  /** Meta 24h customer-service window still open? */
  serviceWindowOpen: boolean;
}

export interface ConversationContextDto {
  status: string;
  stage: string;
  priority: string;
  assigneeName: string | null;
  summary: string | null;
  summaryFacts: Record<string, unknown>;
  recentMessages: ConversationMessageDto[];
}

export interface KnowledgeChunkRef {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  knowledgeBaseId: string;
  score: number;
  content: string;
}

export interface WorkspacePolicy {
  organizationName: string;
  sensitiveBusinessMode: boolean;
  extraPolicy: string;
}

/** Full prompt-building input assembled by the orchestrator. */
export interface PromptContext {
  workspace: WorkspacePolicy;
  agent: AgentVersionConfig;
  channel: ChannelContextDto;
  customer: CustomerContextDto;
  conversation: ConversationContextDto;
  knowledge: KnowledgeChunkRef[];
  currentMessages: ConversationMessageDto[];
  nowIso: string;
}

/** Normalized result contract every run produces. */
export interface AiResponseContract {
  text: string;
  language: string;
  intent: string | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  confidence: number;
  shouldSend: boolean;
  requiresHuman: boolean;
  handoffReason: HandoffReason | null;
  suggestedActions: string[];
  knowledgeSources: Array<{ chunkId: string; documentId: string; title: string; score: number }>;
  toolCalls: Array<{
    name: string;
    status: "completed" | "failed" | "denied";
    durationMs: number;
    summary: string;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  };
  modelUsed: string;
  fallbackUsed: boolean;
  steps: number;
  latencyMs: number;
}

/** Structured events emitted during a run for observability. */
export type AiRunEventType =
  | "ai_run_started"
  | "context_built"
  | "knowledge_retrieved"
  | "model_request_started"
  | "tool_called"
  | "tool_completed"
  | "tool_denied"
  | "ai_response_generated"
  | "policy_checked"
  | "ai_run_completed"
  | "ai_run_failed";

export interface AiRunEvent {
  type: AiRunEventType;
  runId: string;
  organizationId: string;
  agentId: string;
  detail?: Record<string, unknown>;
}

export type AiRunEventSink = (event: AiRunEvent) => void;

/**
 * Server-side gateway the domain tools call into. Every implementation MUST
 * scope queries by the RunScope it was constructed with — tool arguments
 * from the model never carry ids.
 */
export interface AiToolGateway {
  searchKnowledge(query: string, limit: number): Promise<KnowledgeChunkRef[]>;
  getContact(): Promise<CustomerContextDto>;
  getConversationContext(): Promise<ConversationContextDto>;
  getBusinessHours(): Promise<{ open: boolean; schedule: string }>;
  listApprovedTemplates(): Promise<Array<{ name: string; description: string }>>;
  addLabel(label: string): Promise<{ ok: boolean; message: string }>;
  createInternalNote(note: string): Promise<{ ok: boolean }>;
  requestHandoff(reason: string): Promise<{ ok: boolean }>;
  rememberCustomerFact(
    key: string,
    value: string,
  ): Promise<{ ok: boolean; message: string }>;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class AiRunError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiRunError";
  }
}
