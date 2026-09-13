import { serverTool, tool } from "@openrouter/agent/tool";
import type { Tool } from "@openrouter/agent";
import { z } from "zod";
import type {
  AgentVersionConfig,
  AiRunEventSink,
  AiToolGateway,
  RunScope,
  ToolAccess,
  ToolClass,
} from "./types";

/**
 * Domain tools exposed to the model. Security model:
 * - Tools never accept organization/conversation/contact ids from the model.
 *   The gateway is constructed per run, closed over the RunScope, so a tool
 *   call can only ever touch the current conversation's data.
 * - Per-agent allowlist (toolPermissions) is enforced here in code before
 *   the gateway is invoked. "approval" tools are denied at runtime for
 *   autonomous runs; the model is told to suggest the action instead.
 * - No shell, no filesystem, no arbitrary HTTP, no SQL.
 */

export const TOOL_CLASSES: Record<string, ToolClass> = {
  search_knowledge: "read_only",
  get_contact: "read_only",
  get_conversation_context: "read_only",
  get_business_hours: "read_only",
  list_approved_templates: "read_only",
  add_label: "mutating",
  create_internal_note: "mutating",
  remember_customer_fact: "sensitive",
  handoff_to_human: "read_only",
  finalize_reply: "read_only",
};

/** Tools that must always be available regardless of configuration. */
const ALWAYS_ALLOWED = new Set(["finalize_reply", "handoff_to_human", "search_knowledge"]);

const DEFAULT_ACCESS: Record<ToolClass, ToolAccess> = {
  read_only: "allowed",
  mutating: "allowed",
  sensitive: "approval",
};

export function resolveToolAccess(
  agent: AgentVersionConfig,
  toolName: string,
): ToolAccess {
  if (ALWAYS_ALLOWED.has(toolName)) return "allowed";
  const configured = agent.toolPermissions[toolName];
  if (configured) return configured;
  const toolClass = TOOL_CLASSES[toolName] ?? "sensitive";
  return DEFAULT_ACCESS[toolClass];
}

export const finalizeReplySchema = z.object({
  text: z
    .string()
    .min(1)
    .max(4000)
    .describe("The exact reply to show or send to the customer."),
  language: z
    .string()
    .min(2)
    .max(12)
    .describe("BCP-47 language code of the reply, e.g. 'tr' or 'en'."),
  intent: z
    .string()
    .max(60)
    .nullable()
    .describe("Short label of the customer's intent, e.g. 'pricing_question'."),
  sentiment: z.enum(["positive", "neutral", "negative"]).nullable(),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Honest confidence that this reply is correct, grounded, and appropriate to send without human review.",
    ),
  requiresHuman: z
    .boolean()
    .describe("True when a human must review or take over this conversation."),
  handoffReason: z
    .enum([
      "LOW_CONFIDENCE",
      "HUMAN_REQUESTED",
      "MISSING_KNOWLEDGE",
      "RESTRICTED_TOPIC",
      "TOOL_FAILURE",
      "NEGATIVE_SENTIMENT",
      "BUSINESS_RULE",
      "UNSUPPORTED_MEDIA",
    ])
    .nullable(),
  suggestedActions: z
    .array(z.string().max(120))
    .max(5)
    .describe("Optional follow-up actions for the human team, empty if none."),
});

export type FinalizeReplyInput = z.infer<typeof finalizeReplySchema>;

export interface BuiltTools {
  tools: Tool[];
  /** Populated after the run: the validated finalize_reply payload, if any. */
  getFinalReply(): FinalizeReplyInput | null;
  getToolJournal(): Array<{
    name: string;
    status: "completed" | "failed" | "denied";
    durationMs: number;
    summary: string;
  }>;
  handoffRequested(): { requested: boolean; reason: string };
}

export function buildTools(input: {
  scope: RunScope;
  agent: AgentVersionConfig;
  gateway: AiToolGateway;
  events: AiRunEventSink;
}): BuiltTools {
  const { scope, agent, gateway, events } = input;
  let finalReply: FinalizeReplyInput | null = null;
  let handoff = { requested: false, reason: "" };
  const journal: Array<{
    name: string;
    status: "completed" | "failed" | "denied";
    durationMs: number;
    summary: string;
  }> = [];

  const record = (
    name: string,
    status: "completed" | "failed" | "denied",
    startedAt: number,
    summary: string,
  ) => {
    journal.push({
      name,
      status,
      durationMs: Date.now() - startedAt,
      summary: summary.slice(0, 300),
    });
    events({
      type: status === "denied" ? "tool_denied" : "tool_completed",
      runId: scope.runId,
      organizationId: scope.organizationId,
      agentId: scope.agentId,
      detail: { tool: name, status },
    });
  };

  /** Wrap a tool executor with allowlist enforcement + journaling. */
  const guarded = <TArgs, TResult>(
    name: string,
    summarize: (result: TResult) => string,
    executor: (args: TArgs) => Promise<TResult>,
  ) => {
    return async (args: TArgs): Promise<TResult | { denied: true; message: string }> => {
      const startedAt = Date.now();
      events({
        type: "tool_called",
        runId: scope.runId,
        organizationId: scope.organizationId,
        agentId: scope.agentId,
        detail: { tool: name },
      });
      const access = resolveToolAccess(agent, name);
      if (access !== "allowed") {
        record(name, "denied", startedAt, `access=${access}`);
        return {
          denied: true as const,
          message:
            access === "approval"
              ? "This action needs human approval. Mention it in suggestedActions instead of performing it."
              : "This tool is not available for this agent.",
        };
      }
      try {
        const result = await executor(args);
        record(name, "completed", startedAt, summarize(result));
        return result;
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "tool_failed";
        record(name, "failed", startedAt, message);
        return { denied: true as const, message: `Tool failed: ${message.slice(0, 120)}` };
      }
    };
  };

  const tools = [
    tool({
      name: "search_knowledge",
      description:
        "Search the business knowledge base for facts, pricing, policies, and product/service information. Always use this before answering factual questions.",
      inputSchema: z.object({
        query: z.string().min(2).max(300).describe("Search query in the customer's language or the business language."),
      }),
      execute: guarded(
        "search_knowledge",
        (result) =>
          Array.isArray(result) ? `${result.length} chunks` : "denied",
        async ({ query }: { query: string }) => {
          const chunks = await gateway.searchKnowledge(query, 5);
          return chunks.map((chunk) => ({
            source: chunk.documentTitle,
            content: chunk.content,
            relevance: chunk.score,
          }));
        },
      ),
    }),
    tool({
      name: "get_contact",
      description:
        "Get the current customer's profile: name, language, tags, and known preferences.",
      inputSchema: z.object({}),
      execute: guarded(
        "get_contact",
        () => "profile",
        async () => gateway.getContact(),
      ),
    }),
    tool({
      name: "get_conversation_context",
      description:
        "Get the current conversation's status, assignment, and summary of earlier messages.",
      inputSchema: z.object({}),
      execute: guarded(
        "get_conversation_context",
        () => "context",
        async () => {
          const context = await gateway.getConversationContext();
          return {
            status: context.status,
            stage: context.stage,
            assignee: context.assigneeName,
            summary: context.summary,
          };
        },
      ),
    }),
    tool({
      name: "get_business_hours",
      description: "Check whether the business is currently within working hours.",
      inputSchema: z.object({}),
      execute: guarded(
        "get_business_hours",
        (result) => (typeof result === "object" ? "hours" : "denied"),
        async () => gateway.getBusinessHours(),
      ),
    }),
    tool({
      name: "list_approved_templates",
      description:
        "List approved message templates that a human can send when the free-form messaging window is closed.",
      inputSchema: z.object({}),
      execute: guarded(
        "list_approved_templates",
        (result) => (Array.isArray(result) ? `${result.length} templates` : "denied"),
        async () => gateway.listApprovedTemplates(),
      ),
    }),
    tool({
      name: "add_label",
      description:
        "Add an existing label to this conversation, e.g. to mark intent or lead quality. Only use labels that make sense from the conversation.",
      inputSchema: z.object({
        label: z.string().min(1).max(80).describe("Exact name of an existing label."),
      }),
      execute: guarded(
        "add_label",
        (result) =>
          typeof result === "object" && result && "message" in result
            ? String((result as { message: unknown }).message)
            : "done",
        async ({ label }: { label: string }) => gateway.addLabel(label),
      ),
    }),
    tool({
      name: "create_internal_note",
      description:
        "Attach an internal note to this conversation for the human team. The customer never sees notes.",
      inputSchema: z.object({
        note: z.string().min(3).max(1000),
      }),
      execute: guarded(
        "create_internal_note",
        () => "note created",
        async ({ note }: { note: string }) => gateway.createInternalNote(note),
      ),
    }),
    tool({
      name: "remember_customer_fact",
      description:
        "Store a durable fact about this customer (e.g. preferred language, allergy, preference). Use sparingly for facts that matter in future conversations.",
      inputSchema: z.object({
        key: z.string().min(2).max(60).describe("snake_case fact key, e.g. 'preferred_language'"),
        value: z.string().min(1).max(300),
      }),
      execute: guarded(
        "remember_customer_fact",
        (result) =>
          typeof result === "object" && result && "message" in result
            ? String((result as { message: unknown }).message)
            : "stored",
        async ({ key, value }: { key: string; value: string }) =>
          gateway.rememberCustomerFact(key, value),
      ),
    }),
    tool({
      name: "handoff_to_human",
      description:
        "Escalate this conversation to a human agent immediately. Use when the customer asks for a human or the topic is beyond your rules.",
      inputSchema: z.object({
        reason: z.string().min(3).max(300).describe("Why a human is needed."),
      }),
      execute: guarded(
        "handoff_to_human",
        () => "handoff requested",
        async ({ reason }: { reason: string }) => {
          handoff = { requested: true, reason };
          await gateway.requestHandoff(reason);
          return { ok: true, message: "A human agent has been notified." };
        },
      ),
    }),
    tool({
      name: "finalize_reply",
      description:
        "REQUIRED final step: submit your reply to the customer together with honest metadata. Call this exactly once, after any other tool use.",
      inputSchema: finalizeReplySchema,
      execute: async (args: FinalizeReplyInput) => {
        finalReply = args;
        journal.push({
          name: "finalize_reply",
          status: "completed",
          durationMs: 0,
          summary: `confidence=${args.confidence}`,
        });
        return { accepted: true };
      },
    }),
  ];

  const allTools: Tool[] = [...tools];
  if (agent.config.webSearchEnabled) {
    // OpenRouter server-side web search: opt-in per agent, results are
    // fenced as untrusted context by the prompt rules.
    allTools.push(serverTool({ type: "web_search_2025_08_26", maxResults: 5 }));
  }

  return {
    tools: allTools,
    getFinalReply: () => finalReply,
    getToolJournal: () => journal,
    handoffRequested: () => handoff,
  };
}
