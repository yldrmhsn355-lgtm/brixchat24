import type postgres from "postgres";

type DatabaseClient = ReturnType<typeof postgres>;
export type Milestone5Row = Record<string, unknown>;

/** Query-specific gateway used while milestone 5 routes leave direct SQL behind. */
export class Milestone5Repository {
  constructor(private readonly sql: DatabaseClient) {}

  async updateIntegrationCredentials(id: string, encrypted: string) {
    await this
      .sql`UPDATE integration_connections SET credentials_encrypted=${encrypted},updated_at=now() WHERE id=${id}::uuid`;
  }

  async recordMediaDownloadAudit(input: {
    organizationId: string;
    attachmentId: string;
    actorId: string;
  }) {
    await this.sql`
      INSERT INTO media_download_audit(
        organization_id,attachment_id,actor_id,action,outcome
      ) VALUES(
        ${input.organizationId}::uuid,${input.attachmentId}::uuid,
        ${input.actorId}::uuid,'signed_url','allowed'
      )`;
  }

  search(input: {
    organizationId: string;
    conversationId?: string | undefined;
    channelId?: string | undefined;
    restricted: boolean;
    userId: string;
    like: string;
    type: string;
    limit: number;
  }) {
    return this.sql<Milestone5Row[]>`
      SELECT * FROM (
        SELECT m.id,'message' kind,coalesce(ct.display_name,ct.normalized_phone) title,m.body preview,m.conversation_id,m.id message_id,NULL::uuid attachment_id,m.sent_at occurred_at FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id JOIN contacts ct ON ct.id=c.contact_id WHERE m.organization_id=${input.organizationId}::uuid AND (${input.conversationId ?? null}::uuid IS NULL OR m.conversation_id=${input.conversationId ?? null}::uuid) AND (${input.channelId ?? null}::uuid IS NULL OR m.channel_id=${input.channelId ?? null}::uuid) AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) AND m.body ILIKE ${input.like}
        UNION ALL SELECT n.id,'note','Dahili not',n.body,n.conversation_id,NULL::uuid,NULL::uuid,n.created_at FROM conversation_notes n JOIN conversations c ON c.id=n.conversation_id AND c.organization_id=n.organization_id WHERE n.organization_id=${input.organizationId}::uuid AND n.deleted_at IS NULL AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) AND n.body ILIKE ${input.like}
        UNION ALL SELECT a.id,'attachment',coalesce(a.provider_filename,a.stored_filename,'Medya'),coalesce(a.provider_filename,a.stored_filename,'Medya'),m.conversation_id,a.message_id,a.id,a.created_at FROM message_attachments a JOIN messages m ON m.id=a.message_id AND m.organization_id=a.organization_id JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE a.organization_id=${input.organizationId}::uuid AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) AND coalesce(a.provider_filename,a.stored_filename,'') ILIKE ${input.like}
        UNION ALL SELECT c.id,'conversation',coalesce(ct.display_name,ct.normalized_phone),coalesce(m.body,''),c.id,m.id,NULL::uuid,c.last_message_at FROM conversations c JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN messages m ON m.id=c.last_message_id WHERE c.organization_id=${input.organizationId}::uuid AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) AND (coalesce(ct.display_name,'') ILIKE ${input.like} OR ct.normalized_phone ILIKE ${input.like})
        UNION ALL SELECT x.id,'bitrix',coalesce(x.context->>'displayName','Bitrix24'),coalesce(x.context->>'dealTitle',x.context->>'company',''),x.conversation_id,NULL::uuid,NULL::uuid,x.fetched_at FROM conversation_crm_context_cache x JOIN conversations c ON c.id=x.conversation_id AND c.organization_id=x.organization_id WHERE x.organization_id=${input.organizationId}::uuid AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) AND x.context::text ILIKE ${input.like}
      ) s WHERE (${input.type}='all' OR kind=trim(trailing 's' from ${input.type})) ORDER BY occurred_at DESC LIMIT ${input.limit}`;
  }

  messageDisplayAt(input: {
    organizationId: string;
    conversationId: string;
    messageId: string;
    restricted: boolean;
    userId: string;
  }) {
    return this.sql<
      Milestone5Row[]
    >`SELECT COALESCE(m.provider_timestamp,m.sent_at) display_at FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.id=${input.messageId}::uuid AND m.conversation_id=${input.conversationId}::uuid AND m.organization_id=${input.organizationId}::uuid AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid))`;
  }

  messagesAround(input: {
    organizationId: string;
    conversationId: string;
    at: Date;
    side: "before" | "after";
  }) {
    const base =
      input.side === "before"
        ? this.sql<Milestone5Row[]>`
        SELECT m.*,COALESCE(m.provider_timestamp,m.sent_at) display_at,COALESCE(u.full_name,CASE WHEN m.direction='inbound' THEN COALESCE(NULLIF(BTRIM(m.metadata->>'senderName'),''),NULLIF(BTRIM(ct.display_name),''),NULLIF(BTRIM(concat_ws(' ',ct.first_name,ct.last_name)),''),ct.normalized_phone,'Customer') ELSE 'Agent' END) sender_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'type',a.attachment_type,'filename',coalesce(a.stored_filename,a.provider_filename),'mimeType',coalesce(a.stored_mime_type,a.provider_mime_type),'status',a.processing_status,'scanStatus',a.scan_status,'size',coalesce(a.stored_size,a.provider_file_size)) ORDER BY a.created_at) FROM message_attachments a WHERE a.message_id=m.id AND a.organization_id=m.organization_id),'[]'::jsonb) attachments FROM messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN contacts ct ON ct.id=m.contact_id AND ct.organization_id=m.organization_id WHERE m.organization_id=${input.organizationId}::uuid AND m.conversation_id=${input.conversationId}::uuid AND COALESCE(m.provider_timestamp,m.sent_at)<${input.at} ORDER BY COALESCE(m.provider_timestamp,m.sent_at) DESC,m.id DESC LIMIT 20`
        : this.sql<Milestone5Row[]>`
        SELECT m.*,COALESCE(m.provider_timestamp,m.sent_at) display_at,COALESCE(u.full_name,CASE WHEN m.direction='inbound' THEN COALESCE(NULLIF(BTRIM(m.metadata->>'senderName'),''),NULLIF(BTRIM(ct.display_name),''),NULLIF(BTRIM(concat_ws(' ',ct.first_name,ct.last_name)),''),ct.normalized_phone,'Customer') ELSE 'Agent' END) sender_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'type',a.attachment_type,'filename',coalesce(a.stored_filename,a.provider_filename),'mimeType',coalesce(a.stored_mime_type,a.provider_mime_type),'status',a.processing_status,'scanStatus',a.scan_status,'size',coalesce(a.stored_size,a.provider_file_size)) ORDER BY a.created_at) FROM message_attachments a WHERE a.message_id=m.id AND a.organization_id=m.organization_id),'[]'::jsonb) attachments FROM messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN contacts ct ON ct.id=m.contact_id AND ct.organization_id=m.organization_id WHERE m.organization_id=${input.organizationId}::uuid AND m.conversation_id=${input.conversationId}::uuid AND COALESCE(m.provider_timestamp,m.sent_at)>=${input.at} ORDER BY COALESCE(m.provider_timestamp,m.sent_at),m.id LIMIT 21`;
    return base;
  }

  messageAttachments(input: {
    organizationId: string;
    messageId: string;
    restricted: boolean;
    userId: string;
  }) {
    return this.sql<
      Milestone5Row[]
    >`SELECT a.* FROM message_attachments a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE a.message_id=${input.messageId}::uuid AND a.organization_id=${input.organizationId}::uuid AND m.organization_id=a.organization_id AND (${!input.restricted} OR EXISTS (SELECT 1 FROM channel_user_ownership cuo WHERE cuo.organization_id=c.organization_id AND cuo.channel_id=c.channel_id AND cuo.user_id=${input.userId}::uuid)) ORDER BY a.created_at`;
  }
}
