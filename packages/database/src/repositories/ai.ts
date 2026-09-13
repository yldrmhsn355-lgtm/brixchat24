import type postgres from "postgres";

type DatabaseClient = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

/**
 * Database gateways for the AI agent platform.
 *
 * AiRepository is the thin passthrough used by API routes (the architecture
 * ratchet forbids raw `await sql` in apps/api). AiWorkerRepository holds the
 * transactionally subtle worker-side operations: the debounced run-request
 * claim loop, orchestration context loading, and the outbound send that
 * mirrors the automation send_message executor (24h window check, exactly-
 * once guard keyed on the run id, outbox enqueue in the same transaction).
 */

export class AiRepository {
  constructor(private readonly client: DatabaseClient) {}

  async query<T = Array<Row>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    return (await this.client(strings, ...(values as never[]))) as unknown as T;
  }

  fragment(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.client(strings, ...(values as never[]));
  }

  json(value: unknown) {
    return this.client.json(value as never);
  }

  begin<T>(callback: (transaction: DatabaseClient) => Promise<T>): Promise<T> {
    return this.client.begin(callback as never) as unknown as Promise<T>;
  }
}

export interface AiRunRequestClaim {
  id: string;
  organizationId: string;
  conversationId: string;
  channelId: string | null;
  contactId: string | null;
  agentId: string | null;
  messageIds: string[];
  attemptCount: number;
  maxAttempts: number;
}

export interface AiOrchestrationContext {
  organizationId: string;
  organizationName: string;
  conversationId: string;
  conversationStatus: string;
  conversationStage: string;
  conversationPriority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  serviceWindowExpiresAt: Date | null;
  channelId: string;
  channelName: string;
  channelProvider: string;
  channelPlatform: string;
  channelPhoneNumber: string | null;
  channelConnected: boolean;
  contactId: string;
  contactDisplayName: string;
  contactLanguage: string | null;
  contactCountry: string | null;
  contactPhoneMasked: string;
  contactCustomFields: Record<string, unknown>;
  aiEnabled: boolean;
  aiApiKeyEncrypted: string | null;
  aiDefaultModel: string | null;
  aiFallbackModel: string | null;
  aiDebounceMs: number;
  aiDailyBudgetUsd: number | null;
  aiSensitiveMode: boolean;
  aiExtraPolicy: string;
  aiTakeoverPauseMinutes: number;
  assignmentAgentId: string | null;
  assignmentEnabled: boolean;
  assignmentModeOverride: string | null;
  agentStatus: string | null;
  conversationAiStatus: string | null;
  conversationAiAgentId: string | null;
  conversationAiModeOverride: string | null;
  pausedUntil: Date | null;
  humanTakeoverAt: Date | null;
  consecutiveAiMessages: number;
  agentVersionRow: Row | null;
  labels: string[];
}

const asDate = (value: unknown): Date | null =>
  value ? new Date(String(value)) : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export class AiWorkerRepository {
  constructor(private readonly sql: DatabaseClient) {}

  /**
   * Reclaim requests whose worker died mid-run, then claim the oldest due
   * request for a conversation with no in-flight processing row. Sibling
   * pending requests for the same conversation are merged into the claim so
   * rapid consecutive customer messages produce a single conversational
   * reply instead of one reply per message.
   */
  async claimRunRequest(
    workerId: string,
    staleLockSeconds = 180,
  ): Promise<AiRunRequestClaim | null> {
    await this.sql`
      UPDATE ai_run_requests SET status='retry',locked_at=NULL,locked_by=NULL,
        next_attempt_at=now(),updated_at=now()
      WHERE status='processing'
        AND locked_at IS NOT NULL
        AND locked_at < now() - make_interval(secs => ${staleLockSeconds})
    `;
    const rows = await this.sql<Row[]>`
      UPDATE ai_run_requests SET status='processing',locked_at=now(),
        locked_by=${workerId},attempt_count=attempt_count+1,updated_at=now()
      WHERE id=(
        SELECT request.id FROM ai_run_requests request
        WHERE request.status IN('pending','retry')
          AND request.next_attempt_at <= now()
          AND NOT EXISTS(
            SELECT 1 FROM ai_run_requests processing
            WHERE processing.conversation_id=request.conversation_id
              AND processing.status='processing'
          )
        ORDER BY request.next_attempt_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id,organization_id,conversation_id,channel_id,contact_id,
        agent_id,message_ids,attempt_count,max_attempts
    `;
    const claimed = rows[0];
    if (!claimed) return null;

    const merged = await this.sql<Row[]>`
      UPDATE ai_run_requests SET status='skipped',last_error='merged_into_batch',
        updated_at=now()
      WHERE conversation_id=${String(claimed.conversation_id)}::uuid
        AND organization_id=${String(claimed.organization_id)}::uuid
        AND status='pending' AND id<>${String(claimed.id)}::uuid
      RETURNING message_ids
    `;
    const messageIds = [
      ...asStringArray(claimed.message_ids),
      ...merged.flatMap((row) => asStringArray(row.message_ids)),
    ];
    if (merged.length > 0) {
      await this.sql`
        UPDATE ai_run_requests SET message_ids=${this.sql.json(messageIds as never)},
          updated_at=now()
        WHERE id=${String(claimed.id)}::uuid
      `;
    }
    return {
      id: String(claimed.id),
      organizationId: String(claimed.organization_id),
      conversationId: String(claimed.conversation_id),
      channelId: claimed.channel_id ? String(claimed.channel_id) : null,
      contactId: claimed.contact_id ? String(claimed.contact_id) : null,
      agentId: claimed.agent_id ? String(claimed.agent_id) : null,
      messageIds,
      attemptCount: Number(claimed.attempt_count ?? 1),
      maxAttempts: Number(claimed.max_attempts ?? 3),
    };
  }

  async completeRunRequest(id: string, runId: string | null): Promise<void> {
    await this.sql`
      UPDATE ai_run_requests SET status='completed',
        run_id=${runId ? this.sql`${runId}::uuid` : null},
        locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${id}::uuid
    `;
  }

  async skipRunRequest(id: string, reason: string): Promise<void> {
    await this.sql`
      UPDATE ai_run_requests SET status='skipped',last_error=${reason.slice(0, 300)},
        locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${id}::uuid
    `;
  }

  async failRunRequest(input: {
    id: string;
    error: string;
    retryable: boolean;
    attemptCount: number;
    maxAttempts: number;
  }): Promise<"retry" | "failed"> {
    const willRetry = input.retryable && input.attemptCount < input.maxAttempts;
    const delaySeconds = Math.min(5 * 2 ** (input.attemptCount - 1), 300);
    if (willRetry) {
      await this.sql`
        UPDATE ai_run_requests SET status='retry',
          last_error=${input.error.slice(0, 300)},
          next_attempt_at=now() + make_interval(secs => ${delaySeconds}),
          locked_at=NULL,locked_by=NULL,updated_at=now()
        WHERE id=${input.id}::uuid
      `;
      return "retry";
    }
    await this.sql`
      UPDATE ai_run_requests SET status='failed',
        last_error=${input.error.slice(0, 300)},
        locked_at=NULL,locked_by=NULL,updated_at=now()
      WHERE id=${input.id}::uuid
    `;
    return "failed";
  }

  /** One round trip loading everything eligibility + resolution needs. */
  async loadOrchestrationContext(
    organizationId: string,
    conversationId: string,
  ): Promise<AiOrchestrationContext | null> {
    const rows = await this.sql<Row[]>`
      SELECT
        conversation.id conversation_id,
        conversation.status conversation_status,
        conversation.stage conversation_stage,
        conversation.priority conversation_priority,
        conversation.assignee_id,
        assignee.full_name assignee_name,
        conversation.customer_service_window_expires_at,
        conversation.blocked_at,
        organization.name organization_name,
        channel.id channel_id,
        channel.name channel_name,
        channel.provider channel_provider,
        channel.platform channel_platform,
        channel.phone_number channel_phone,
        channel.status channel_status,
        contact.id contact_id,
        COALESCE(NULLIF(BTRIM(contact.display_name),''),
          NULLIF(BTRIM(concat_ws(' ',contact.first_name,contact.last_name)),''),
          contact.normalized_phone) contact_name,
        contact.language contact_language,
        contact.country contact_country,
        contact.normalized_phone contact_phone,
        contact.custom_fields contact_custom_fields,
        settings.enabled ai_enabled,
        settings.api_key_encrypted,
        settings.default_model,
        settings.fallback_model,
        settings.debounce_ms,
        settings.daily_budget_usd,
        settings.config ai_config,
        assignment.agent_id assignment_agent_id,
        assignment.enabled assignment_enabled,
        assignment.mode_override assignment_mode_override,
        agent.status agent_status,
        conv_ai.status conversation_ai_status,
        conv_ai.agent_id conversation_ai_agent_id,
        conv_ai.mode_override conversation_ai_mode_override,
        conv_ai.paused_until,
        conv_ai.human_takeover_at,
        COALESCE(conv_ai.consecutive_ai_messages,0) consecutive_ai_messages,
        COALESCE((
          SELECT array_agg(label.name)
          FROM conversation_label_assignments assignment_label
          JOIN conversation_labels label
            ON label.id=assignment_label.label_id
           AND label.organization_id=assignment_label.organization_id
          WHERE assignment_label.organization_id=conversation.organization_id
            AND assignment_label.conversation_id=conversation.id
        ),ARRAY[]::text[]) labels
      FROM conversations conversation
      JOIN organizations organization ON organization.id=conversation.organization_id
      JOIN channels channel ON channel.id=conversation.channel_id
      JOIN contacts contact ON contact.id=conversation.contact_id
      LEFT JOIN users assignee ON assignee.id=conversation.assignee_id
      LEFT JOIN ai_settings settings
        ON settings.organization_id=conversation.organization_id
      LEFT JOIN ai_conversation_settings conv_ai
        ON conv_ai.conversation_id=conversation.id
      LEFT JOIN ai_agent_channel_assignments assignment
        ON assignment.organization_id=conversation.organization_id
       AND assignment.channel_id=conversation.channel_id
      LEFT JOIN ai_agents agent
        ON agent.id=COALESCE(conv_ai.agent_id,assignment.agent_id)
      WHERE conversation.id=${conversationId}::uuid
        AND conversation.organization_id=${organizationId}::uuid
    `;
    const row = rows[0];
    if (!row) return null;

    // Resolution priority: conversation override > channel assignment.
    const resolvedAgentId = row.conversation_ai_agent_id ?? row.assignment_agent_id;
    let agentVersionRow: Row | null = null;
    if (resolvedAgentId) {
      const versionRows = await this.sql<Row[]>`
        SELECT version.*,agent.name agent_name,agent.status agent_status
        FROM ai_agents agent
        JOIN ai_agent_versions version ON version.id=agent.published_version_id
        WHERE agent.id=${String(resolvedAgentId)}::uuid
          AND agent.organization_id=${organizationId}::uuid
      `;
      agentVersionRow = versionRows[0] ?? null;
    }

    const aiConfig =
      row.ai_config && typeof row.ai_config === "object"
        ? (row.ai_config as Record<string, unknown>)
        : {};
    const phone = String(row.contact_phone ?? "");
    return {
      organizationId,
      organizationName: String(row.organization_name ?? ""),
      conversationId: String(row.conversation_id),
      conversationStatus: String(row.conversation_status ?? "open"),
      conversationStage: String(row.conversation_stage ?? ""),
      conversationPriority: String(row.conversation_priority ?? "normal"),
      assigneeId: row.assignee_id ? String(row.assignee_id) : null,
      assigneeName: row.assignee_name ? String(row.assignee_name) : null,
      serviceWindowExpiresAt: asDate(row.customer_service_window_expires_at),
      channelId: String(row.channel_id),
      channelName: String(row.channel_name ?? ""),
      channelProvider: String(row.channel_provider ?? ""),
      channelPlatform: String(row.channel_platform ?? "whatsapp"),
      channelPhoneNumber: row.channel_phone ? String(row.channel_phone) : null,
      channelConnected: row.channel_status === "connected",
      contactId: String(row.contact_id),
      contactDisplayName: String(row.contact_name ?? ""),
      contactLanguage: row.contact_language ? String(row.contact_language) : null,
      contactCountry: row.contact_country ? String(row.contact_country) : null,
      contactPhoneMasked: phone.length > 4 ? `****${phone.slice(-4)}` : "****",
      contactCustomFields:
        row.contact_custom_fields && typeof row.contact_custom_fields === "object"
          ? (row.contact_custom_fields as Record<string, unknown>)
          : {},
      aiEnabled: row.ai_enabled === true,
      aiApiKeyEncrypted: row.api_key_encrypted ? String(row.api_key_encrypted) : null,
      aiDefaultModel: row.default_model ? String(row.default_model) : null,
      aiFallbackModel: row.fallback_model ? String(row.fallback_model) : null,
      aiDebounceMs: Number(row.debounce_ms ?? 3000),
      aiDailyBudgetUsd:
        row.daily_budget_usd === null || row.daily_budget_usd === undefined
          ? null
          : Number(row.daily_budget_usd),
      aiSensitiveMode: aiConfig.sensitiveBusinessMode === true,
      aiExtraPolicy:
        typeof aiConfig.extraPolicy === "string" ? aiConfig.extraPolicy : "",
      aiTakeoverPauseMinutes: Number.isFinite(Number(aiConfig.takeoverPauseMinutes))
        ? Math.max(Number(aiConfig.takeoverPauseMinutes), 0)
        : 60,
      assignmentAgentId: row.assignment_agent_id
        ? String(row.assignment_agent_id)
        : null,
      assignmentEnabled: row.assignment_enabled === true,
      assignmentModeOverride: row.assignment_mode_override
        ? String(row.assignment_mode_override)
        : null,
      agentStatus: row.agent_status ? String(row.agent_status) : null,
      conversationAiStatus: row.conversation_ai_status
        ? String(row.conversation_ai_status)
        : null,
      conversationAiAgentId: row.conversation_ai_agent_id
        ? String(row.conversation_ai_agent_id)
        : null,
      conversationAiModeOverride: row.conversation_ai_mode_override
        ? String(row.conversation_ai_mode_override)
        : null,
      pausedUntil: asDate(row.paused_until),
      humanTakeoverAt: asDate(row.human_takeover_at),
      consecutiveAiMessages: Number(row.consecutive_ai_messages ?? 0),
      agentVersionRow,
      labels: asStringArray(row.labels),
    };
  }

  async messagesByIds(organizationId: string, ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    return this.sql<Row[]>`
      SELECT id,direction,type,body,metadata,sent_at
      FROM messages
      WHERE organization_id=${organizationId}::uuid
        AND id=ANY(${this.sql.array(ids)}::uuid[])
      ORDER BY sent_at
    `;
  }

  async recentMessages(
    organizationId: string,
    conversationId: string,
    limit: number,
  ): Promise<Row[]> {
    const rows = await this.sql<Row[]>`
      SELECT id,direction,type,body,metadata,sent_at
      FROM messages
      WHERE organization_id=${organizationId}::uuid
        AND conversation_id=${conversationId}::uuid
      ORDER BY sent_at DESC
      LIMIT ${limit}
    `;
    return rows.reverse();
  }

  async countConversationMessages(
    organizationId: string,
    conversationId: string,
  ): Promise<number> {
    const rows = await this.sql<Row[]>`
      SELECT count(*)::int total FROM messages
      WHERE organization_id=${organizationId}::uuid
        AND conversation_id=${conversationId}::uuid
    `;
    return Number(rows[0]?.total ?? 0);
  }

  async latestSummary(
    organizationId: string,
    conversationId: string,
  ): Promise<Row | null> {
    const rows = await this.sql<Row[]>`
      SELECT summary,facts,covered_message_count,last_message_at
      FROM ai_conversation_summaries
      WHERE organization_id=${organizationId}::uuid
        AND conversation_id=${conversationId}::uuid
      ORDER BY created_at DESC LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async insertSummary(input: {
    organizationId: string;
    conversationId: string;
    summary: string;
    facts: Record<string, unknown>;
    coveredMessageCount: number;
    lastMessageId: string | null;
    model: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO ai_conversation_summaries(
        organization_id,conversation_id,summary,facts,covered_message_count,
        last_message_id,model
      ) VALUES(
        ${input.organizationId}::uuid,${input.conversationId}::uuid,
        ${input.summary},${this.sql.json(input.facts as never)},
        ${input.coveredMessageCount},
        ${input.lastMessageId ? this.sql`${input.lastMessageId}::uuid` : null},
        ${input.model}
      )
    `;
  }

  async getCustomerMemory(
    organizationId: string,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.sql<Row[]>`
      SELECT memory FROM ai_customer_memory
      WHERE organization_id=${organizationId}::uuid AND contact_id=${contactId}::uuid
    `;
    const memory = rows[0]?.memory;
    return memory && typeof memory === "object"
      ? (memory as Record<string, unknown>)
      : {};
  }

  async upsertCustomerMemoryFact(input: {
    organizationId: string;
    contactId: string;
    key: string;
    value: string;
    runId: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO ai_customer_memory(organization_id,contact_id,memory,updated_by_run_id)
      VALUES(
        ${input.organizationId}::uuid,${input.contactId}::uuid,
        jsonb_build_object(${input.key}::text,${input.value}::text),
        ${input.runId}::uuid
      )
      ON CONFLICT(organization_id,contact_id) DO UPDATE SET
        memory=ai_customer_memory.memory || jsonb_build_object(${input.key}::text,${input.value}::text),
        updated_by_run_id=${input.runId}::uuid,
        updated_at=now()
    `;
  }

  async createRun(input: {
    organizationId: string;
    agentId: string | null;
    agentVersionId: string | null;
    agentVersion: number | null;
    conversationId: string | null;
    channelId: string | null;
    contactId: string | null;
    triggerSource: string;
    triggerMessageId: string | null;
    triggerMessageIds: string[];
    requestedBy: string | null;
    idempotencyKey: string;
    correlationId: string;
    mode: string;
    model: string | null;
  }): Promise<{ id: string; created: boolean }> {
    const rows = await this.sql<Row[]>`
      INSERT INTO ai_runs(
        organization_id,agent_id,agent_version_id,agent_version,conversation_id,
        channel_id,contact_id,trigger_source,trigger_message_id,
        trigger_message_ids,requested_by,idempotency_key,correlation_id,mode,model
      ) VALUES(
        ${input.organizationId}::uuid,
        ${input.agentId ? this.sql`${input.agentId}::uuid` : null},
        ${input.agentVersionId ? this.sql`${input.agentVersionId}::uuid` : null},
        ${input.agentVersion},
        ${input.conversationId ? this.sql`${input.conversationId}::uuid` : null},
        ${input.channelId ? this.sql`${input.channelId}::uuid` : null},
        ${input.contactId ? this.sql`${input.contactId}::uuid` : null},
        ${input.triggerSource},
        ${input.triggerMessageId ? this.sql`${input.triggerMessageId}::uuid` : null},
        ${this.sql.json(input.triggerMessageIds as never)},
        ${input.requestedBy ? this.sql`${input.requestedBy}::uuid` : null},
        ${input.idempotencyKey},${input.correlationId}::uuid,${input.mode},
        ${input.model}
      )
      ON CONFLICT(organization_id,idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (rows[0]) return { id: String(rows[0].id), created: true };
    const existing = await this.sql<Row[]>`
      SELECT id FROM ai_runs
      WHERE organization_id=${input.organizationId}::uuid
        AND idempotency_key=${input.idempotencyKey}
    `;
    return { id: String(existing[0]?.id ?? ""), created: false };
  }

  async finishRun(input: {
    runId: string;
    organizationId: string;
    status: string;
    decision: string | null;
    modelUsed: string | null;
    fallbackUsed: boolean;
    responseText: string | null;
    finalText: string | null;
    responseMeta: Record<string, unknown>;
    confidence: number | null;
    requiresHuman: boolean;
    handoffReason: string | null;
    knowledgeRefs: unknown[];
    toolCalls: unknown[];
    promptMeta: Record<string, unknown>;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
    latencyMs: number | null;
    steps: number;
    errorCode: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    await this.sql`
      UPDATE ai_runs SET
        status=${input.status},
        decision=${input.decision},
        model_used=${input.modelUsed},
        fallback_used=${input.fallbackUsed},
        response_text=${input.responseText},
        final_text=${input.finalText},
        response_meta=${this.sql.json(input.responseMeta as never)},
        confidence=${input.confidence},
        requires_human=${input.requiresHuman},
        handoff_reason=${input.handoffReason},
        knowledge_refs=${this.sql.json(input.knowledgeRefs as never)},
        tool_calls=${this.sql.json(input.toolCalls as never)},
        prompt_meta=${this.sql.json(input.promptMeta as never)},
        input_tokens=${input.inputTokens},
        output_tokens=${input.outputTokens},
        total_cost_usd=${input.totalCostUsd},
        latency_ms=${input.latencyMs},
        steps=${input.steps},
        error_code=${input.errorCode},
        error_message=${input.errorMessage},
        completed_at=now()
      WHERE id=${input.runId}::uuid
        AND organization_id=${input.organizationId}::uuid
    `;
  }

  async recordUsage(input: {
    organizationId: string;
    agentId: string;
    decision: string | null;
    failed: boolean;
    inputTokens: number;
    outputTokens: number;
    totalCostUsd: number;
  }): Promise<void> {
    const suggested = input.decision === "suggested" ? 1 : 0;
    const drafts = input.decision === "draft_created" ? 1 : 0;
    const autoSent = input.decision === "auto_sent" ? 1 : 0;
    const handoffs = input.decision === "handoff" ? 1 : 0;
    const failures = input.failed ? 1 : 0;
    await this.sql`
      INSERT INTO ai_usage_daily(
        organization_id,agent_id,day,runs,suggested,drafts,auto_sent,handoffs,
        failures,input_tokens,output_tokens,total_cost_usd
      ) VALUES(
        ${input.organizationId}::uuid,${input.agentId}::uuid,CURRENT_DATE,1,
        ${suggested},${drafts},${autoSent},${handoffs},${failures},
        ${input.inputTokens},${input.outputTokens},${input.totalCostUsd}
      )
      ON CONFLICT(organization_id,agent_id,day) DO UPDATE SET
        runs=ai_usage_daily.runs+1,
        suggested=ai_usage_daily.suggested+${suggested},
        drafts=ai_usage_daily.drafts+${drafts},
        auto_sent=ai_usage_daily.auto_sent+${autoSent},
        handoffs=ai_usage_daily.handoffs+${handoffs},
        failures=ai_usage_daily.failures+${failures},
        input_tokens=ai_usage_daily.input_tokens+${input.inputTokens},
        output_tokens=ai_usage_daily.output_tokens+${input.outputTokens},
        total_cost_usd=ai_usage_daily.total_cost_usd+${input.totalCostUsd},
        updated_at=now()
    `;
  }

  async todaySpend(organizationId: string): Promise<number> {
    const rows = await this.sql<Row[]>`
      SELECT COALESCE(sum(total_cost_usd),0) spend FROM ai_usage_daily
      WHERE organization_id=${organizationId}::uuid AND day=CURRENT_DATE
    `;
    return Number(rows[0]?.spend ?? 0);
  }

  async agentKnowledgeBaseIds(
    organizationId: string,
    agentId: string,
    channelId: string,
  ): Promise<string[]> {
    const rows = await this.sql<Row[]>`
      SELECT DISTINCT kb.id
      FROM ai_knowledge_bases kb
      LEFT JOIN ai_agent_knowledge link
        ON link.knowledge_base_id=kb.id AND link.agent_id=${agentId}::uuid
      WHERE kb.organization_id=${organizationId}::uuid
        AND kb.status='active'
        AND (
          link.id IS NOT NULL
          OR (kb.scope='channel' AND kb.channel_id=${channelId}::uuid)
        )
    `;
    return rows.map((row) => String(row.id));
  }

  /**
   * Lexical candidate generation via the GIN FTS index with an ILIKE
   * fallback for very short queries. Semantic re-ranking happens in the AI
   * package over the returned embeddings.
   */
  async knowledgeCandidates(input: {
    organizationId: string;
    knowledgeBaseIds: string[];
    query: string;
    limit: number;
  }): Promise<Row[]> {
    if (input.knowledgeBaseIds.length === 0) return [];
    const kbIds = this.sql.array(input.knowledgeBaseIds);
    const rows = await this.sql<Row[]>`
      SELECT chunk.id chunk_id,chunk.document_id,chunk.knowledge_base_id,
        chunk.content,chunk.embedding,document.title document_title,
        ts_rank(to_tsvector('simple',coalesce(chunk.content,'')),
          plainto_tsquery('simple',${input.query})) lexical_score
      FROM ai_knowledge_chunks chunk
      JOIN ai_knowledge_documents document ON document.id=chunk.document_id
      WHERE chunk.organization_id=${input.organizationId}::uuid
        AND chunk.knowledge_base_id=ANY(${kbIds}::uuid[])
        AND document.status='ready'
        AND document.version=chunk.document_version
        AND to_tsvector('simple',coalesce(chunk.content,''))
          @@ plainto_tsquery('simple',${input.query})
      ORDER BY lexical_score DESC
      LIMIT ${input.limit}
    `;
    if (rows.length > 0) return rows;
    return this.sql<Row[]>`
      SELECT chunk.id chunk_id,chunk.document_id,chunk.knowledge_base_id,
        chunk.content,chunk.embedding,document.title document_title,
        0.1 lexical_score
      FROM ai_knowledge_chunks chunk
      JOIN ai_knowledge_documents document ON document.id=chunk.document_id
      WHERE chunk.organization_id=${input.organizationId}::uuid
        AND chunk.knowledge_base_id=ANY(${kbIds}::uuid[])
        AND document.status='ready'
        AND document.version=chunk.document_version
        AND chunk.content ILIKE ${"%" + input.query.slice(0, 60) + "%"}
      LIMIT ${input.limit}
    `;
  }

  async listApprovedTemplates(
    organizationId: string,
    channelId: string,
  ): Promise<Row[]> {
    return this.sql<Row[]>`
      SELECT template.name,COALESCE(template.description,'') description
      FROM message_templates template
      WHERE template.organization_id=${organizationId}::uuid
        AND template.status='approved'
        AND template.deleted_at IS NULL
        AND EXISTS(
          SELECT 1 FROM message_template_channels tc
          WHERE tc.template_id=template.id AND tc.channel_id=${channelId}::uuid
        )
      LIMIT 20
    `;
  }

  async addLabelToConversation(input: {
    organizationId: string;
    conversationId: string;
    labelName: string;
  }): Promise<{ ok: boolean; message: string }> {
    const labels = await this.sql<Row[]>`
      SELECT id FROM conversation_labels
      WHERE organization_id=${input.organizationId}::uuid
        AND lower(name)=lower(${input.labelName})
        AND archived_at IS NULL AND deleted_at IS NULL
      LIMIT 1
    `;
    const label = labels[0];
    if (!label) return { ok: false, message: "label_not_found" };
    await this.sql`
      INSERT INTO conversation_label_assignments(
        organization_id,conversation_id,label_id,source
      ) VALUES(
        ${input.organizationId}::uuid,${input.conversationId}::uuid,
        ${String(label.id)}::uuid,'ai'
      )
      ON CONFLICT DO NOTHING
    `;
    return { ok: true, message: "label_added" };
  }

  /**
   * Internal note authored on behalf of the AI. conversation_notes.author_id
   * is NOT NULL, so the note is attributed to the conversation assignee when
   * set, otherwise the organization owner; the body carries the AI marker.
   */
  async createInternalNote(input: {
    organizationId: string;
    conversationId: string;
    body: string;
  }): Promise<{ ok: boolean }> {
    const result = await this.sql<Row[]>`
      INSERT INTO conversation_notes(organization_id,conversation_id,author_id,body)
      SELECT ${input.organizationId}::uuid,${input.conversationId}::uuid,
        COALESCE(
          (SELECT assignee_id FROM conversations
            WHERE id=${input.conversationId}::uuid
              AND organization_id=${input.organizationId}::uuid),
          (SELECT user_id FROM organization_members
            WHERE organization_id=${input.organizationId}::uuid AND role='owner'
            ORDER BY created_at LIMIT 1)
        ),
        ${"🤖 AI: " + input.body}
      WHERE COALESCE(
          (SELECT assignee_id FROM conversations
            WHERE id=${input.conversationId}::uuid
              AND organization_id=${input.organizationId}::uuid),
          (SELECT user_id FROM organization_members
            WHERE organization_id=${input.organizationId}::uuid AND role='owner'
            ORDER BY created_at LIMIT 1)
        ) IS NOT NULL
      RETURNING id
    `;
    return { ok: result.length > 0 };
  }

  async upsertConversationAiState(input: {
    organizationId: string;
    conversationId: string;
    status?: string;
    pausedUntil?: Date | null;
    pausedReason?: string | null;
    pausedBy?: string | null;
    humanTakeover?: boolean;
    agentId?: string | null;
    resetConsecutive?: boolean;
    incrementConsecutive?: boolean;
  }): Promise<void> {
    await this.sql`
      INSERT INTO ai_conversation_settings(organization_id,conversation_id,status)
      VALUES(${input.organizationId}::uuid,${input.conversationId}::uuid,'active')
      ON CONFLICT(conversation_id) DO NOTHING
    `;
    if (input.status !== undefined) {
      await this.sql`
        UPDATE ai_conversation_settings SET status=${input.status},
          paused_until=${input.pausedUntil ?? null},
          paused_reason=${input.pausedReason ?? null},
          paused_by=${input.pausedBy ? this.sql`${input.pausedBy}::uuid` : null},
          updated_at=now()
        WHERE conversation_id=${input.conversationId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    }
    if (input.humanTakeover) {
      await this.sql`
        UPDATE ai_conversation_settings SET human_takeover_at=now(),updated_at=now()
        WHERE conversation_id=${input.conversationId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    }
    if (input.agentId !== undefined) {
      await this.sql`
        UPDATE ai_conversation_settings SET
          agent_id=${input.agentId ? this.sql`${input.agentId}::uuid` : null},
          updated_at=now()
        WHERE conversation_id=${input.conversationId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    }
    if (input.resetConsecutive) {
      await this.sql`
        UPDATE ai_conversation_settings SET consecutive_ai_messages=0,updated_at=now()
        WHERE conversation_id=${input.conversationId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    }
    if (input.incrementConsecutive) {
      await this.sql`
        UPDATE ai_conversation_settings SET
          consecutive_ai_messages=consecutive_ai_messages+1,
          last_ai_message_at=now(),updated_at=now()
        WHERE conversation_id=${input.conversationId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    }
  }

  /**
   * Transactional AI send mirroring the automation send_message executor:
   * conversation lock, connected-channel check, 24h window check, exactly-
   * once guard keyed on the run id, outbox enqueue in the same transaction.
   */
  async sendAiMessage(input: {
    organizationId: string;
    conversationId: string;
    runId: string;
    /**
     * Exactly-once key across retries: the run-request id (a retried attempt
     * gets a fresh runId but the same requestId, so a crash after send can
     * never produce a second customer message).
     */
    requestId: string;
    text: string;
  }): Promise<{ messageId?: string; blocked?: string; duplicate?: boolean }> {
    return this.sql.begin(async (tx) => {
      const context = (
        await tx<Row[]>`
          SELECT conversation.channel_id,conversation.contact_id,
            conversation.customer_service_window_expires_at,
            channel.status channel_status
          FROM conversations conversation
          JOIN channels channel ON channel.id=conversation.channel_id
          WHERE conversation.id=${input.conversationId}::uuid
            AND conversation.organization_id=${input.organizationId}::uuid
            AND channel.deleted_at IS NULL
          FOR UPDATE OF conversation
        `
      )[0];
      if (!context || context.channel_status !== "connected")
        return { blocked: "ai_channel_not_connected" };
      const windowExpiresAt = context.customer_service_window_expires_at
        ? new Date(String(context.customer_service_window_expires_at))
        : null;
      if (!windowExpiresAt || windowExpiresAt <= new Date())
        return { blocked: "ai_message_window_closed" };
      const messages = await tx<Row[]>`
        INSERT INTO messages(
          organization_id,conversation_id,channel_id,contact_id,
          client_message_id,direction,type,status,body,metadata
        )
        SELECT ${input.organizationId}::uuid,${input.conversationId}::uuid,
          ${String(context.channel_id)}::uuid,${String(context.contact_id)}::uuid,
          gen_random_uuid(),'outbound','text','pending',${input.text.trim()},
          ${tx.json({
            origin: "ai_agent",
            aiRunId: input.runId,
            aiRequestId: input.requestId,
          } as never)}
        WHERE NOT EXISTS(
          SELECT 1 FROM messages
          WHERE organization_id=${input.organizationId}::uuid
            AND metadata->>'aiRequestId'=${input.requestId}
        )
        RETURNING id
      `;
      const message = messages[0];
      if (!message) return { duplicate: true };
      await tx`
        INSERT INTO outbox_jobs(
          organization_id,aggregate_type,aggregate_id,job_type,payload
        ) VALUES(
          ${input.organizationId}::uuid,'message',
          ${String(message.id)}::uuid,'message.send',
          ${tx.json({ traceId: crypto.randomUUID() } as never)}
        )
      `;
      return { messageId: String(message.id) };
    }) as Promise<{ messageId?: string; blocked?: string; duplicate?: boolean }>;
  }

  /**
   * Image attachments for vision-enabled runs. Only scanned-safe, stored
   * images are returned; the caller streams bytes from object storage and
   * never persists the data URL.
   */
  async imageAttachmentsForMessages(
    organizationId: string,
    messageIds: string[],
  ): Promise<
    Array<{ messageId: string; storageKey: string; mimeType: string; size: number }>
  > {
    if (messageIds.length === 0) return [];
    const rows = await this.sql<Row[]>`
      SELECT message_id,storage_key,
        COALESCE(stored_mime_type,provider_mime_type,'image/jpeg') mime_type,
        COALESCE(stored_size,provider_file_size,0) size
      FROM message_attachments
      WHERE organization_id=${organizationId}::uuid
        AND message_id=ANY(${this.sql.array(messageIds)}::uuid[])
        AND attachment_type='image'
        AND storage_key IS NOT NULL
        AND deleted_at IS NULL
        AND scan_status NOT IN('infected','failed')
      ORDER BY created_at
    `;
    return rows.map((row) => ({
      messageId: String(row.message_id),
      storageKey: String(row.storage_key),
      mimeType: String(row.mime_type),
      size: Number(row.size ?? 0),
    }));
  }

  /** Claim one pending knowledge document for async indexing. */
  async claimKnowledgeDocument(): Promise<Row | null> {
    const rows = await this.sql<Row[]>`
      UPDATE ai_knowledge_documents SET status='indexing',updated_at=now()
      WHERE id=(
        SELECT id FROM ai_knowledge_documents
        WHERE status='pending'
        ORDER BY updated_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id,organization_id,knowledge_base_id,title,content,version
    `;
    return rows[0] ?? null;
  }

  async storeDocumentChunks(input: {
    organizationId: string;
    documentId: string;
    knowledgeBaseId: string;
    documentVersion: number;
    chunks: Array<{
      index: number;
      content: string;
      tokenCount: number;
      embedding: number[] | null;
      embeddingModel: string | null;
    }>;
  }): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Replace this version's chunks, then retire older versions' rows.
      await tx`
        DELETE FROM ai_knowledge_chunks
        WHERE document_id=${input.documentId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
      for (const chunk of input.chunks) {
        await tx`
          INSERT INTO ai_knowledge_chunks(
            organization_id,document_id,knowledge_base_id,chunk_index,
            document_version,content,token_count,embedding,embedding_model
          ) VALUES(
            ${input.organizationId}::uuid,${input.documentId}::uuid,
            ${input.knowledgeBaseId}::uuid,${chunk.index},
            ${input.documentVersion},${chunk.content},${chunk.tokenCount},
            ${chunk.embedding ? tx.json(chunk.embedding as never) : null},
            ${chunk.embeddingModel}
          )
        `;
      }
      await tx`
        UPDATE ai_knowledge_documents SET status='ready',
          chunk_count=${input.chunks.length},indexed_at=now(),
          error_message=NULL,updated_at=now()
        WHERE id=${input.documentId}::uuid
          AND organization_id=${input.organizationId}::uuid
      `;
    });
  }

  async failKnowledgeDocument(
    organizationId: string,
    documentId: string,
    error: string,
  ): Promise<void> {
    await this.sql`
      UPDATE ai_knowledge_documents SET status='failed',
        error_message=${error.slice(0, 300)},updated_at=now()
      WHERE id=${documentId}::uuid AND organization_id=${organizationId}::uuid
    `;
  }
}
