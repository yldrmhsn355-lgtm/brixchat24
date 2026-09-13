import type postgres from "postgres";
export type DatabaseClient = ReturnType<typeof postgres>;

/**
 * Database gateway for the quick-reply bounded context.
 *
 * New API routes use this gateway instead of depending on the raw database
 * client. Query-specific methods can be extracted incrementally without
 * allowing the API package to grow its direct-client boundary.
 */
export class QuickReplyRepository {
  constructor(private readonly client: DatabaseClient) {}

  async query<T = Array<Record<string, unknown>>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    return (await this.client(strings, ...(values as never[]))) as unknown as T;
  }

  begin<T>(callback: (transaction: DatabaseClient) => Promise<T>): Promise<T> {
    return this.client.begin(callback as never) as unknown as Promise<T>;
  }
}

/**
 * Database gateway for the label operations bounded context.
 *
 * Label routes depend on this repository instead of importing the raw client.
 * Query-specific methods can be extracted without expanding the API boundary.
 */
export class LabelOperationsRepository {
  constructor(private readonly client: DatabaseClient) {}

  async query<T = Array<Record<string, unknown>>>(
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
export interface ConversationListInput {
  organizationId: string;
  userId: string;
  role: string;
  id?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  status?: string | undefined;
  assignee?: string | undefined;
  channelId?: string | undefined;
  labelId?: string | undefined;
  labelIdsAny?: string[] | undefined;
  labelIdsAll?: string[] | undefined;
  labelIdsNot?: string[] | undefined;
  unlabeled?: boolean | undefined;
  labelCategoryId?: string | undefined;
  labeledAfter?: string | undefined;
  labelSource?: string | undefined;
  whatsappOwnerUserId?: string | undefined;
  search?: string | undefined;
  unreadOnly?: boolean | undefined;
  excludeArchived?: boolean | undefined;
  scope?: "all" | "assigned_to_me" | "unassigned" | undefined;
}
export interface ConversationCountInput {
  organizationId: string;
  userId: string;
  role: string;
  channelId?: string | undefined;
  search?: string | undefined;
}
export interface ConversationOwnedChannelAccessInput {
  organizationId: string;
  userId: string;
  conversationIds: string[];
}
export interface StartOutboundConversationInput {
  organizationId: string;
  userId: string;
  role: string;
  channelId: string;
  normalizedPhone: string;
  displayName?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}
export type StartOutboundConversationResult =
  | { kind: "ok"; conversationId: string; created: boolean }
  | { kind: "channel_unavailable" };
export interface ConversationAssigneeDto {
  id: string;
  fullName: string;
  email: string;
  role: string;
}
export interface ConversationDto {
  id: string;
  organizationId: string;
  contactId: string;
  contactName: string;
  phone: string;
  isGroup: boolean;
  groupParticipants: ConversationGroupParticipantDto[];
  avatar: string;
  profilePictureUrl: string | null;
  preview: string;
  lastMessageAt: string;
  unreadCount: number;
  assigneeId: string | null;
  assigneeName: string | null;
  channelName: string;
  whatsappOwnerName: string | null;
  whatsappPhone: string | null;
  channelId: string;
  stage: string;
  priority: string;
  status: string;
  direction: string;
  lastProviderStatus: string;
  customerServiceWindowExpiresAt: string | null;
  tags: string[];
  labels: Array<{
    id: string;
    name: string;
    color: string;
    icon: string | null;
  }>;
}
export interface ConversationGroupParticipantDto {
  jid: string;
  lid: string | null;
  phoneNumber: string | null;
  name: string | null;
  isAdmin: boolean;
}
export interface LatestInboundProviderMessage {
  [key: string]: unknown;
  provider: string;
  phone_number_id: string | null;
  credentials_encrypted: string | null;
  provider_message_id: string | null;
}
export interface MessageDto {
  id: string;
  conversationId: string;
  clientMessageId: string | null;
  providerMessageId: string | null;
  body: string;
  type: string;
  direction: string;
  status: string;
  sentAt: string;
  senderName: string;
  metadata: Record<string, unknown>;
  attachments: Array<Record<string, unknown>>;
  errorCode: string | null;
  errorMessage: string | null;
}
const encodeCursor = (date: string, id: string) =>
  Buffer.from(JSON.stringify({ date, id })).toString("base64url");
function decodeCursor(value?: string): { date: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as { date?: unknown; id?: unknown };
    return typeof parsed.date === "string" && typeof parsed.id === "string"
      ? { date: parsed.date, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}
export class ConversationRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async startOutbound(
    input: StartOutboundConversationInput,
  ): Promise<StartOutboundConversationResult> {
    return this.sql.begin(async (tx) => {
      const restricted = ["agent", "team_lead"].includes(input.role);
      const channel = await tx<Array<{ id: string }>>`
        SELECT channel.id
        FROM channels channel
        WHERE channel.id=${input.channelId}::uuid
          AND channel.organization_id=${input.organizationId}::uuid
          AND channel.deleted_at IS NULL
          AND channel.status='connected'
          AND COALESCE(channel.connection_status,'ACTIVE')='ACTIVE'
          AND COALESCE(channel.platform,'whatsapp')='whatsapp'
          AND (
            ${!restricted}
            OR EXISTS (
              SELECT 1
              FROM channel_user_ownership ownership
              WHERE ownership.organization_id=channel.organization_id
                AND ownership.channel_id=channel.id
                AND ownership.user_id=${input.userId}::uuid
            )
          )
        FOR UPDATE`;
      if (!channel[0]) return { kind: "channel_unavailable" } as const;

      const displayName = input.displayName?.trim() || input.normalizedPhone;
      const firstName = input.displayName?.trim().split(/\s+/)[0] || null;
      const contacts = await tx<Array<{ id: string }>>`
        INSERT INTO contacts(
          organization_id,first_name,display_name,normalized_phone
        )
        VALUES(
          ${input.organizationId}::uuid,${firstName},${displayName},${input.normalizedPhone}
        )
        ON CONFLICT(organization_id,normalized_phone) DO UPDATE SET
          first_name=CASE
            WHEN ${input.displayName ?? null}::text IS NULL THEN contacts.first_name
            ELSE EXCLUDED.first_name
          END,
          display_name=CASE
            WHEN ${input.displayName ?? null}::text IS NULL THEN contacts.display_name
            ELSE EXCLUDED.display_name
          END,
          updated_at=now()
        RETURNING id`;
      const contactId = contacts[0]!.id;
      const active = await tx<Array<{ id: string }>>`
        SELECT id
        FROM conversations
        WHERE organization_id=${input.organizationId}::uuid
          AND channel_id=${input.channelId}::uuid
          AND contact_id=${contactId}::uuid
          AND status IN ('open','waiting')
        ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,created_at DESC
        LIMIT 1
        FOR UPDATE`;
      if (active[0])
        return {
          kind: "ok",
          conversationId: active[0].id,
          created: false,
        } as const;

      const created = await tx<Array<{ id: string }>>`
        INSERT INTO conversations(
          organization_id,channel_id,contact_id,status,stage,priority,
          unread_count,customer_service_window_expires_at
        )
        VALUES(
          ${input.organizationId}::uuid,${input.channelId}::uuid,${contactId}::uuid,
          'open','Yeni Lead','normal',0,NULL
        )
        RETURNING id`;
      await tx`
        INSERT INTO audit_logs(
          organization_id,actor_id,action,entity_type,entity_id,metadata,
          ip_address,user_agent
        )
        VALUES(
          ${input.organizationId}::uuid,${input.userId}::uuid,
          'conversation.started','conversation',${created[0]!.id}::uuid,
          ${tx.json({ channelId: input.channelId } as never)},
          ${input.ipAddress ?? null}::inet,${input.userAgent ?? null}
        )`;
      return {
        kind: "ok",
        conversationId: created[0]!.id,
        created: true,
      } as const;
    });
  }
  async listAssignees(
    organizationId: string,
  ): Promise<ConversationAssigneeDto[]> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT u.id,u.full_name,u.email,om.role
      FROM organization_members om
      JOIN users u ON u.id=om.user_id
      WHERE om.organization_id=${organizationId}::uuid
        AND u.is_active=true
        AND u.suspended_at IS NULL
        AND om.role IN ('owner','admin','team_lead','agent')
      ORDER BY u.full_name,u.id
    `;
    return rows.map((row) => ({
      id: String(row.id),
      fullName: String(row.full_name),
      email: String(row.email),
      role: String(row.role),
    }));
  }
  async list(
    input: ConversationListInput,
  ): Promise<{ data: ConversationDto[]; nextCursor: string | null }> {
    const cursor = decodeCursor(input.cursor);
    const rows = await this.sql<Array<Record<string, unknown>>>`
SELECT c.id,c.organization_id,c.contact_id,COALESCE(ct.display_name,concat_ws(' ',ct.first_name,ct.last_name)) contact_name,ct.normalized_phone phone,ct.custom_fields,ct.profile_picture_url,ch.name channel_name,ch.phone_number whatsapp_phone,(SELECT uo.full_name FROM channel_user_ownership ou JOIN users uo ON uo.id=ou.user_id WHERE ou.channel_id=ch.id AND ou.is_primary LIMIT 1) whatsapp_owner_name,ch.id channel_id,c.assignee_id,u.full_name assignee_name,c.stage,c.priority,c.status,c.unread_count,c.last_message_at,c.customer_service_window_expires_at,COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM conversation_label_assignments cla JOIN conversation_labels l ON l.id=cla.label_id AND l.organization_id=cla.organization_id WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id),ARRAY[]::text[]) tags,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color,'icon',l.icon) ORDER BY l.sort_order,l.name) FROM conversation_label_assignments cla JOIN conversation_labels l ON l.id=cla.label_id AND l.organization_id=cla.organization_id WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id), '[]'::jsonb) label_objects,COALESCE(m.body,'') preview,COALESCE(m.direction::text,'inbound') direction,COALESCE(m.status::text,'pending') last_provider_status
FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id LEFT JOIN users u ON u.id=c.assignee_id LEFT JOIN messages m ON m.id=c.last_message_id AND m.organization_id=c.organization_id
WHERE c.organization_id=${input.organizationId}::uuid AND NOT EXISTS (SELECT 1 FROM conversation_operation_history superseded WHERE superseded.organization_id=c.organization_id AND superseded.conversation_id=c.id AND superseded.operation='conversation.canonicalized') AND (${input.id ?? null}::text IS NULL OR c.id::text=${input.id ?? null}) AND (${input.status ?? null}::text IS NULL OR c.status::text=${input.status ?? null}) AND (${input.excludeArchived ?? false}=false OR c.status<>'archived') AND (c.status<>'archived' OR NOT EXISTS (SELECT 1 FROM conversations active WHERE active.organization_id=c.organization_id AND active.channel_id=c.channel_id AND active.contact_id=c.contact_id AND active.id<>c.id AND active.status IN ('open','waiting'))) AND (${input.assignee ?? null}::text IS NULL OR c.assignee_id::text=${input.assignee ?? null}) AND (${input.channelId ?? null}::text IS NULL OR c.channel_id::text=${input.channelId ?? null}) AND (${input.labelId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.label_id=${input.labelId ?? null}::uuid)) AND (${input.labelIdsAny ?? []}::uuid[]='{}'::uuid[] OR EXISTS(SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.label_id=ANY(${input.labelIdsAny ?? []}::uuid[]))) AND (${input.labelIdsAll ?? []}::uuid[]='{}'::uuid[] OR (SELECT count(DISTINCT cla.label_id) FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.label_id=ANY(${input.labelIdsAll ?? []}::uuid[]))=cardinality(${input.labelIdsAll ?? []}::uuid[])) AND (${input.labelIdsNot ?? []}::uuid[]='{}'::uuid[] OR NOT EXISTS(SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.label_id=ANY(${input.labelIdsNot ?? []}::uuid[]))) AND (${input.unlabeled ?? false}=false OR NOT EXISTS(SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id)) AND (${input.labelCategoryId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM conversation_label_assignments cla JOIN conversation_labels fl ON fl.id=cla.label_id WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND fl.category_id=${input.labelCategoryId ?? null}::uuid)) AND (${input.labeledAfter ?? null}::timestamptz IS NULL OR EXISTS(SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.assigned_at>=${input.labeledAfter ?? null}::timestamptz)) AND (${input.labelSource ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM conversation_label_assignments cla WHERE cla.organization_id=c.organization_id AND cla.conversation_id=c.id AND cla.source=${input.labelSource ?? null})) AND (${input.whatsappOwnerUserId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.whatsappOwnerUserId ?? null}::uuid)) AND (${input.unreadOnly ?? false}=false OR c.unread_count>0) AND (${input.scope ?? "all"}::text='all' OR (${input.scope ?? "all"}::text='assigned_to_me' AND c.assignee_id=${input.userId}::uuid) OR (${input.scope ?? "all"}::text='unassigned' AND c.assignee_id IS NULL)) AND (${input.search ?? null}::text IS NULL OR COALESCE(ct.display_name,concat_ws(' ',ct.first_name,ct.last_name)) ILIKE ${`%${input.search ?? ""}%`} OR ct.normalized_phone ILIKE ${`%${input.search ?? ""}%`} OR COALESCE(m.body,'') ILIKE ${`%${input.search ?? ""}%`}) AND (${!["agent", "team_lead"].includes(input.role)} OR (EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid) AND (c.assignee_id=${input.userId}::uuid OR c.assignee_id IS NULL))) AND (${cursor?.date ?? null}::timestamptz IS NULL OR (c.last_message_at,c.id)<(${cursor?.date ?? null}::timestamptz,${cursor?.id ?? null}::uuid)) ORDER BY c.last_message_at DESC,c.id DESC LIMIT ${input.limit + 1}`;
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit).map((row) => this.map(row));
    const last = selected.at(-1);
    return {
      data: selected,
      nextCursor:
        hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
    };
  }
  async counts(input: ConversationCountInput): Promise<{
    all: number;
    assignedToMe: number;
    unassigned: number;
    unread: number;
    archived: number;
  }> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT
        count(*) FILTER (WHERE c.status<>'archived')::int all_count,
        count(*) FILTER (WHERE c.status<>'archived' AND c.assignee_id=${input.userId}::uuid)::int assigned_to_me_count,
        count(*) FILTER (WHERE c.status<>'archived' AND c.assignee_id IS NULL)::int unassigned_count,
        count(*) FILTER (WHERE c.status<>'archived' AND c.unread_count>0)::int unread_count,
        count(*) FILTER (
          WHERE c.status='archived'
            AND NOT EXISTS (
              SELECT 1
              FROM conversations active
              WHERE active.organization_id=c.organization_id
                AND active.channel_id=c.channel_id
                AND active.contact_id=c.contact_id
                AND active.id<>c.id
                AND active.status IN ('open','waiting')
            )
        )::int archived_count
      FROM conversations c
      JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
      LEFT JOIN messages m ON m.id=c.last_message_id AND m.organization_id=c.organization_id
      WHERE c.organization_id=${input.organizationId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM conversation_operation_history superseded
          WHERE superseded.organization_id=c.organization_id
            AND superseded.conversation_id=c.id
            AND superseded.operation='conversation.canonicalized'
        )
        AND (${input.channelId ?? null}::uuid IS NULL OR c.channel_id=${input.channelId ?? null}::uuid)
        AND (
          ${input.search ?? null}::text IS NULL
          OR COALESCE(ct.display_name,concat_ws(' ',ct.first_name,ct.last_name)) ILIKE ${`%${input.search ?? ""}%`}
          OR ct.normalized_phone ILIKE ${`%${input.search ?? ""}%`}
          OR COALESCE(m.body,'') ILIKE ${`%${input.search ?? ""}%`}
        )
        AND (
          ${!["agent", "team_lead"].includes(input.role)}
          OR (
            EXISTS (
              SELECT 1 FROM channel_user_ownership cuo
              WHERE cuo.organization_id=c.organization_id
                AND cuo.channel_id=c.channel_id
                AND cuo.user_id=${input.userId}::uuid
            )
            AND (c.assignee_id=${input.userId}::uuid OR c.assignee_id IS NULL)
          )
        )`;
    const row = rows[0] ?? {};
    return {
      all: Number(row.all_count ?? 0),
      assignedToMe: Number(row.assigned_to_me_count ?? 0),
      unassigned: Number(row.unassigned_count ?? 0),
      unread: Number(row.unread_count ?? 0),
      archived: Number(row.archived_count ?? 0),
    };
  }
  async get(
    organizationId: string,
    id: string,
    userId?: string,
    role?: string,
  ): Promise<ConversationDto | null> {
    const rows = await this.list({
      organizationId,
      id,
      userId: userId ?? "00000000-0000-0000-0000-000000000000",
      role: role ?? "owner",
      limit: 1,
    });
    return rows.data[0] ?? null;
  }
  async hasOwnedChannelAccess(
    input: ConversationOwnedChannelAccessInput,
  ): Promise<boolean> {
    if (input.conversationIds.length === 0) return true;
    const accessible = await this.sql<Array<{ id: string }>>`
      SELECT c.id FROM conversations c
      WHERE c.organization_id=${input.organizationId}::uuid
        AND c.id IN ${this.sql(input.conversationIds)}
        AND EXISTS (
          SELECT 1 FROM channel_user_ownership cuo
          WHERE cuo.organization_id=c.organization_id
            AND cuo.channel_id=c.channel_id
            AND cuo.user_id=${input.userId}::uuid
        )`;
    return accessible.length === input.conversationIds.length;
  }
  async latestInboundProviderMessage(
    organizationId: string,
    conversationId: string,
  ): Promise<LatestInboundProviderMessage | null> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
SELECT ch.provider,ch.phone_number_id,ch.credentials_encrypted,m.provider_message_id
FROM messages m
JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id
WHERE m.organization_id=${organizationId}::uuid
  AND m.conversation_id=${conversationId}::uuid
  AND m.direction='inbound'
  AND m.provider_message_id IS NOT NULL
  AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
LIMIT 1`;
    const row = rows[0];
    return row
      ? {
          provider: String(row.provider),
          phone_number_id: row.phone_number_id
            ? String(row.phone_number_id)
            : null,
          credentials_encrypted: row.credentials_encrypted
            ? String(row.credentials_encrypted)
            : null,
          provider_message_id: row.provider_message_id
            ? String(row.provider_message_id)
            : null,
        }
      : null;
  }
  async markRead(organizationId: string, id: string): Promise<boolean> {
    const rows = await this
      .sql`UPDATE conversations SET unread_count=0,updated_at=now() WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid RETURNING id`;
    return rows.length === 1;
  }
  async markUnread(organizationId: string, id: string): Promise<boolean> {
    const rows = await this
      .sql`UPDATE conversations SET unread_count=GREATEST(unread_count,1),updated_at=now() WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid RETURNING id`;
    return rows.length === 1;
  }
  private map(row: Record<string, unknown>): ConversationDto {
    const name = String(row.contact_name ?? "Unknown");
    const customFields =
      row.custom_fields &&
      typeof row.custom_fields === "object" &&
      !Array.isArray(row.custom_fields)
        ? (row.custom_fields as Record<string, unknown>)
        : {};
    const groupParticipants = Array.isArray(
      customFields.whatsappWebParticipants,
    )
      ? customFields.whatsappWebParticipants.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const participant = value as Record<string, unknown>;
          const jid =
            typeof participant.jid === "string" ? participant.jid : "";
          if (!jid) return [];
          const phoneNumber =
            typeof participant.phoneNumber === "string" &&
            /^\+\d{8,15}$/.test(participant.phoneNumber)
              ? participant.phoneNumber
              : null;
          return [
            {
              jid,
              lid: typeof participant.lid === "string" ? participant.lid : null,
              phoneNumber,
              name:
                typeof participant.name === "string" && participant.name.trim()
                  ? participant.name.trim()
                  : null,
              isAdmin: participant.isAdmin === true,
            },
          ];
        })
      : [];
    return {
      id: String(row.id),
      organizationId: String(row.organization_id),
      contactId: String(row.contact_id),
      contactName: name,
      phone: String(row.phone),
      isGroup: customFields.whatsappWebConversationType === "group",
      groupParticipants,
      avatar: name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase(),
      profilePictureUrl: row.profile_picture_url
        ? String(row.profile_picture_url)
        : null,
      preview: String(row.preview ?? ""),
      lastMessageAt: new Date(String(row.last_message_at)).toISOString(),
      unreadCount: Number(row.unread_count),
      assigneeId: row.assignee_id ? String(row.assignee_id) : null,
      assigneeName: row.assignee_name ? String(row.assignee_name) : null,
      channelName: String(row.channel_name),
      whatsappOwnerName: row.whatsapp_owner_name
        ? String(row.whatsapp_owner_name)
        : null,
      whatsappPhone: row.whatsapp_phone ? String(row.whatsapp_phone) : null,
      channelId: String(row.channel_id),
      stage: String(row.stage),
      priority: String(row.priority),
      status: String(row.status),
      direction: String(row.direction),
      lastProviderStatus: String(row.last_provider_status),
      customerServiceWindowExpiresAt: row.customer_service_window_expires_at
        ? new Date(String(row.customer_service_window_expires_at)).toISOString()
        : null,
      tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag)) : [],
      labels: Array.isArray(row.label_objects)
        ? row.label_objects.map((label) => {
            const value = label as Record<string, unknown>;
            return {
              id: String(value.id),
              name: String(value.name),
              color: String(value.color),
              icon: value.icon ? String(value.icon) : null,
            };
          })
        : [],
    };
  }
}
export class ConversationLabelRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async isActiveInOrganization(organizationId: string, labelId: string) {
    return Boolean(
      (
        await this.sql`
          SELECT 1 FROM conversation_labels
          WHERE id=${labelId}::uuid
            AND organization_id=${organizationId}::uuid
            AND status='active' AND deleted_at IS NULL`
      ).length,
    );
  }

  async listForConversation(organizationId: string, conversationId: string) {
    return this.sql`
      SELECT l.id,l.name,l.color
      FROM conversation_label_assignments a
      JOIN conversation_labels l ON l.id=a.label_id
      WHERE a.organization_id=${organizationId}::uuid
        AND a.conversation_id=${conversationId}::uuid
      ORDER BY l.name
    `;
  }

  async replaceForConversation(input: {
    organizationId: string;
    conversationId: string;
    labelId: string | null;
    actorId: string;
  }): Promise<string | null> {
    return this.sql.begin(async (tx) => {
      const conversation = (
        await tx<Array<Record<string, unknown>>>`
          SELECT id FROM conversations
          WHERE id=${input.conversationId}::uuid
            AND organization_id=${input.organizationId}::uuid
          FOR UPDATE
        `
      )[0];
      if (!conversation) return null;
      if (input.labelId) {
        const label = (
          await tx<Array<Record<string, unknown>>>`
            SELECT id FROM conversation_labels
            WHERE id=${input.labelId}::uuid
              AND organization_id=${input.organizationId}::uuid
          `
        )[0];
        if (!label) return "label_not_found";
      }
      await tx`
        DELETE FROM conversation_label_assignments
        WHERE organization_id=${input.organizationId}::uuid
          AND conversation_id=${input.conversationId}::uuid
      `;
      if (input.labelId) {
        await tx`
          INSERT INTO conversation_label_assignments(
            organization_id,
            conversation_id,
            label_id,
            assigned_by
          ) VALUES(
            ${input.organizationId}::uuid,
            ${input.conversationId}::uuid,
            ${input.labelId}::uuid,
            ${input.actorId}::uuid
          )
        `;
      }
      return input.labelId;
    });
  }
}
export class MessageRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async getById(
    organizationId: string,
    id: string,
  ): Promise<MessageDto | null> {
    const rows = await this.sql<Array<Record<string, unknown>>>`
      SELECT
        m.*,
        COALESCE(m.provider_timestamp,m.sent_at) display_at,
        COALESCE(
          u.full_name,
          CASE
            WHEN m.direction='inbound'
              THEN COALESCE(
                NULLIF(BTRIM(m.metadata->>'senderName'),''),
                NULLIF(BTRIM(ct.display_name),''),
                NULLIF(BTRIM(concat_ws(' ',ct.first_name,ct.last_name)),''),
                ct.normalized_phone,
                'Customer'
              )
            ELSE 'Agent'
          END
        ) sender_name,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id',a.id,
                'type',a.attachment_type,
                'filename',coalesce(a.stored_filename,a.provider_filename),
                'mimeType',coalesce(a.stored_mime_type,a.provider_mime_type),
                'status',a.processing_status,
                'scanStatus',a.scan_status,
                'size',coalesce(a.stored_size,a.provider_file_size)
              )
              ORDER BY a.created_at
            )
            FROM message_attachments a
            WHERE a.message_id=m.id
              AND a.organization_id=m.organization_id
              AND a.deleted_at IS NULL
          ),
          '[]'::jsonb
        ) attachments
      FROM messages m
      LEFT JOIN users u ON u.id=m.sender_id
      LEFT JOIN contacts ct
        ON ct.id=m.contact_id
       AND ct.organization_id=m.organization_id
      WHERE m.organization_id=${organizationId}::uuid
        AND m.id=${id}::uuid
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
    `;
    return rows[0] ? this.map(rows[0]) : null;
  }
  async list(
    organizationId: string,
    conversationId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ data: MessageDto[]; nextCursor: string | null }> {
    const decoded = decodeCursor(cursor);
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT m.*,COALESCE(m.provider_timestamp,m.sent_at) display_at,COALESCE(u.full_name,CASE WHEN m.direction='inbound' THEN COALESCE(NULLIF(BTRIM(m.metadata->>'senderName'),''),NULLIF(BTRIM(ct.display_name),''),NULLIF(BTRIM(concat_ws(' ',ct.first_name,ct.last_name)),''),ct.normalized_phone,'Customer') ELSE 'Agent' END) sender_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'type',a.attachment_type,'filename',coalesce(a.stored_filename,a.provider_filename),'mimeType',coalesce(a.stored_mime_type,a.provider_mime_type),'status',a.processing_status,'scanStatus',a.scan_status,'size',coalesce(a.stored_size,a.provider_file_size)) ORDER BY a.created_at) FROM message_attachments a WHERE a.message_id=m.id AND a.organization_id=m.organization_id AND a.deleted_at IS NULL),'[]'::jsonb) attachments
      FROM messages m
      LEFT JOIN users u ON u.id=m.sender_id
      LEFT JOIN contacts ct ON ct.id=m.contact_id AND ct.organization_id=m.organization_id
      WHERE m.organization_id=${organizationId}::uuid
        AND m.metadata->>'suppressed' IS DISTINCT FROM 'true'
        AND m.conversation_id IN (
          SELECT sibling.id
          FROM conversations requested
          JOIN conversations sibling
            ON sibling.organization_id=requested.organization_id
           AND sibling.channel_id=requested.channel_id
           AND sibling.contact_id=requested.contact_id
          WHERE requested.organization_id=${organizationId}::uuid
            AND requested.id=${conversationId}::uuid
        )
        AND (${decoded?.date ?? null}::timestamptz IS NULL OR (COALESCE(m.provider_timestamp,m.sent_at),m.id)<(${decoded?.date ?? null}::timestamptz,${decoded?.id ?? null}::uuid))
      ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const data = rows
      .slice(0, limit)
      .reverse()
      .map((row) => this.map(row));
    const oldest = data[0];
    return {
      data,
      nextCursor:
        hasMore && oldest ? encodeCursor(oldest.sentAt, oldest.id) : null,
    };
  }
  async createOutbound(input: {
    organizationId: string;
    conversationId: string;
    senderId: string;
    role: string;
    clientMessageId: string;
    expectedChannelId?: string | undefined;
    text: string;
    traceId: string;
    type?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ message: MessageDto; created: boolean }> {
    if (/\{\{\s*[^{}]+\s*\}\}/.test(input.text))
      throw Object.assign(new Error("QUICK_REPLY_VARIABLES_UNRESOLVED"), {
        statusCode: 409,
      });
    return this.sql.begin(async (tx) => {
      const existing = await tx<
        Array<Record<string, unknown>>
      >`SELECT m.*,u.full_name sender_name FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.organization_id=${input.organizationId}::uuid AND m.client_message_id=${input.clientMessageId}::uuid`;
      if (existing[0])
        return { message: this.map(existing[0]), created: false };
      const conversation = await tx<
        Array<Record<string, unknown>>
      >`SELECT c.channel_id,c.contact_id,c.customer_service_window_expires_at,ch.status,coalesce(ch.connection_status,'ACTIVE') connection_status,ch.provider,coalesce(ch.platform,'whatsapp') platform,ch.capabilities FROM conversations c JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id WHERE c.id=${input.conversationId}::uuid AND c.organization_id=${input.organizationId}::uuid AND ch.deleted_at IS NULL AND (${!["agent", "team_lead"].includes(input.role)} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.senderId}::uuid)) FOR UPDATE`;
      const current = conversation[0];
      if (!current)
        throw Object.assign(new Error("conversation_not_found"), {
          statusCode: 404,
        });
      if (
        input.expectedChannelId &&
        String(current.channel_id) !== input.expectedChannelId
      )
        throw Object.assign(new Error("SELECTED_CHANNEL_MISMATCH"), {
          statusCode: 409,
        });
      if (
        current.status !== "connected" ||
        current.connection_status !== "ACTIVE"
      )
        throw Object.assign(new Error("channel_not_connected"), {
          statusCode: 409,
        });
      if (
        current.platform === "whatsapp" &&
        (!current.customer_service_window_expires_at ||
          new Date(String(current.customer_service_window_expires_at)) <=
            new Date())
      )
        throw Object.assign(new Error("WHATSAPP_TEMPLATE_REQUIRED"), {
          statusCode: 409,
        });
      const inserted = await tx<
        Array<Record<string, unknown>>
      >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,sender_id,metadata) VALUES(${input.organizationId}::uuid,${input.conversationId}::uuid,${String(current.channel_id)}::uuid,${String(current.contact_id)}::uuid,${input.clientMessageId}::uuid,'outbound',${input.type ?? "text"},'pending',${input.text},${input.senderId}::uuid,${this.sql.json((input.metadata ?? {}) as never)}) RETURNING *`;
      const row = inserted[0];
      if (!row) throw new Error("message_insert_failed");
      const sender = await tx<Array<{ full_name: string }>>`
        SELECT full_name FROM users
        WHERE id=${input.senderId}::uuid
          AND EXISTS (
            SELECT 1 FROM organization_members
            WHERE organization_id=${input.organizationId}::uuid
              AND user_id=${input.senderId}::uuid
          )
      `;
      await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${input.organizationId}::uuid,'message',${String(row.id)}::uuid,'message.send',${tx.json({ messageId: String(row.id), traceId: input.traceId })})`;
      await tx`INSERT INTO message_flow_events(organization_id,message_id,trace_id,event_type,source) VALUES(${input.organizationId}::uuid,${String(row.id)}::uuid,${input.traceId}::uuid,'message.accepted','api'),(${input.organizationId}::uuid,${String(row.id)}::uuid,${input.traceId}::uuid,'outbox.created','api')`;
      await tx`UPDATE conversations SET last_message_id=${String(row.id)}::uuid,last_message_at=now(),updated_at=now() WHERE id=${input.conversationId}::uuid AND organization_id=${input.organizationId}::uuid`;
      // A manual human reply always wins over AI: record the takeover so the
      // AI eligibility engine pauses this conversation. Guarded by an
      // ai_settings existence check so non-AI workspaces never grow rows.
      await tx`INSERT INTO ai_conversation_settings(organization_id,conversation_id,human_takeover_at,consecutive_ai_messages)
        SELECT ${input.organizationId}::uuid,${input.conversationId}::uuid,now(),0
        WHERE EXISTS(SELECT 1 FROM ai_settings WHERE organization_id=${input.organizationId}::uuid AND enabled=true)
        ON CONFLICT(conversation_id) DO UPDATE SET human_takeover_at=now(),consecutive_ai_messages=0,updated_at=now()`;
      return {
        message: this.map({
          ...row,
          sender_name: sender[0]?.full_name ?? "Agent",
        }),
        created: true,
      };
    });
  }
  private map(row: Record<string, unknown>): MessageDto {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      clientMessageId: row.client_message_id
        ? String(row.client_message_id)
        : null,
      providerMessageId: row.provider_message_id
        ? String(row.provider_message_id)
        : null,
      body: String(row.body ?? ""),
      type: String(row.type ?? "text"),
      direction: String(row.direction),
      status: String(row.status),
      sentAt: new Date(
        String(
          row.display_at ??
            row.provider_timestamp ??
            row.sent_at ??
            row.created_at,
        ),
      ).toISOString(),
      senderName: String(row.sender_name ?? "Customer"),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      attachments: Array.isArray(row.attachments)
        ? (row.attachments as Array<Record<string, unknown>>)
        : [],
      errorCode: row.error_code ? String(row.error_code) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
    };
  }
}
export class ChannelRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async listUsers(input: { organizationId: string; channelId: string }) {
    return this.sql`
      SELECT
        cuo.user_id,
        u.full_name,
        u.email,
        om.role,
        cuo.relationship_type,
        cuo.is_primary,
        cuo.created_at
      FROM channel_user_ownership cuo
      JOIN channels c
        ON c.id=cuo.channel_id
       AND c.organization_id=cuo.organization_id
       AND c.deleted_at IS NULL
      JOIN users u ON u.id=cuo.user_id
      JOIN organization_members om
        ON om.organization_id=cuo.organization_id
       AND om.user_id=cuo.user_id
      WHERE cuo.organization_id=${input.organizationId}::uuid
        AND cuo.channel_id=${input.channelId}::uuid
      ORDER BY cuo.is_primary DESC,u.full_name`;
  }
  async listAccessible(input: {
    organizationId: string;
    userId: string;
    role: string;
  }) {
    const restricted = ["agent", "team_lead"].includes(input.role);
    return this.sql<Array<Record<string, unknown>>>`
      SELECT
        c.*,
        COALESCE(metrics.open_conversations, 0)::int open_conversations,
        COALESCE(metrics.inbound_messages, 0)::int inbound_messages,
        COALESCE(metrics.outbound_messages, 0)::int outbound_messages,
        COALESCE(owners.members, '[]'::jsonb) channel_members,
        channel_team.primary_team_name,
        wws.status whatsapp_web_session_status,
        wws.qr_expires_at whatsapp_web_qr_expires_at,
        wws.last_heartbeat_at whatsapp_web_last_heartbeat_at,
        wws.last_error_code whatsapp_web_last_error_code
      FROM channels c
      LEFT JOIN whatsapp_web_sessions wws
        ON wws.channel_id=c.id
       AND wws.organization_id=c.organization_id
      LEFT JOIN LATERAL (
        SELECT
          count(DISTINCT conv.id) FILTER (
            WHERE conv.status IN ('open', 'waiting')
          ) open_conversations,
          count(msg.id) FILTER (WHERE msg.direction='inbound') inbound_messages,
          count(msg.id) FILTER (WHERE msg.direction='outbound') outbound_messages
        FROM conversations conv
        LEFT JOIN messages msg
          ON msg.conversation_id=conv.id
         AND msg.organization_id=conv.organization_id
        WHERE conv.organization_id=c.organization_id
          AND conv.channel_id=c.id
      ) metrics ON true
      LEFT JOIN LATERAL (
        SELECT
          jsonb_agg(
            jsonb_build_object(
              'id', u.id,
              'name', u.full_name,
              'primary', cuo.is_primary
            )
            ORDER BY cuo.is_primary DESC, u.full_name
          ) members
        FROM channel_user_ownership cuo
        JOIN users u ON u.id=cuo.user_id
        WHERE cuo.organization_id=c.organization_id
          AND cuo.channel_id=c.id
      ) owners ON true
      LEFT JOIN LATERAL (
        SELECT t.name primary_team_name
        FROM conversations owned_conversation
        JOIN teams t
          ON t.id=owned_conversation.team_id
         AND t.organization_id=owned_conversation.organization_id
        WHERE owned_conversation.organization_id=c.organization_id
          AND owned_conversation.channel_id=c.id
          AND owned_conversation.status IN ('open', 'waiting')
        GROUP BY t.id, t.name
        ORDER BY count(*) DESC, t.name
        LIMIT 1
      ) channel_team ON true
      WHERE c.organization_id=${input.organizationId}::uuid
        AND c.deleted_at IS NULL
        AND (
          ${restricted}=false
          OR EXISTS(
            SELECT 1
            FROM channel_user_ownership cuo
            WHERE cuo.organization_id=c.organization_id
              AND cuo.channel_id=c.id
              AND cuo.user_id=${input.userId}::uuid
          )
        )
      ORDER BY c.created_at DESC`;
  }
  async byIdAccessible(input: {
    organizationId: string;
    channelId: string;
    userId: string;
    role: string;
  }) {
    const restricted = ["agent", "team_lead"].includes(input.role);
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT c.* FROM channels c WHERE c.id=${input.channelId}::uuid AND c.organization_id=${input.organizationId}::uuid AND c.deleted_at IS NULL AND (${restricted}=false OR EXISTS(SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.id AND cuo.user_id=${input.userId}::uuid))`;
    return rows[0] ?? null;
  }
  async list(organizationId: string) {
    return this
      .sql`SELECT id,public_id,name,provider,phone_number,status,last_webhook_at,last_successful_message_at,last_error_at,last_error_code,(credentials_encrypted IS NOT NULL) credentials_configured,(phone_number_id IS NOT NULL) phone_number_configured FROM channels WHERE organization_id=${organizationId}::uuid AND deleted_at IS NULL ORDER BY name`;
  }
  async byPublicId(publicId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        publicId,
      )
    )
      return null;
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT c.*,coalesce(pa.encrypted_credentials,c.credentials_encrypted) resolved_credentials_encrypted FROM channels c LEFT JOIN provider_accounts pa ON pa.id=c.provider_account_id AND pa.organization_id=c.organization_id AND pa.archived_at IS NULL WHERE c.public_id=${publicId}::uuid AND c.deleted_at IS NULL`;
    return rows[0] ?? null;
  }
  async byMetaPhoneNumberId(input: {
    organizationId: string;
    phoneNumberId: string;
    providerAccountId?: string | null;
    businessAccountId?: string | null;
  }) {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT c.*,coalesce(pa.encrypted_credentials,c.credentials_encrypted) resolved_credentials_encrypted FROM channels c LEFT JOIN provider_accounts pa ON pa.id=c.provider_account_id AND pa.organization_id=c.organization_id AND pa.archived_at IS NULL WHERE c.organization_id=${input.organizationId}::uuid AND c.provider='meta' AND c.phone_number_id=${input.phoneNumberId} AND c.deleted_at IS NULL AND (${input.providerAccountId ?? null}::uuid IS NULL OR c.provider_account_id=${input.providerAccountId ?? null}::uuid) AND (${input.businessAccountId ?? null}::text IS NULL OR c.business_account_id=${input.businessAccountId ?? null}) LIMIT 1`;
    return rows[0] ?? null;
  }
  async byId(organizationId: string, id: string) {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM channels WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid AND deleted_at IS NULL`;
    return rows[0] ?? null;
  }
  async updateHealth(input: {
    organizationId: string;
    channelId: string;
    status: string;
    code: string | null;
    checkedAt: Date;
    profile: Record<string, unknown>;
    healthy: boolean;
  }) {
    await this.sql`
      UPDATE channels
      SET
        health_status=${input.status},
        health_state=${
          input.healthy
            ? "HEALTHY"
            : input.status === "degraded"
              ? "WARNING"
              : "UNHEALTHY"
        },
        connection_status=CASE
          WHEN ${input.healthy} THEN 'ACTIVE'
          WHEN ${input.code ?? ""} IN ('PROVIDER_UNAUTHORIZED','PROVIDER_TOKEN_EXPIRED')
            THEN 'AUTH_EXPIRED'
          ELSE 'DEGRADED'
        END,
        health_code=${input.code},
        health_checked_at=${input.checkedAt},
        last_health_check_at=${input.checkedAt},
        last_health_error=${input.healthy ? null : input.code},
        provider_profile=${this.sql.json(input.profile as never)},
        last_error_at=${input.healthy ? null : new Date()},
        last_error_code=${input.code},
        version=version+1,
        updated_at=now()
      WHERE id=${input.channelId}::uuid
        AND organization_id=${input.organizationId}::uuid
        AND deleted_at IS NULL`;
  }
  async archiveProviderAccount(input: {
    organizationId: string;
    providerAccountId: string;
    actorId: string;
  }) {
    await this.sql`
      UPDATE provider_accounts
      SET
        status='archived',
        encrypted_credentials=NULL,
        archived_at=now(),
        updated_by=${input.actorId}::uuid,
        updated_at=now()
      WHERE id=${input.providerAccountId}::uuid
        AND organization_id=${input.organizationId}::uuid`;
  }
  async activateTelegramIdentity(input: {
    organizationId: string;
    channelId: string;
    botId: string;
    username?: string | undefined;
  }) {
    await this.sql`
      UPDATE channels SET
        phone_number_id=${input.botId},
        external_channel_id=${input.botId},
        phone_number=${input.username ? `@${input.username}` : input.botId},
        health_status='healthy',health_state='HEALTHY',health_code=NULL,
        health_checked_at=now(),last_health_check_at=now(),updated_at=now()
      WHERE id=${input.channelId}::uuid
        AND organization_id=${input.organizationId}::uuid
        AND deleted_at IS NULL`;
  }
  async failTelegramProvisioning(input: {
    organizationId: string;
    channelId: string;
    code: string;
  }) {
    await this.sql`
      UPDATE channels SET
        credentials_encrypted=NULL,status='disconnected',
        connection_status='DISCONNECTED',health_status='unhealthy',
        health_code=${input.code},deleted_at=now(),updated_at=now()
      WHERE id=${input.channelId}::uuid
        AND organization_id=${input.organizationId}::uuid`;
  }
  async createHealthWarningNotification(input: {
    organizationId: string;
    channelId: string;
    channelName: string;
    code: string | null;
  }) {
    await this.sql`
      INSERT INTO notifications(
        organization_id,user_id,type,title,body,metadata
      )
      VALUES(
        ${input.organizationId}::uuid,
        null,
        'channel.health_warning',
        'Kanal sağlık kontrolü başarısız',
        ${`${input.channelName} kanalının sağlık kontrolü başarısız oldu.`},
        ${this.sql.json({
          channelId: input.channelId,
          code: input.code,
        } as never)}
      )`;
  }
}
export class WebhookEventRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async insert(input: {
    organizationId: string;
    channelId: string;
    eventKey: string;
    eventType: string;
    payload: unknown;
    status?: string;
    provider?: string;
  }) {
    return this.sql.begin(async (tx) => {
      const rows = await tx<Array<{ id: string; received_at: Date }>>`
        INSERT INTO provider_webhook_events(
          organization_id,channel_id,provider,provider_event_key,event_type,
          payload,signature_valid,status
        )
        VALUES(
          ${input.organizationId}::uuid,${input.channelId}::uuid,${input.provider ?? "meta"},
          ${input.eventKey},${input.eventType},
          ${tx.json(input.payload as never)},true,${input.status ?? "pending"}
        )
        ON CONFLICT(provider,provider_event_key) DO NOTHING
        RETURNING id,received_at`;
      const inserted = rows.length === 1;
      const receivedAt = rows[0]?.received_at ?? new Date();
      await tx`
        UPDATE channels
        SET
          last_webhook_at=${receivedAt},
          last_webhook_result=${
            inserted
              ? input.status === "unmatched_channel"
                ? "unmatched_channel"
                : "accepted"
              : "duplicate"
          },
          health_state=CASE
            WHEN connection_status='ACTIVE' THEN 'HEALTHY'
            ELSE health_state
          END,
          updated_at=now()
        WHERE id=${input.channelId}::uuid
          AND organization_id=${input.organizationId}::uuid
          AND deleted_at IS NULL`;
      return inserted;
    });
  }
}
export class OrganizationRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async exists(id: string) {
    const rows = await this
      .sql`SELECT 1 FROM organizations WHERE id=${id}::uuid`;
    return rows.length === 1;
  }
}
export class ContactRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async findByPhone(organizationId: string, normalizedPhone: string) {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT id,organization_id,first_name,last_name,display_name,normalized_phone,email,profile_picture_url,language,country FROM contacts WHERE organization_id=${organizationId}::uuid AND normalized_phone=${normalizedPhone}`;
    return rows[0] ?? null;
  }
}
export class OutboxRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async findByMessage(organizationId: string, messageId: string) {
    const rows = await this.sql<
      Array<Record<string, unknown>>
    >`SELECT id,status,attempt_count,max_attempts,next_attempt_at,last_error,completed_at FROM outbox_jobs WHERE organization_id=${organizationId}::uuid AND aggregate_type='message' AND aggregate_id=${messageId}::uuid ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ?? null;
  }
}
export class MessageStatusRepository {
  constructor(private readonly sql: DatabaseClient) {}
  async list(organizationId: string, messageId: string) {
    return this
      .sql`SELECT id,status,provider_timestamp,created_at FROM message_status_events WHERE organization_id=${organizationId}::uuid AND message_id=${messageId}::uuid ORDER BY created_at`;
  }
}

export interface MediaCleanupAuditInput {
  organizationId: string;
  actorId: string;
  storageKey: string;
  storageProvider: string;
  storageBucket: string | null;
  reason: string;
  scanStatus?: string;
}

export class MediaAuditRepository {
  constructor(private readonly sql: DatabaseClient) {}

  async recordCleanupRequired(input: MediaCleanupAuditInput): Promise<void> {
    const metadata = {
      storageKey: input.storageKey,
      storageProvider: input.storageProvider,
      storageBucket: input.storageBucket,
      reason: input.reason,
      cleanupStatus: "pending",
      ...(input.scanStatus ? { scanStatus: input.scanStatus } : {}),
    };
    await this.sql`
      INSERT INTO audit_logs(
        organization_id,
        actor_id,
        action,
        entity_type,
        metadata
      ) VALUES(
        ${input.organizationId}::uuid,
        ${input.actorId}::uuid,
        'media.cleanup_required',
        'object_storage',
        ${this.sql.json(metadata as never)}
      )
    `;
  }
}
