import crypto from "node:crypto";
import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;
export type FileRow = Record<string, unknown>;

export class FilesRepository {
  constructor(private readonly sql: Sql) {}

  async audit(input: {
    organizationId: string;
    userId: string;
    action: string;
    assetId?: string | null;
    metadata?: FileRow;
    ip?: string | null;
    userAgent?: string;
  }) {
    await this
      .sql`INSERT INTO file_audit_logs(organization_id,file_asset_id,user_id,action,metadata,ip_address,user_agent) VALUES(${input.organizationId}::uuid,${input.assetId ?? null}::uuid,${input.userId}::uuid,${input.action},${this.sql.json((input.metadata ?? {}) as never)},${input.ip ?? null}::inet,${input.userAgent ?? ""})`;
  }

  async emitEvent(input: {
    organizationId: string;
    userId: string;
    eventType: string;
    asset: FileRow;
    payload?: FileRow;
  }) {
    await this
      .sql`INSERT INTO automation_events(organization_id,event_type,aggregate_type,aggregate_id,conversation_id,correlation_id,origin,payload) VALUES(${input.organizationId}::uuid,${input.eventType},'file',${String(input.asset.id)}::uuid,${input.asset.conversation_id ? String(input.asset.conversation_id) : null}::uuid,gen_random_uuid(),'files.api',${this.sql.json({ fileAssetId: input.asset.id, actorUserId: input.userId, ...(input.payload ?? {}) } as never)})`;
  }

  async connection(organizationId: string, id: string) {
    return (
      (
        await this.sql<
          FileRow[]
        >`SELECT * FROM storage_connections WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid AND provider='google_drive'`
      )[0] ?? null
    );
  }

  async saveRefreshedCredentials(input: {
    organizationId: string;
    connectionId: string;
    encrypted: string;
    expiresAt: string;
  }) {
    await this
      .sql`UPDATE storage_connections SET encrypted_credentials=${input.encrypted},token_expires_at=${input.expiresAt}::timestamptz,status='connected',last_error_code=NULL,updated_at=now() WHERE id=${input.connectionId}::uuid AND organization_id=${input.organizationId}::uuid`;
  }

  async markConnectionError(
    organizationId: string,
    connectionId: string,
    code: string,
    healthCheck = false,
  ) {
    await this
      .sql`UPDATE storage_connections SET status='error',last_error_code=${code},last_health_check_at=CASE WHEN ${healthCheck} THEN now() ELSE last_health_check_at END,updated_at=now() WHERE id=${connectionId}::uuid AND organization_id=${organizationId}::uuid`;
  }

  async createOAuthState(input: {
    organizationId: string;
    userId: string;
    stateHash: string;
    connectionId?: string;
  }) {
    await this
      .sql`INSERT INTO storage_oauth_states(organization_id,user_id,provider,state_hash,connection_id,redirect_path,expires_at) VALUES(${input.organizationId}::uuid,${input.userId}::uuid,'google_drive',${input.stateHash},${input.connectionId ?? null}::uuid,'/app/files',now()+interval '10 minutes')`;
  }

  async consumeOAuthState(stateHash: string) {
    return (
      (
        await this.sql<
          FileRow[]
        >`UPDATE storage_oauth_states SET consumed_at=now() WHERE state_hash=${stateHash} AND provider='google_drive' AND consumed_at IS NULL AND expires_at>now() RETURNING *`
      )[0] ?? null
    );
  }

  async saveOAuthConnection(input: {
    state: FileRow;
    accountEmail: string | null;
    encrypted: string;
    scopes: string[];
    expiresAt: string;
    displayName: string;
  }) {
    return this.sql.begin(async (tx) => {
      const organizationId = String(input.state.organization_id);
      const requestedConnectionId = input.state.connection_id
        ? String(input.state.connection_id)
        : null;
      const lockIdentity = String(
        input.accountEmail ?? requestedConnectionId ?? input.state.id,
      ).toLowerCase();
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`google_drive:${organizationId}:${lockIdentity}`},0))`;

      const existing =
        !requestedConnectionId && input.accountEmail
          ? (
              await tx<
                FileRow[]
              >`SELECT id FROM storage_connections WHERE organization_id=${organizationId}::uuid AND provider='google_drive' AND lower(account_email)=lower(${input.accountEmail}) AND status <> 'disconnected' ORDER BY updated_at DESC,created_at DESC LIMIT 1 FOR UPDATE`
            )[0]
          : null;
      const targetConnectionId =
        requestedConnectionId ?? (existing?.id ? String(existing.id) : null);
      const rows = targetConnectionId
        ? await tx<
            FileRow[]
          >`UPDATE storage_connections SET display_name=${input.displayName},account_email=${input.accountEmail},encrypted_credentials=${input.encrypted},granted_scopes=${tx.json(input.scopes as never)},status='connected',token_expires_at=${input.expiresAt}::timestamptz,disconnected_at=NULL,last_error_code=NULL,last_health_check_at=NULL,updated_at=now() WHERE id=${targetConnectionId}::uuid AND organization_id=${organizationId}::uuid RETURNING id`
        : await tx<
            FileRow[]
          >`INSERT INTO storage_connections(organization_id,provider,display_name,account_email,encrypted_credentials,granted_scopes,status,token_expires_at,created_by) VALUES(${organizationId}::uuid,'google_drive',${input.displayName},${input.accountEmail},${input.encrypted},${tx.json(input.scopes as never)},'connected',${input.expiresAt}::timestamptz,${String(input.state.user_id)}::uuid) RETURNING id`;
      const connectionId = String(rows[0]!.id);
      const disconnectedDuplicates = input.accountEmail
        ? await tx<
            FileRow[]
          >`UPDATE storage_connections SET encrypted_credentials=NULL,status='disconnected',token_expires_at=NULL,disconnected_at=now(),updated_at=now() WHERE organization_id=${organizationId}::uuid AND provider='google_drive' AND lower(account_email)=lower(${input.accountEmail}) AND id <> ${connectionId}::uuid AND status <> 'disconnected' RETURNING id`
        : [];
      await tx`INSERT INTO file_audit_logs(organization_id,user_id,action,metadata) VALUES(${organizationId}::uuid,${String(input.state.user_id)}::uuid,'CONNECT_PROVIDER',${tx.json({ provider: "google_drive", connectionId, reusedExisting: Boolean(existing), disconnectedDuplicateCount: disconnectedDuplicates.length } as never)})`;
      return rows[0]!;
    });
  }

  listConnections(organizationId: string) {
    return this.sql<
      FileRow[]
    >`SELECT id,provider,display_name,account_email,root_folder_id,shared_drive_id,granted_scopes,configuration,status,last_health_check_at,last_synced_at,token_expires_at,last_error_code,created_at,updated_at,disconnected_at FROM storage_connections WHERE organization_id=${organizationId}::uuid AND provider='google_drive' ORDER BY created_at DESC`;
  }

  async markConnectionHealthy(organizationId: string, connectionId: string) {
    await this
      .sql`UPDATE storage_connections SET status='connected',last_health_check_at=now(),last_error_code=NULL,updated_at=now() WHERE id=${connectionId}::uuid AND organization_id=${organizationId}::uuid`;
  }

  async updateConnection(input: {
    organizationId: string;
    id: string;
    displayName: string;
    rootFolderId: string | null;
    sharedDriveId: string | null;
    configuration: FileRow;
  }) {
    return (
      (
        await this.sql<
          FileRow[]
        >`UPDATE storage_connections SET display_name=${input.displayName},root_folder_id=${input.rootFolderId},shared_drive_id=${input.sharedDriveId},configuration=${this.sql.json(input.configuration as never)},updated_at=now() WHERE id=${input.id}::uuid AND organization_id=${input.organizationId}::uuid RETURNING id,display_name,root_folder_id,shared_drive_id,configuration,status`
      )[0] ?? null
    );
  }

  async disconnect(organizationId: string, connectionId: string) {
    await this
      .sql`UPDATE storage_connections SET encrypted_credentials=NULL,status='disconnected',token_expires_at=NULL,disconnected_at=now(),updated_at=now() WHERE id=${connectionId}::uuid AND organization_id=${organizationId}::uuid`;
  }

  listFiles(input: {
    organizationId: string;
    q?: string;
    category?: string;
    status?: string;
    contactId?: string;
    conversationId?: string;
    channelId?: string;
    connectionId?: string;
    trash: boolean;
    limit: number;
    offset: number;
  }) {
    const like = input.q ? `%${input.q}%` : null;
    return this.sql<
      FileRow[]
    >`SELECT f.*,c.display_name contact_name,ch.name channel_name,sc.display_name connection_name,COUNT(*) OVER() total_count FROM file_assets f LEFT JOIN contacts c ON c.id=f.contact_id AND c.organization_id=f.organization_id LEFT JOIN channels ch ON ch.id=f.channel_id AND ch.organization_id=f.organization_id LEFT JOIN storage_connections sc ON sc.id=f.provider_connection_id AND sc.organization_id=f.organization_id WHERE f.organization_id=${input.organizationId}::uuid AND ((${input.trash} AND f.deleted_at IS NOT NULL) OR (NOT ${input.trash} AND f.deleted_at IS NULL)) AND (${like}::text IS NULL OR f.sanitized_name ILIKE ${like} OR f.original_name ILIKE ${like}) AND (${input.category ?? null}::text IS NULL OR f.category=${input.category ?? null}) AND (${input.status ?? null}::text IS NULL OR f.status=${input.status ?? null}) AND (${input.contactId ?? null}::uuid IS NULL OR f.contact_id=${input.contactId ?? null}::uuid) AND (${input.conversationId ?? null}::uuid IS NULL OR f.conversation_id=${input.conversationId ?? null}::uuid) AND (${input.channelId ?? null}::uuid IS NULL OR f.channel_id=${input.channelId ?? null}::uuid) AND (${input.connectionId ?? null}::uuid IS NULL OR f.provider_connection_id=${input.connectionId ?? null}::uuid) ORDER BY f.created_at DESC,f.id DESC LIMIT ${input.limit} OFFSET ${input.offset}`;
  }

  async file(
    organizationId: string,
    id: string,
    mode: "any" | "active" | "ready" | "provider" = "any",
  ) {
    return (
      (
        await this.sql<
          FileRow[]
        >`SELECT f.*,c.display_name contact_name,ch.name channel_name FROM file_assets f LEFT JOIN contacts c ON c.id=f.contact_id AND c.organization_id=f.organization_id LEFT JOIN channels ch ON ch.id=f.channel_id AND ch.organization_id=f.organization_id WHERE f.id=${id}::uuid AND f.organization_id=${organizationId}::uuid AND (${mode === "any"} OR f.deleted_at IS NULL) AND (${mode !== "ready"} OR f.status='READY') AND (${mode !== "provider"} OR (f.provider_connection_id IS NOT NULL AND f.provider_file_id IS NOT NULL))`
      )[0] ?? null
    );
  }

  async relatedExists(
    organizationId: string,
    table: "contacts" | "conversations" | "channels",
    id: string,
  ) {
    return Boolean(
      (
        await this.sql.unsafe(
          `SELECT 1 FROM ${table} WHERE id=$1::uuid AND organization_id=$2::uuid`,
          [id, organizationId],
        )
      )[0],
    );
  }

  async createUploadedFile(input: {
    organizationId: string;
    userId: string;
    connectionId?: string;
    storageKey: string;
    contactId?: string;
    conversationId?: string;
    channelId?: string;
    filename: string;
    mimeType: string;
    extension: string | null;
    size: number;
    sha256: string;
    category: string;
    status: string;
  }) {
    return this.sql.begin(async (tx) => {
      const asset = (
        await tx<
          FileRow[]
        >`INSERT INTO file_assets(organization_id,provider,provider_connection_id,internal_storage_key,contact_id,conversation_id,channel_id,original_name,sanitized_name,mime_type,extension,size_bytes,checksum_sha256,category,direction,source,status,created_by) VALUES(${input.organizationId}::uuid,${input.connectionId ? "google_drive" : "internal"},${input.connectionId ?? null}::uuid,${input.storageKey},${input.contactId ?? null}::uuid,${input.conversationId ?? null}::uuid,${input.channelId ?? null}::uuid,${input.filename},${input.filename},${input.mimeType},${input.extension},${input.size},${input.sha256},${input.category},'internal','user_upload',${input.status},${input.userId}::uuid) RETURNING *`
      )[0]!;
      await tx`INSERT INTO file_versions(organization_id,file_asset_id,version_number,internal_storage_key,checksum_sha256,size_bytes,status,created_by) VALUES(${input.organizationId}::uuid,${String(asset.id)}::uuid,1,${input.storageKey},${input.sha256},${input.size},${input.status},${input.userId}::uuid)`;
      if (input.connectionId)
        await tx`INSERT INTO file_processing_jobs(organization_id,file_asset_id,connection_id,job_type,payload) VALUES(${input.organizationId}::uuid,${String(asset.id)}::uuid,${input.connectionId}::uuid,'storage.upload','{}') ON CONFLICT(file_asset_id,job_type) DO NOTHING`;
      return asset;
    });
  }

  async updateFile(input: {
    organizationId: string;
    id: string;
    name: string;
    category: string;
    providerFolderId: string | null;
    metadata: FileRow;
    jobType: string;
    jobPayload: FileRow;
  }) {
    return this.sql.begin(async (tx) => {
      const current = (
        await tx<
          FileRow[]
        >`SELECT * FROM file_assets WHERE id=${input.id}::uuid AND organization_id=${input.organizationId}::uuid AND deleted_at IS NULL FOR UPDATE`
      )[0];
      if (!current) return null;
      const updated = (
        await tx<
          FileRow[]
        >`UPDATE file_assets SET sanitized_name=${input.name},category=${input.category},provider_folder_id=${input.providerFolderId},metadata=${tx.json(input.metadata as never)},updated_at=now() WHERE id=${input.id}::uuid AND organization_id=${input.organizationId}::uuid RETURNING *`
      )[0]!;
      if (current.provider_connection_id && current.provider_file_id)
        await tx`INSERT INTO file_processing_jobs(organization_id,file_asset_id,connection_id,job_type,payload) VALUES(${input.organizationId}::uuid,${input.id}::uuid,${String(current.provider_connection_id)}::uuid,${input.jobType},${tx.json(input.jobPayload as never)}) ON CONFLICT(file_asset_id,job_type) DO UPDATE SET payload=excluded.payload,status='pending',next_attempt_at=now(),updated_at=now()`;
      return updated;
    });
  }

  async operateFile(
    organizationId: string,
    id: string,
    operation: "archive" | "delete" | "restore",
  ) {
    return this.sql.begin(async (tx) => {
      const row = (
        await tx<
          FileRow[]
        >`UPDATE file_assets SET status=${operation === "archive" ? "ARCHIVED" : operation === "delete" ? "DELETED" : "READY"},archived_at=CASE WHEN ${operation}='archive' THEN now() WHEN ${operation}='restore' THEN NULL ELSE archived_at END,deleted_at=CASE WHEN ${operation}='delete' THEN now() WHEN ${operation}='restore' THEN NULL ELSE deleted_at END,updated_at=now() WHERE id=${id}::uuid AND organization_id=${organizationId}::uuid RETURNING *`
      )[0];
      if (row?.provider_connection_id && row.provider_file_id)
        await tx`INSERT INTO file_processing_jobs(organization_id,file_asset_id,connection_id,job_type,payload) VALUES(${organizationId}::uuid,${id}::uuid,${String(row.provider_connection_id)}::uuid,${`storage.${operation}`},'{}') ON CONFLICT(file_asset_id,job_type) DO UPDATE SET status='pending',next_attempt_at=now(),updated_at=now()`;
      return row ?? null;
    });
  }

  async cacheInternalObject(input: {
    organizationId: string;
    id: string;
    key: string;
    sha256: string;
    size: number;
  }) {
    await this
      .sql`UPDATE file_assets SET internal_storage_key=${input.key},checksum_sha256=COALESCE(checksum_sha256,${input.sha256}),size_bytes=COALESCE(size_bytes,${input.size}),updated_at=now() WHERE id=${input.id}::uuid AND organization_id=${input.organizationId}::uuid`;
  }

  async conversationForSend(input: {
    organizationId: string;
    conversationId: string;
    userId: string;
    enforceOwnership: boolean;
  }) {
    return (
      (
        await this.sql<
          FileRow[]
        >`SELECT c.*,ch.status channel_status FROM conversations c JOIN channels ch ON ch.id=c.channel_id AND ch.organization_id=c.organization_id WHERE c.id=${input.conversationId}::uuid AND c.organization_id=${input.organizationId}::uuid AND (NOT ${input.enforceOwnership} OR EXISTS(SELECT 1 FROM channel_user_ownership o WHERE o.organization_id=c.organization_id AND o.channel_id=c.channel_id AND o.user_id=${input.userId}::uuid))`
      )[0] ?? null
    );
  }

  async queueWhatsAppSend(input: {
    organizationId: string;
    userId: string;
    asset: FileRow;
    conversation: FileRow;
    conversationId: string;
    clientMessageId?: string;
    internalKey: string;
  }) {
    return this.sql.begin(async (tx) => {
      const mime = String(input.asset.mime_type),
        messageType = mime.startsWith("image/")
          ? "image"
          : mime.startsWith("video/")
            ? "video"
            : mime.startsWith("audio/")
              ? "audio"
              : "document";
      const message = (
        await tx<
          FileRow[]
        >`INSERT INTO messages(organization_id,conversation_id,channel_id,contact_id,client_message_id,direction,type,status,body,sender_id,metadata) VALUES(${input.organizationId}::uuid,${input.conversationId}::uuid,${String(input.conversation.channel_id)}::uuid,${String(input.conversation.contact_id)}::uuid,${input.clientMessageId ?? crypto.randomUUID()}::uuid,'outbound',${messageType},'pending',${String(input.asset.sanitized_name)},${input.userId}::uuid,${tx.json({ fileAssetId: input.asset.id } as never)}) RETURNING id`
      )[0]!;
      const attachment = (
        await tx<
          FileRow[]
        >`INSERT INTO message_attachments(organization_id,message_id,channel_id,provider,provider_filename,attachment_type,storage_provider,storage_key,stored_mime_type,stored_filename,stored_size,stored_sha256,processing_status,scan_status,stored_at,file_asset_id) VALUES(${input.organizationId}::uuid,${String(message.id)}::uuid,${String(input.conversation.channel_id)}::uuid,'files',${String(input.asset.sanitized_name)},${mime.startsWith("image/") ? "image" : "document"},'files',${input.internalKey},${mime},${String(input.asset.sanitized_name)},${input.asset.size_bytes == null ? null : Number(input.asset.size_bytes)},${input.asset.checksum_sha256 ? String(input.asset.checksum_sha256) : null},'stored','clean',now(),${String(input.asset.id)}::uuid) RETURNING id`
      )[0]!;
      await tx`INSERT INTO outbox_jobs(organization_id,aggregate_type,aggregate_id,job_type,payload) VALUES(${input.organizationId}::uuid,'message',${String(message.id)}::uuid,'message.send',${tx.json({ traceId: crypto.randomUUID(), attachmentId: attachment.id, fileAssetId: input.asset.id } as never)})`;
      await tx`UPDATE file_assets SET conversation_id=${input.conversationId}::uuid,message_id=${String(message.id)}::uuid,channel_id=${String(input.conversation.channel_id)}::uuid,direction='outbound',updated_at=now() WHERE id=${String(input.asset.id)}::uuid AND organization_id=${input.organizationId}::uuid`;
      return { messageId: message.id, attachmentId: attachment.id };
    });
  }

  async acceptDriveNotification(input: {
    channelId: string;
    tokenHash: string;
    resourceId: string;
    messageNumber: string;
    resourceState: unknown;
  }) {
    return this.sql.begin(async (tx) => {
      const channel = (
        await tx<
          FileRow[]
        >`UPDATE storage_sync_channels SET last_notification_at=now(),updated_at=now() WHERE channel_id=${input.channelId} AND channel_token_hash=${input.tokenHash} AND status='active' AND (${input.resourceId}='' OR resource_id=${input.resourceId}) RETURNING *`
      )[0];
      if (!channel) return null;
      await tx`INSERT INTO storage_sync_jobs(organization_id,connection_id,sync_channel_id,job_type,idempotency_key,payload) VALUES(${String(channel.organization_id)}::uuid,${String(channel.connection_id)}::uuid,${String(channel.id)}::uuid,'changes.list',${`${input.channelId}:${input.messageNumber}`},${tx.json({ resourceState: input.resourceState ?? null } as never)}) ON CONFLICT(connection_id,idempotency_key) DO NOTHING`;
      return channel;
    });
  }

  async operationsHealth(organizationId: string) {
    const [connections, jobs, files, auditRows] = await Promise.all([
      this.sql<
        FileRow[]
      >`SELECT id,display_name,account_email,status,last_health_check_at,last_synced_at,last_error_code FROM storage_connections WHERE organization_id=${organizationId}::uuid ORDER BY created_at DESC`,
      this.sql<
        FileRow[]
      >`SELECT status,count(*)::int count FROM file_processing_jobs WHERE organization_id=${organizationId}::uuid GROUP BY status`,
      this.sql<
        FileRow[]
      >`SELECT count(*) FILTER(WHERE status='QUARANTINED')::int quarantined,count(*) FILTER(WHERE provider_file_id IS NULL AND provider='google_drive')::int orphaned,count(*) FILTER(WHERE deleted_at IS NULL)::int active FROM file_assets WHERE organization_id=${organizationId}::uuid`,
      this.sql<
        FileRow[]
      >`SELECT action,count(*)::int count FROM file_audit_logs WHERE organization_id=${organizationId}::uuid AND created_at>now()-interval '30 days' GROUP BY action`,
    ]);
    return {
      connections,
      jobs: Object.fromEntries(
        jobs.map((row) => [String(row.status), Number(row.count)]),
      ),
      files: files[0] ?? {},
      actions30d: Object.fromEntries(
        auditRows.map((row) => [String(row.action), Number(row.count)]),
      ),
    };
  }
}
