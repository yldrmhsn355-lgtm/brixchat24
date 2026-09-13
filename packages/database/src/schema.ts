import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  inet,
  integer,
  foreignKey,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const storageConnections = pgTable(
  "storage_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    accountEmail: text("account_email"),
    encryptedCredentials: text("encrypted_credentials"),
    rootFolderId: text("root_folder_id"),
    sharedDriveId: text("shared_drive_id"),
    grantedScopes: jsonb("granted_scopes").notNull().default([]),
    configuration: jsonb("configuration").notNull().default({}),
    status: text("status").notNull().default("connected"),
    lastHealthCheckAt: timestamp("last_health_check_at", {
      withTimezone: true,
    }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (t) => [
    index("storage_connections_org_status_idx").on(
      t.organizationId,
      t.status,
      t.provider,
    ),
  ],
);

export const storageOauthStates = pgTable(
  "storage_oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull(),
    connectionId: uuid("connection_id").references(
      () => storageConnections.id,
      { onDelete: "cascade" },
    ),
    redirectPath: text("redirect_path"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("storage_oauth_states_hash_uq").on(t.stateHash),
    index("storage_oauth_states_expiry_idx").on(t.provider, t.expiresAt),
  ],
);

export const fileAssets = pgTable(
  "file_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerConnectionId: uuid("provider_connection_id").references(
      () => storageConnections.id,
      { onDelete: "set null" },
    ),
    providerFileId: text("provider_file_id"),
    providerFolderId: text("provider_folder_id"),
    internalStorageKey: text("internal_storage_key"),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    treatmentPlanId: uuid("treatment_plan_id"),
    whatsappMessageId: text("whatsapp_message_id"),
    providerMediaId: text("provider_media_id"),
    originalName: text("original_name").notNull(),
    sanitizedName: text("sanitized_name").notNull(),
    mimeType: text("mime_type").notNull(),
    extension: text("extension"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksumSha256: text("checksum_sha256"),
    category: text("category").notNull().default("other"),
    direction: text("direction").notNull().default("internal"),
    source: text("source").notNull(),
    status: text("status").notNull().default("PENDING"),
    visibility: text("visibility").notNull().default("private"),
    metadata: jsonb("metadata").notNull().default({}),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("file_assets_whatsapp_media_uq").on(
      t.organizationId,
      t.whatsappMessageId,
      t.providerMediaId,
    ),
    index("file_assets_org_status_created_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    index("file_assets_org_contact_category_idx").on(
      t.organizationId,
      t.contactId,
      t.category,
      t.createdAt,
    ),
    index("file_assets_org_checksum_idx").on(
      t.organizationId,
      t.contactId,
      t.checksumSha256,
    ),
  ],
);

export const contactStorageFolders = pgTable(
  "contact_storage_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    providerConnectionId: uuid("provider_connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "cascade" }),
    providerFolderId: text("provider_folder_id").notNull(),
    folderName: text("folder_name").notNull(),
    categoryFolders: jsonb("category_folders").notNull().default({}),
    syncStatus: text("sync_status").notNull().default("ready"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("contact_storage_folders_org_contact_connection_uq").on(
      t.organizationId,
      t.contactId,
      t.providerConnectionId,
    ),
  ],
);

export const fileVersions = pgTable(
  "file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fileAssetId: uuid("file_asset_id")
      .notNull()
      .references(() => fileAssets.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    providerFileId: text("provider_file_id"),
    internalStorageKey: text("internal_storage_key"),
    checksumSha256: text("checksum_sha256"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: text("status").notNull().default("READY"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("file_versions_asset_version_uq").on(
      t.fileAssetId,
      t.versionNumber,
    ),
  ],
);

export const storageSyncChannels = pgTable(
  "storage_sync_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    channelTokenHash: text("channel_token_hash").notNull(),
    resourceId: text("resource_id"),
    pageToken: text("page_token"),
    expirationAt: timestamp("expiration_at", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    lastNotificationAt: timestamp("last_notification_at", {
      withTimezone: true,
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("storage_sync_channels_connection_channel_uq").on(
      t.connectionId,
      t.channelId,
    ),
    index("storage_sync_channels_renew_idx").on(t.status, t.expirationAt),
  ],
);

export const storageSyncJobs = pgTable(
  "storage_sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => storageConnections.id, { onDelete: "cascade" }),
    syncChannelId: uuid("sync_channel_id").references(
      () => storageSyncChannels.id,
      { onDelete: "set null" },
    ),
    jobType: text("job_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("storage_sync_jobs_connection_key_uq").on(
      t.connectionId,
      t.idempotencyKey,
    ),
    index("storage_sync_jobs_claim_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const fileAuditLogs = pgTable(
  "file_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fileAssetId: uuid("file_asset_id").references(() => fileAssets.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("file_audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const fileProcessingJobs = pgTable(
  "file_processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fileAssetId: uuid("file_asset_id")
      .notNull()
      .references(() => fileAssets.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(
      () => storageConnections.id,
      { onDelete: "set null" },
    ),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("file_processing_jobs_asset_type_uq").on(
      t.fileAssetId,
      t.jobType,
    ),
    index("file_processing_jobs_claim_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const memberRole = pgEnum("member_role", [
  "owner",
  "admin",
  "team_lead",
  "agent",
  "viewer",
]);
export const conversationStatus = pgEnum("conversation_status", [
  "open",
  "waiting",
  "closed",
  "archived",
  "spam",
  "snoozed",
]);
export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);
export const messageStatus = pgEnum("message_status", [
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    fullName: text("full_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    firstName: text("first_name"),
    lastName: text("last_name"),
    avatarUrl: text("avatar_url"),
    locale: text("locale").notNull().default("tr"),
    timezone: text("timezone").notNull().default("Europe/Istanbul"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    notificationPreferences: jsonb("notification_preferences")
      .notNull()
      .default({}),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    timezone: text("timezone").notNull().default("Europe/Istanbul"),
    defaultLocale: text("default_locale").notNull().default("tr"),
    industry: text("industry"),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true,
    }),
    operationalStatus: text("operational_status").notNull().default("active"),
    activationStatus: text("activation_status").notNull().default("approved"),
    statusReason: text("status_reason"),
    activationRequestedAt: timestamp("activation_requested_at", {
      withTimezone: true,
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: uuid("activated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    statusChangedBy: uuid("status_changed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)],
);
export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("organization_members_org_user_uq").on(
      t.organizationId,
      t.userId,
    ),
    index("organization_members_user_idx").on(t.userId),
  ],
);
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ...auditColumns,
  },
  (t) => [index("teams_org_idx").on(t.organizationId)],
);
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalAccountId: text("external_account_id"),
    displayName: text("display_name").notNull(),
    encryptedCredentials: text("encrypted_credentials"),
    credentialVersion: integer("credential_version").notNull().default(1),
    status: text("status").notNull().default("active"),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
    }),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("provider_accounts_org_provider_external_uq").on(
      t.organizationId,
      t.provider,
      t.externalAccountId,
    ),
    index("provider_accounts_org_idx").on(t.organizationId, t.provider),
  ],
);
export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicId: uuid("public_id").notNull().defaultRandom(),
    providerAccountId: uuid("provider_account_id").references(
      () => providerAccounts.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    platform: text("platform"),
    externalChannelId: text("external_channel_id"),
    internalName: text("internal_name"),
    description: text("description"),
    connectionStatus: text("connection_status").notNull().default("ACTIVE"),
    healthState: text("health_state").notNull().default("UNKNOWN"),
    healthStatus: text("health_status")
      .notNull()
      .default("configuration_required"),
    healthCode: text("health_code"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    providerProfile: jsonb("provider_profile").notNull().default({}),
    lastWebhookResult: text("last_webhook_result"),
    identity: jsonb("identity").notNull().default({}),
    phoneNumber: text("phone_number"),
    phoneNumberId: text("phone_number_id"),
    businessAccountId: text("business_account_id"),
    avatarUrl: text("avatar_url"),
    defaultLanguage: text("default_language").notNull().default("tr"),
    timezone: text("timezone").notNull().default("Europe/Istanbul"),
    capabilities: jsonb("capabilities").notNull().default([]),
    configuration: jsonb("configuration").notNull().default({}),
    credentialsEncrypted: text("credentials_encrypted"),
    verifyTokenHash: text("verify_token_hash"),
    status: text("status").notNull().default("connected"),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    lastSuccessfulMessageAt: timestamp("last_successful_message_at", {
      withTimezone: true,
    }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastHealthCheckAt: timestamp("last_health_check_at", {
      withTimezone: true,
    }),
    lastHealthError: text("last_health_error"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("channels_org_idx").on(t.organizationId),
    uniqueIndex("channels_public_id_uq").on(t.publicId),
  ],
);
export const whatsappWebSessions = pgTable(
  "whatsapp_web_sessions",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channels.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("initializing"),
    encryptedCredentials: text("encrypted_credentials"),
    encryptedQr: text("encrypted_qr"),
    qrExpiresAt: timestamp("qr_expires_at", { withTimezone: true }),
    phoneNumber: text("phone_number"),
    pushName: text("push_name"),
    deviceInfo: jsonb("device_info").notNull().default({}),
    assignedWorkerId: text("assigned_worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    restartAttempts: integer("restart_attempts").notNull().default(0),
    nextRestartAt: timestamp("next_restart_at", { withTimezone: true }),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    lastDisconnectedAt: timestamp("last_disconnected_at", {
      withTimezone: true,
    }),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    index("wa_web_sessions_org_status_idx").on(
      t.organizationId,
      t.status,
      t.nextRestartAt,
    ),
    index("wa_web_sessions_lease_idx").on(t.leaseExpiresAt),
  ],
);
export const whatsappWebSignalKeys = pgTable(
  "whatsapp_web_signal_keys",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    keyType: text("key_type").notNull(),
    keyId: text("key_id").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "wa_web_signal_keys_pk",
      columns: [t.channelId, t.keyType, t.keyId],
    }),
    index("wa_web_signal_keys_org_channel_idx").on(
      t.organizationId,
      t.channelId,
    ),
  ],
);
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    displayName: text("display_name"),
    normalizedPhone: text("normalized_phone").notNull(),
    email: text("email"),
    profilePictureUrl: text("profile_picture_url"),
    language: text("language"),
    country: text("country"),
    customFields: jsonb("custom_fields").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("contacts_org_phone_uq").on(
      t.organizationId,
      t.normalizedPhone,
    ),
  ],
);
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    assigneeId: uuid("assignee_id").references(() => users.id),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    status: conversationStatus("status").notNull().default("open"),
    priority: text("priority").notNull().default("normal"),
    stage: text("stage").notNull().default("Yeni Lead"),
    lastMessageId: uuid("last_message_id"),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    customerServiceWindowExpiresAt: timestamp(
      "customer_service_window_expires_at",
      { withTimezone: true },
    ),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    mutedUntil: timestamp("muted_until", { withTimezone: true }),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    operationVersion: integer("operation_version").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    index("conversations_org_status_idx").on(t.organizationId, t.status),
    index("conversations_org_assignee_idx").on(t.organizationId, t.assigneeId),
    index("conversations_last_message_idx").on(
      t.organizationId,
      t.lastMessageAt,
    ),
    uniqueIndex("conversations_active_identity_uq")
      .on(t.organizationId, t.channelId, t.contactId, t.status)
      .where(sql`status IN ('open','waiting')`),
    index("conversations_identity_status_idx")
      .on(t.organizationId, t.channelId, t.contactId, t.status)
      .where(sql`status NOT IN ('open','waiting')`),
  ],
);
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => channels.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    clientMessageId: uuid("client_message_id"),
    providerMessageId: text("provider_message_id"),
    providerReplyToMessageId: text("provider_reply_to_message_id"),
    replyToMessageId: uuid("reply_to_message_id"),
    direction: messageDirection("direction").notNull(),
    type: text("type").notNull().default("text"),
    status: messageStatus("status").notNull().default("pending"),
    body: text("body").notNull(),
    senderId: uuid("sender_id").references(() => users.id),
    providerTimestamp: timestamp("provider_timestamp", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default({}),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("messages_org_client_id_uq").on(
      t.organizationId,
      t.clientMessageId,
    ),
    uniqueIndex("messages_channel_provider_id_uq").on(
      t.channelId,
      t.providerMessageId,
    ),
    index("messages_conversation_sent_idx").on(t.conversationId, t.sentAt),
  ],
);
export const whatsappWebMessageMutations = pgTable(
  "whatsapp_web_message_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    eventProviderMessageId: text("event_provider_message_id").notNull(),
    targetProviderMessageId: text("target_provider_message_id").notNull(),
    mutationType: text("mutation_type").notNull(),
    messageType: text("message_type").notNull(),
    body: text("body").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    providerTimestamp: timestamp("provider_timestamp", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("pending"),
    appliedMessageId: uuid("applied_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("whatsapp_web_message_mutations_event_uq").on(
      t.channelId,
      t.eventProviderMessageId,
    ),
    index("whatsapp_web_message_mutations_target_idx").on(
      t.organizationId,
      t.channelId,
      t.targetProviderMessageId,
      t.status,
    ),
  ],
);
export const whatsappWebIgnoredMessages = pgTable(
  "whatsapp_web_ignored_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    rawType: text("raw_type").notNull(),
    reason: text("reason").notNull(),
    direction: text("direction").notNull(),
    providerTimestamp: timestamp("provider_timestamp", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("whatsapp_web_ignored_messages_event_uq").on(
      t.channelId,
      t.providerMessageId,
    ),
    index("whatsapp_web_ignored_messages_type_idx").on(
      t.organizationId,
      t.channelId,
      t.rawType,
      t.providerTimestamp,
    ),
  ],
);
export const whatsappWebInboundRetries = pgTable(
  "whatsapp_web_inbound_retries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    message: jsonb("message").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(10),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("whatsapp_web_inbound_retries_event_uq").on(
      t.channelId,
      t.providerMessageId,
    ),
    index("whatsapp_web_inbound_retries_claim_idx")
      .on(t.status, t.nextAttemptAt)
      .where(sql`status IN ('pending','processing')`),
  ],
);
export const providerWebhookEvents = pgTable(
  "provider_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    provider: text("provider").notNull(),
    providerEventKey: text("provider_event_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    signatureValid: boolean("signature_valid").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_provider_event_uq").on(t.provider, t.providerEventKey),
    index("webhook_status_idx").on(t.status, t.receivedAt),
  ],
);
export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    aggregateType: text("aggregate_type").notNull().default("message"),
    aggregateId: uuid("aggregate_id").notNull(),
    jobType: text("job_type").notNull().default("message.send"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("outbox_status_attempt_idx").on(t.status, t.nextAttemptAt),
    index("outbox_org_status_idx").on(t.organizationId, t.status),
  ],
);
export const messageStatusEvents = pgTable(
  "message_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id"),
    status: messageStatus("status").notNull(),
    providerTimestamp: timestamp("provider_timestamp", { withTimezone: true }),
    payload: jsonb("payload").notNull().default({}),
    eventKey: text("event_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_status_event_key_uq").on(t.organizationId, t.eventKey),
  ],
);
export const pendingMessageStatusEvents = pgTable(
  "pending_message_status_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    status: messageStatus("status").notNull(),
    providerTimestamp: timestamp("provider_timestamp", { withTimezone: true }),
    payload: jsonb("payload").notNull().default({}),
    eventKey: text("event_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("pending_message_status_event_uq").on(
      t.organizationId,
      t.eventKey,
    ),
    index("pending_message_status_lookup_idx").on(
      t.organizationId,
      t.providerMessageId,
      t.createdAt,
    ),
    index("pending_message_status_age_idx").on(t.createdAt),
  ],
);
export const messageFlowEvents = pgTable(
  "message_flow_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    traceId: uuid("trace_id").notNull(),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("message_flow_trace_idx").on(t.traceId),
    index("message_flow_message_idx").on(t.messageId, t.createdAt),
  ],
);
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const userCredentials = pgTable(
  "user_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("user_credentials_user_uq").on(t.userId)],
);
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    replacedById: uuid("replaced_by_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_sessions_token_uq").on(t.tokenHash),
    index("user_sessions_user_idx").on(t.userId, t.expiresAt),
    index("user_sessions_workspace_idx").on(t.userId, t.organizationId),
    index("user_sessions_organization_idx").on(t.organizationId),
    index("user_sessions_family_idx").on(t.familyId),
  ],
);
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("password_reset_tokens_hash_uq").on(t.tokenHash)],
);
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("email_verification_tokens_hash_uq").on(t.tokenHash)],
);
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    normalizedEmailHash: text("normalized_email_hash").notNull(),
    ipHash: text("ip_hash"),
    success: boolean("success").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("login_attempts_lookup_idx").on(t.normalizedEmailHash, t.createdAt),
  ],
);
export const userSecurityEvents = pgTable(
  "user_security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("user_security_events_user_idx").on(t.userId, t.createdAt)],
);
export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("organization_invitations_token_uq").on(t.tokenHash),
    index("organization_invitations_org_idx").on(t.organizationId, t.createdAt),
  ],
);
export const onboardingProgress = pgTable("onboarding_progress", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  currentStep: integer("current_step").notNull().default(1),
  state: jsonb("state").notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("team_members_team_user_uq").on(t.teamId, t.userId),
    index("team_members_org_user_idx").on(t.organizationId, t.userId),
  ],
);

export const messageTemplateFamilies = pgTable(
  "message_template_families",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessAccountId: text("business_account_id").notNull(),
    normalizedName: text("normalized_name").notNull(),
    defaultLanguage: text("default_language").notNull(),
    fallbackLanguage: text("fallback_language"),
    internalLabel: text("internal_label"),
    folder: text("folder"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("message_template_families_identity_uq").on(
      t.organizationId,
      t.businessAccountId,
      t.normalizedName,
    ),
  ],
);

export const messageTemplates = pgTable(
  "message_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerTemplateId: text("provider_template_id"),
    businessAccountId: text("business_account_id"),
    familyId: uuid("family_id").references(() => messageTemplateFamilies.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name"),
    language: text("language").notNull(),
    category: text("category").notNull(),
    previousCategory: text("previous_category"),
    status: text("status").notNull(),
    qualityScore: text("quality_score"),
    rejectionReason: text("rejection_reason"),
    headerType: text("header_type"),
    headerText: text("header_text"),
    bodyText: text("body_text").notNull(),
    footerText: text("footer_text"),
    buttons: jsonb("buttons"),
    components: jsonb("components").notNull().default([]),
    parameterFormat: text("parameter_format").notNull().default("positional"),
    providerPayload: jsonb("provider_payload").notNull().default({}),
    internalLabel: text("internal_label"),
    folder: text("folder"),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("message_templates_channel_name_language_uq").on(
      t.channelId,
      t.name,
      t.language,
    ),
    index("message_templates_org_idx").on(
      t.organizationId,
      t.status,
      t.language,
      t.category,
    ),
    index("message_templates_family_idx").on(
      t.organizationId,
      t.familyId,
      t.status,
      t.language,
    ),
  ],
);
export const messageTemplateChannels = pgTable(
  "message_template_channels",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_template_channels_template_channel_uq").on(
      t.templateId,
      t.channelId,
    ),
    index("message_template_channels_channel_idx").on(
      t.organizationId,
      t.channelId,
      t.templateId,
    ),
  ],
);
export const messageTemplateComponents = pgTable(
  "message_template_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    componentType: text("component_type").notNull(),
    position: integer("position").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_template_components_position_uq").on(
      t.templateId,
      t.componentType,
      t.position,
    ),
  ],
);
export const messageTemplateVariables = pgTable(
  "message_template_variables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    component: text("component").notNull(),
    position: integer("position").notNull(),
    variableName: text("variable_name").notNull(),
    internalKey: text("internal_key"),
    exampleValue: text("example_value"),
    source: text("source").notNull().default("manual"),
    defaultValue: text("default_value"),
    required: boolean("required").notNull().default(true),
    missingPolicy: text("missing_policy").notNull().default("block"),
    formatter: text("formatter"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_template_variables_position_uq").on(
      t.templateId,
      t.component,
      t.position,
    ),
  ],
);
export const templateSyncRuns = pgTable("template_sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  businessAccountId: text("business_account_id"),
  idempotencyKey: text("idempotency_key"),
  cursor: text("cursor"),
  pagesReceived: integer("pages_received").notNull().default(0),
  status: text("status").notNull(),
  templatesReceived: integer("templates_received").notNull().default(0),
  templatesCreated: integer("templates_created").notNull().default(0),
  templatesUpdated: integer("templates_updated").notNull().default(0),
  templatesArchived: integer("templates_archived").notNull().default(0),
  lastError: text("last_error"),
  errorDetails: jsonb("error_details").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const messageTemplateDependencies = pgTable(
  "message_template_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    dependencyType: text("dependency_type").notNull(),
    dependencyId: text("dependency_id").notNull(),
    dependencyLabel: text("dependency_label"),
    config: jsonb("config").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("message_template_dependencies_identity_uq").on(
      t.organizationId,
      t.templateId,
      t.dependencyType,
      t.dependencyId,
    ),
    index("message_template_dependencies_template_idx").on(
      t.organizationId,
      t.templateId,
      t.dependencyType,
    ),
  ],
);
export const messageTemplateVersions = pgTable(
  "message_template_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => messageTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    providerResult: jsonb("provider_result").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("message_template_versions_version_uq").on(
      t.templateId,
      t.version,
    ),
  ],
);
export const templateWebhookEvents = pgTable(
  "template_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessAccountId: text("business_account_id").notNull(),
    providerEventKey: text("provider_event_key").notNull(),
    field: text("field").notNull(),
    providerTemplateId: text("provider_template_id"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("processed"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("template_webhook_events_provider_event_uq").on(
      t.organizationId,
      t.providerEventKey,
    ),
  ],
);
export const templateSendEvents = pgTable("template_send_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => messageTemplates.id),
  messageId: uuid("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const quickReplyFolders = pgTable("quick_reply_folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  scope: text("scope").notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  ...auditColumns,
});
export const quickReplyCategories = pgTable(
  "quick_reply_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    scope: text("scope").notNull(),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict",
    }),
    color: text("color"),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    index("quick_reply_categories_list_idx").on(
      t.organizationId,
      t.scope,
      t.sortOrder,
    ),
  ],
);
export const quickReplies = pgTable(
  "quick_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    shortcut: text("shortcut").notNull(),
    normalizedShortcut: text("normalized_shortcut").notNull(),
    content: text("content").notNull(),
    contentFormat: text("content_format").notNull().default("text"),
    contentJson: jsonb("content_json").notNull().default({}),
    language: text("language").notNull().default("tr"),
    scope: text("scope").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "restrict",
    }),
    folderId: uuid("folder_id").references(() => quickReplyFolders.id, {
      onDelete: "set null",
    }),
    categoryId: uuid("category_id").references(() => quickReplyCategories.id, {
      onDelete: "set null",
    }),
    isActive: boolean("is_active").notNull().default(true),
    status: text("status").notNull().default("active"),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    familyKey: text("family_key").notNull(),
    fallbackLanguage: text("fallback_language"),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [index("quick_replies_org_idx").on(t.organizationId, t.isActive)],
);
export const quickReplyTags = pgTable(
  "quick_reply_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    color: text("color"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...auditColumns,
  },
  (t) => [index("quick_reply_tags_org_idx").on(t.organizationId)],
);
export const quickReplyTagAssignments = pgTable(
  "quick_reply_tag_assignments",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quickReplyId: uuid("quick_reply_id")
      .notNull()
      .references(() => quickReplies.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => quickReplyTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.quickReplyId, t.tagId] })],
);
export const quickReplyFavorites = pgTable(
  "quick_reply_favorites",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quickReplyId: uuid("quick_reply_id")
      .notNull()
      .references(() => quickReplies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.quickReplyId, t.userId] })],
);
export const quickReplyVariables = pgTable(
  "quick_reply_variables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quickReplyId: uuid("quick_reply_id")
      .notNull()
      .references(() => quickReplies.id, { onDelete: "cascade" }),
    variableKey: text("variable_key").notNull(),
    label: text("label").notNull(),
    source: text("source").notNull(),
    dataType: text("data_type").notNull().default("text"),
    formatter: text("formatter"),
    exampleValue: text("example_value"),
    defaultValue: text("default_value"),
    required: boolean("required").notNull().default(true),
    missingPolicy: text("missing_policy").notNull().default("block"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("quick_reply_variables_identity_uq").on(
      t.quickReplyId,
      t.variableKey,
    ),
  ],
);
export const quickReplyAttachments = pgTable(
  "quick_reply_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quickReplyId: uuid("quick_reply_id")
      .notNull()
      .references(() => quickReplies.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    attachmentType: text("attachment_type").notNull(),
    scanStatus: text("scan_status").notNull().default("pending"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("quick_reply_attachments_storage_uq").on(
      t.quickReplyId,
      t.storageKey,
    ),
  ],
);
export const quickReplyVersions = pgTable(
  "quick_reply_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    quickReplyId: uuid("quick_reply_id")
      .notNull()
      .references(() => quickReplies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    changedFields: text("changed_fields").array().notNull().default([]),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("quick_reply_versions_identity_uq").on(
      t.quickReplyId,
      t.version,
    ),
  ],
);
export const quickReplyUsageEvents = pgTable("quick_reply_usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  quickReplyId: uuid("quick_reply_id")
    .notNull()
    .references(() => quickReplies.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  renderedContentHash: text("rendered_content_hash"),
  eventType: text("event_type").notNull().default("sent"),
  teamId: uuid("team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_feed_idx").on(t.organizationId, t.userId, t.createdAt),
  ],
);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicId: uuid("public_id").notNull().defaultRandom(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    authMode: text("auth_mode").notNull(),
    portalUrl: text("portal_url"),
    memberId: text("member_id"),
    authExternalUserId: text("auth_external_user_id"),
    credentialsEncrypted: text("credentials_encrypted"),
    webhookTokenHash: text("webhook_token_hash"),
    automationWebhookTokenHash: text("automation_webhook_token_hash"),
    automationDefaultChannelId: uuid(
      "automation_default_channel_id",
    ).references(() => channels.id, { onDelete: "set null" }),
    status: text("status").notNull().default("connected"),
    bitrixMode: text("bitrix_mode").notNull().default("crm_context"),
    openChannelsStatus: text("open_channels_status")
      .notNull()
      .default("disabled"),
    settings: jsonb("settings").notNull().default({}),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdBy: uuid("created_by").references(() => users.id),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("integration_connections_public_uq").on(t.publicId),
    index("integration_connections_org_idx").on(t.organizationId, t.status),
  ],
);
export const crmEntityLinks = pgTable(
  "crm_entity_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    entityType: text("entity_type").notNull(),
    externalId: text("external_id").notNull(),
    matchSource: text("match_source").notNull().default("manual"),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }),
    unavailableAt: timestamp("unavailable_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_entity_link_conversation_uq").on(
      t.connectionId,
      t.conversationId,
      t.entityType,
    ),
  ],
);
export const crmContactExclusions = pgTable(
  "crm_contact_exclusions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    normalizedPhone: text("normalized_phone").notNull(),
    displayName: text("display_name"),
    reason: text("reason").notNull().default("internal_contact"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_contact_exclusions_active_phone_uq")
      .on(t.organizationId, t.normalizedPhone)
      .where(sql`${t.archivedAt} IS NULL`),
    index("crm_contact_exclusions_org_active_idx").on(
      t.organizationId,
      t.archivedAt,
      t.createdAt,
    ),
  ],
);
export const crmUserMappings = pgTable(
  "crm_user_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    localUserId: uuid("local_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    externalUserId: text("external_user_id").notNull(),
    externalSnapshot: jsonb("external_snapshot").notNull().default({}),
    crmPolicy: jsonb("crm_policy").notNull().default({}),
    active: boolean("active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_user_mapping_external_uq").on(
      t.connectionId,
      t.externalUserId,
    ),
    uniqueIndex("crm_user_mapping_local_uq").on(t.connectionId, t.localUserId),
  ],
);
export const crmFieldMappings = pgTable("crm_field_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => integrationConnections.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  localField: text("local_field").notNull(),
  externalField: text("external_field").notNull(),
  direction: text("direction").notNull().default("outbound"),
  transform: jsonb("transform").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  ...auditColumns,
});
export const crmSyncJobs = pgTable(
  "crm_sync_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("crm_sync_job_idempotency_uq").on(
      t.connectionId,
      t.idempotencyKey,
    ),
    index("crm_sync_jobs_claim_idx").on(t.status, t.nextAttemptAt),
  ],
);
export const crmSyncLogs = pgTable("crm_sync_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => integrationConnections.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => crmSyncJobs.id, {
    onDelete: "set null",
  }),
  level: text("level").notNull(),
  operation: text("operation").notNull(),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const crmWebhookEvents = pgTable(
  "crm_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    providerEventKey: text("provider_event_key").notNull(),
    eventType: text("event_type").notNull(),
    auth: jsonb("auth").notNull().default({}),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("crm_webhook_event_uq").on(t.connectionId, t.providerEventKey),
    index("crm_webhook_claim_idx").on(t.status, t.receivedAt),
    index("crm_webhook_events_organization_idx").on(t.organizationId),
  ],
);
export const conversationCrmContextCache = pgTable(
  "conversation_crm_context_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    linkId: uuid("link_id").references(() => crmEntityLinks.id, {
      onDelete: "set null",
    }),
    context: jsonb("context").notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("conversation_crm_context_uq").on(
      t.organizationId,
      t.conversationId,
    ),
  ],
);
export const crmPipelineCache = pgTable("crm_pipeline_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => integrationConnections.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  pipelineExternalId: text("pipeline_external_id").notNull(),
  pipelineName: text("pipeline_name").notNull(),
  stageExternalId: text("stage_external_id").notNull(),
  stageName: text("stage_name").notNull(),
  stageOrder: integer("stage_order").notNull().default(0),
  semantics: text("semantics"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  staleAt: timestamp("stale_at", { withTimezone: true }).notNull(),
});
export const labelCategories = pgTable(
  "label_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    isRequiredGroup: boolean("is_required_group").notNull().default(false),
    selectionMode: text("selection_mode").notNull().default("multiple"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("label_categories_name_uq").on(
      t.organizationId,
      t.normalizedName,
    ),
    index("label_categories_list_idx").on(
      t.organizationId,
      t.archivedAt,
      t.sortOrder,
      t.name,
    ),
  ],
);
export const conversationLabels = pgTable(
  "conversation_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
    color: text("color").notNull(),
    icon: text("icon"),
    categoryId: uuid("category_id").references(() => labelCategories.id, {
      onDelete: "set null",
    }),
    scope: text("scope").notNull().default("workspace"),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    isSystem: boolean("is_system").notNull().default(false),
    isProtected: boolean("is_protected").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    mergedIntoId: uuid("merged_into_id"),
    version: integer("version").notNull().default(1),
    usageCount: integer("usage_count").notNull().default(0),
    automationUsageCount: integer("automation_usage_count")
      .notNull()
      .default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("conversation_labels_normalized_name_uq").on(
      t.organizationId,
      t.normalizedName,
    ),
    index("conversation_labels_list_idx").on(
      t.organizationId,
      t.status,
      t.scope,
      t.categoryId,
      t.sortOrder,
      t.name,
    ),
  ],
);
export const conversationLabelAssignments = pgTable(
  "conversation_label_assignments",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => conversationLabels.id, { onDelete: "cascade" }),
    assignedBy: uuid("assigned_by").references(() => users.id),
    source: text("source").notNull().default("manual"),
    automationId: uuid("automation_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_label_assignment_uq").on(
      t.conversationId,
      t.labelId,
    ),
    index("conversation_label_filter_idx").on(
      t.organizationId,
      t.labelId,
      t.conversationId,
    ),
    index("conversation_label_source_idx").on(
      t.organizationId,
      t.source,
      t.assignedAt,
    ),
  ],
);
export const labelFavorites = pgTable(
  "label_favorites",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => conversationLabels.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.userId, t.labelId],
    }),
  ],
);
export const labelUsageEvents = pgTable(
  "label_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => conversationLabels.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    source: text("source").notNull().default("manual"),
    automationId: uuid("automation_id"),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("label_usage_events_analytics_idx").on(
      t.organizationId,
      t.labelId,
      t.createdAt,
    ),
  ],
);
export const labelBitrixMappings = pgTable(
  "label_bitrix_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => conversationLabels.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id").references(
      () => integrationConnections.id,
      { onDelete: "cascade" },
    ),
    entityType: text("entity_type").notNull(),
    fieldId: text("field_id").notNull(),
    fieldValue: text("field_value").notNull(),
    syncDirection: text("sync_direction")
      .notNull()
      .default("bitrix_to_brixchat"),
    conflictPolicy: text("conflict_policy").notNull().default("external_wins"),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncedValue: text("last_synced_value"),
    lastExternalEventId: text("last_external_event_id"),
    lastCorrelationId: uuid("last_correlation_id"),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("label_bitrix_mappings_uq").on(
      t.organizationId,
      t.labelId,
      t.entityType,
      t.fieldId,
      t.fieldValue,
    ),
  ],
);
export const labelBulkJobs = pgTable(
  "label_bulk_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    conversationIds: uuid("conversation_ids").array().notNull(),
    labelId: uuid("label_id").references(() => conversationLabels.id, {
      onDelete: "set null",
    }),
    replacementLabelId: uuid("replacement_label_id").references(
      () => conversationLabels.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    totalCount: integer("total_count").notNull().default(0),
    processedCount: integer("processed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    result: jsonb("result").notNull().default({}),
    errorCode: text("error_code"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("label_bulk_jobs_idempotency_uq").on(
      t.organizationId,
      t.idempotencyKey,
    ),
  ],
);
export const conversationNotes = pgTable(
  "conversation_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    parentNoteId: uuid("parent_note_id"),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("conversation_notes_thread_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt,
    ),
  ],
);
export const conversationNoteMentions = pgTable(
  "conversation_note_mentions",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => conversationNotes.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("conversation_note_mention_uq").on(t.noteId, t.userId)],
);
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    visibility: text("visibility").notNull().default("personal"),
    filters: jsonb("filters").notNull().default({}),
    sort: jsonb("sort").notNull().default({}),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull().default("personal"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("saved_views_owner_name_uq").on(
      t.organizationId,
      t.ownerUserId,
      t.name,
    ),
  ],
);
export const conversationOperationHistory = pgTable(
  "conversation_operation_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    fromValue: jsonb("from_value").notNull().default({}),
    toValue: jsonb("to_value").notNull().default({}),
    actorId: uuid("actor_id").references(() => users.id),
    origin: text("origin").notNull().default("local"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const channelUserOwnership = pgTable(
  "channel_user_ownership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type").notNull().default("owner"),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex(
      "channel_user_ownership_organization_id_channel_id_user_id_key",
    ).on(t.organizationId, t.channelId, t.userId),
    uniqueIndex("channel_user_ownership_primary_idx")
      .on(t.channelId)
      .where(sql`is_primary`),
    index("channel_user_ownership_user_idx").on(t.organizationId, t.userId),
  ],
);

export const assignmentRules = pgTable(
  "assignment_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
    strategy: text("strategy").notNull().default("round_robin"),
    config: jsonb("config").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("assignment_rules_organization_id_name_key").on(
      t.organizationId,
      t.name,
    ),
  ],
);
export const assignmentRuleConditions = pgTable(
  "assignment_rule_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => assignmentRules.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    field: text("field").notNull(),
    operator: text("operator").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [
    uniqueIndex("assignment_rule_conditions_rule_id_position_key").on(
      t.ruleId,
      t.position,
    ),
  ],
);
export const assignmentRuleActions = pgTable(
  "assignment_rule_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => assignmentRules.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    action: text("action").notNull(),
    value: jsonb("value").notNull(),
  },
  (t) => [
    uniqueIndex("assignment_rule_actions_rule_id_position_key").on(
      t.ruleId,
      t.position,
    ),
  ],
);
export const conversationAssignments = pgTable(
  "conversation_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    teamId: uuid("team_id").references(() => teams.id),
    origin: text("origin").notNull().default("manual"),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    assignedBy: uuid("assigned_by").references(() => users.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    unassignedBy: uuid("unassigned_by").references(() => users.id),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("conversation_assignments_active_uq")
      .on(t.conversationId)
      .where(sql`active`),
  ],
);
export const assignmentHistory = pgTable(
  "assignment_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    fromUserId: uuid("from_user_id").references(() => users.id),
    toUserId: uuid("to_user_id").references(() => users.id),
    fromTeamId: uuid("from_team_id").references(() => teams.id),
    toTeamId: uuid("to_team_id").references(() => teams.id),
    ruleId: uuid("rule_id").references(() => assignmentRules.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    origin: text("origin").notNull(),
    version: integer("version").notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("assignment_history_conversation_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt,
    ),
  ],
);
export const agentCapacityStatus = pgTable(
  "agent_capacity_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capacity: integer("capacity").notNull().default(20),
    activeCount: integer("active_count").notNull().default(0),
    availability: text("availability").notNull().default("available"),
    lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_capacity_status_organization_id_user_id_key").on(
      t.organizationId,
      t.userId,
    ),
  ],
);

export const automationRules = pgTable(
  "automation_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    priority: integer("priority").notNull().default(100),
    stopProcessing: boolean("stop_processing").notNull().default(false),
    executionMode: text("execution_mode").notNull().default("first_match"),
    createdBy: uuid("created_by").references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    publishedVersion: integer("published_version"),
    draftVersion: integer("draft_version").notNull().default(1),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("automation_rules_organization_id_name_key").on(
      t.organizationId,
      t.name,
    ),
  ],
);
export const automationRuleVersions = pgTable(
  "automation_rule_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    permissionSnapshot: jsonb("permission_snapshot").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    sourceGraph: jsonb("source_graph"),
    compiledDefinition: jsonb("compiled_definition"),
    compilerVersion: integer("compiler_version"),
    definitionChecksum: text("definition_checksum"),
  },
  (t) => [
    uniqueIndex("automation_rule_versions_rule_id_version_key").on(
      t.ruleId,
      t.version,
    ),
    index("automation_rule_versions_checksum_idx")
      .on(t.organizationId, t.definitionChecksum)
      .where(sql`definition_checksum IS NOT NULL`),
  ],
);
export const automationRuleTriggers = pgTable(
  "automation_rule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationRuleVersions.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    config: jsonb("config").notNull().default({}),
  },
  (t) => [
    uniqueIndex("automation_rule_triggers_version_id_trigger_type_key").on(
      t.versionId,
      t.triggerType,
    ),
  ],
);
export const automationRuleConditions = pgTable(
  "automation_rule_conditions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationRuleVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    field: text("field").notNull(),
    operator: text("operator").notNull(),
    value: jsonb("value").notNull().default({}),
  },
  (t) => [
    uniqueIndex("automation_rule_conditions_version_id_position_key").on(
      t.versionId,
      t.position,
    ),
  ],
);
export const automationRuleActions = pgTable(
  "automation_rule_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationRuleVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    actionType: text("action_type").notNull(),
    config: jsonb("config").notNull().default({}),
  },
  (t) => [
    uniqueIndex("automation_rule_actions_version_id_position_key").on(
      t.versionId,
      t.position,
    ),
  ],
);
export const automationEvents = pgTable(
  "automation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id"),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    correlationId: uuid("correlation_id").notNull(),
    origin: text("origin").notNull(),
    depth: integer("depth").notNull().default(0),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastErrorCode: text("last_error_code"),
  },
  (t) => [
    uniqueIndex(
      "automation_events_organization_id_event_type_correlation_id_key",
    ).on(t.organizationId, t.eventType, t.correlationId, t.origin),
    index("automation_events_claim_idx")
      .on(t.status, t.nextAttemptAt, t.lockedAt, t.createdAt)
      .where(sql`status IN ('pending','retry','processing')`),
    index("automation_events_conversation_idx").on(t.conversationId),
  ],
);
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => automationEvents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    correlationId: uuid("correlation_id").notNull(),
    status: text("status").notNull().default("running"),
    dryRun: boolean("dry_run").notNull().default(false),
    actionCount: integer("action_count").notNull().default(0),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    versionId: uuid("version_id").references(() => automationRuleVersions.id, {
      onDelete: "set null",
    }),
    currentNodeId: text("current_node_id"),
    limitsSnapshot: jsonb("limits_snapshot").notNull().default({}),
  },
  (t) => [
    uniqueIndex("automation_runs_rule_id_event_id_key").on(t.ruleId, t.eventId),
    index("automation_runs_version_idx").on(
      t.organizationId,
      t.versionId,
      t.startedAt,
    ),
  ],
);
export const automationRunSteps = pgTable(
  "automation_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    stepType: text("step_type").notNull(),
    status: text("status").notNull(),
    input: jsonb("input").notNull().default({}),
    output: jsonb("output").notNull().default({}),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    nodeId: text("node_id"),
    nodeVersion: integer("node_version"),
    selectedPort: text("selected_port"),
    attempt: integer("attempt").notNull().default(1),
    inputSummary: jsonb("input_summary").notNull().default({}),
    outputSummary: jsonb("output_summary").notNull().default({}),
  },
  (t) => [
    uniqueIndex("automation_run_steps_run_id_position_key").on(
      t.runId,
      t.position,
    ),
    index("automation_run_steps_node_idx").on(
      t.organizationId,
      t.runId,
      t.nodeId,
      t.createdAt,
    ),
  ],
);
export const automationSideEffects = pgTable(
  "automation_side_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeVersion: integer("node_version").notNull(),
    effectType: text("effect_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("reserved"),
    output: jsonb("output").notNull().default({}),
    lastErrorCode: text("last_error_code"),
    ...auditColumns,
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex(
      "automation_side_effects_organization_id_idempotency_key_key",
    ).on(t.organizationId, t.idempotencyKey),
    index("automation_side_effects_run_idx").on(
      t.organizationId,
      t.runId,
      t.nodeId,
      t.createdAt,
    ),
  ],
);
export const automationContinuations = pgTable(
  "automation_continuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationRuleVersions.id, { onDelete: "restrict" }),
    nodeId: text("node_id").notNull(),
    nodeVersion: integer("node_version").notNull(),
    generation: integer("generation").notNull().default(1),
    continuationType: text("continuation_type").notNull(),
    status: text("status").notNull().default("scheduled"),
    resumeAt: timestamp("resume_at", { withTimezone: true }),
    cancellationKeyHash: text("cancellation_key_hash"),
    queueJobId: text("queue_job_id"),
    selectedPort: text("selected_port"),
    payload: jsonb("payload").notNull().default({}),
    lastErrorCode: text("last_error_code"),
    ...auditColumns,
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("automation_continuations_run_id_node_id_generation_key").on(
      t.runId,
      t.nodeId,
      t.generation,
    ),
    index("automation_continuations_schedule_idx")
      .on(t.status, t.resumeAt, t.createdAt)
      .where(sql`status = 'scheduled'`),
    index("automation_continuations_cancel_idx")
      .on(t.organizationId, t.cancellationKeyHash, t.status, t.createdAt)
      .where(sql`cancellation_key_hash IS NOT NULL AND status = 'scheduled'`),
  ],
);
export const automationRateLimits = pgTable(
  "automation_rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => automationRules.id, {
      onDelete: "cascade",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    windowKey: text("window_key").notNull(),
    count: integer("count").notNull().default(0),
    resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex(
      "automation_rate_limits_organization_id_rule_id_conversation_key",
    ).on(t.organizationId, t.ruleId, t.conversationId, t.windowKey),
  ],
);
export const automationWebhookDeliveries = pgTable(
  "automation_webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    urlHost: text("url_host").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
);

export const bitrixOpenChannelConnectors = pgTable(
  "bitrix_open_channel_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").notNull(),
    lineId: text("line_id"),
    status: text("status").notNull().default("registered"),
    settings: jsonb("settings").notNull().default({}),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_connectors_integration_connection_id_key",
    ).on(t.integrationConnectionId),
  ],
);
export const bitrixOpenChannelBindings = pgTable(
  "bitrix_open_channel_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    brixchatChannelId: uuid("brixchat_channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").notNull(),
    lineId: text("line_id").notNull(),
    status: text("status").notNull().default("registered"),
    settings: jsonb("settings").notNull().default({}),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("bitrix_open_channel_binding_channel_uq").on(
      t.organizationId,
      t.brixchatChannelId,
    ),
    uniqueIndex("bitrix_open_channel_binding_line_uq").on(
      t.integrationConnectionId,
      t.lineId,
    ),
    index("bitrix_open_channel_bindings_connection_idx").on(
      t.integrationConnectionId,
      t.status,
    ),
  ],
);
export const bitrixOpenChannelSessions = pgTable(
  "bitrix_open_channel_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").notNull(),
    lineId: text("line_id"),
    externalChatId: text("external_chat_id").notNull(),
    externalSessionId: text("external_session_id").notNull(),
    externalUserCode: text("external_user_code"),
    status: text("status").notNull().default("open"),
    operatorExternalId: text("operator_external_id"),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_sessions_integration_connection_id_conv_key",
    ).on(t.integrationConnectionId, t.conversationId),
  ],
);
export const bitrixOpenChannelMessageLinks = pgTable(
  "bitrix_open_channel_message_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    localMessageId: uuid("local_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    externalChatId: text("external_chat_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    direction: text("direction").notNull(),
    sourceMarker: text("source_marker").notNull(),
    status: text("status").notNull().default("synced"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_message_l_organization_id_source_marker_key",
    ).on(t.organizationId, t.sourceMarker),
    uniqueIndex(
      "bitrix_open_channel_message_link_local_message_id_direction_key",
    ).on(t.localMessageId, t.direction),
  ],
);
export const bitrixOpenChannelOperatorMappings = pgTable(
  "bitrix_open_channel_operator_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    localUserId: uuid("local_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    externalOperatorId: text("external_operator_id").notNull(),
    externalSnapshot: jsonb("external_snapshot").notNull().default({}),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_operator__integration_connection_id_ext_key",
    ).on(t.integrationConnectionId, t.externalOperatorId),
  ],
);
export const bitrixOpenChannelEvents = pgTable(
  "bitrix_open_channel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    providerEventKey: text("provider_event_key").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_events_integration_connection_id_provid_key",
    ).on(t.integrationConnectionId, t.providerEventKey),
    index("bitrix_open_channel_event_recovery_idx").on(
      t.status,
      t.lockedAt,
      t.receivedAt,
    ),
  ],
);
export const bitrixOpenChannelJobs = pgTable(
  "bitrix_open_channel_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationConnectionId: uuid("integration_connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    localMessageId: uuid("local_message_id").references(() => messages.id, {
      onDelete: "cascade",
    }),
    jobType: text("job_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex(
      "bitrix_open_channel_jobs_integration_connection_id_idempote_key",
    ).on(t.integrationConnectionId, t.idempotencyKey),
    index("bitrix_open_channel_jobs_claim_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    providerMediaId: text("provider_media_id"),
    providerMimeType: text("provider_mime_type"),
    providerFilename: text("provider_filename"),
    providerFileSize: bigint("provider_file_size", { mode: "number" }),
    providerSha256: text("provider_sha256"),
    attachmentType: text("attachment_type").notNull().default("unknown"),
    storageProvider: text("storage_provider"),
    storageBucket: text("storage_bucket"),
    storageKey: text("storage_key"),
    storedMimeType: text("stored_mime_type"),
    storedFilename: text("stored_filename"),
    storedSize: bigint("stored_size", { mode: "number" }),
    storedSha256: text("stored_sha256"),
    processingStatus: text("processing_status").notNull().default("pending"),
    scanStatus: text("scan_status").notNull().default("not_scanned"),
    downloadAttemptCount: integer("download_attempt_count")
      .notNull()
      .default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    providerUrlExpiresAt: timestamp("provider_url_expires_at", {
      withTimezone: true,
    }),
    storedAt: timestamp("stored_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    ...auditColumns,
    fileAssetId: uuid("file_asset_id").references(() => fileAssets.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("message_attachments_message_idx").on(t.organizationId, t.messageId),
    uniqueIndex("message_attachments_provider_uq")
      .on(t.channelId, t.providerMediaId)
      .where(sql`provider_media_id IS NOT NULL`),
    index("message_attachments_file_asset_idx")
      .on(t.organizationId, t.fileAssetId)
      .where(sql`file_asset_id IS NOT NULL`),
    index("message_attachments_filename_trgm_idx").using(
      "gin",
      t.providerFilename.op("extensions.gin_trgm_ops"),
    ),
  ],
);
export const mediaProcessingJobs = pgTable(
  "media_processing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => messageAttachments.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    traceId: uuid("trace_id").notNull().defaultRandom(),
    ...auditColumns,
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_processing_jobs_attachment_id_job_type_key").on(
      t.attachmentId,
      t.jobType,
    ),
    index("media_processing_jobs_claim_idx").on(t.status, t.nextAttemptAt),
  ],
);
export const mediaDownloadAudit = pgTable(
  "media_download_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => messageAttachments.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("media_download_audit_organization_idx").on(t.organizationId)],
);
export const retentionJobs = pgTable(
  "retention_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status").notNull().default("pending"),
    eligibleCount: integer("eligible_count").notNull().default(0),
    deletedCount: integer("deleted_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
  },
  (t) => [
    index("retention_job_recovery_idx").on(t.status, t.lockedAt, t.createdAt),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    limits: jsonb("limits").notNull().default({}),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("plans_code_key").on(t.code)],
);
export const organizationEntitlements = pgTable("organization_entitlements", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  trialStatus: text("trial_status").notNull().default("inactive"),
  graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
  overrides: jsonb("overrides").notNull().default({}),
  updatedBy: uuid("updated_by").references(() => users.id),
  ...auditColumns,
});
export const organizationUsageLimits = pgTable(
  "organization_usage_limits",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    hardLimit: bigint("hard_limit", { mode: "number" }),
    warningLimit: bigint("warning_limit", { mode: "number" }),
    ...auditColumns,
  },
  (t) => [
    primaryKey({
      name: "organization_usage_limits_pkey",
      columns: [t.organizationId, t.metric],
    }),
  ],
);
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventKey: text("event_key").notNull(),
    metric: text("metric").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_events_organization_id_event_key_key").on(
      t.organizationId,
      t.eventKey,
    ),
    index("usage_events_rollup_idx").on(
      t.organizationId,
      t.occurredAt,
      t.metric,
    ),
  ],
);
export const usageDailyRollups = pgTable(
  "usage_daily_rollups",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    usageDate: date("usage_date").notNull(),
    metric: text("metric").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "usage_daily_rollups_pkey",
      columns: [t.organizationId, t.usageDate, t.metric],
    }),
  ],
);

export const billingProducts = pgTable(
  "billing_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    productType: text("product_type").notNull(),
    planCode: text("plan_code").references(() => plans.code),
    features: jsonb("features").notNull().default({}),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("billing_products_code_key").on(t.code)],
);

export const billingPrices = pgTable(
  "billing_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => billingProducts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("manual"),
    providerPriceRef: text("provider_price_ref"),
    currency: text("currency").notNull().default("USD"),
    interval: text("interval").notNull(),
    unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
    creditsPerUnit: bigint("credits_per_unit", { mode: "number" }),
    taxMode: text("tax_mode").notNull().default("provider"),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("billing_prices_product_provider_currency_interval_uq").on(
      t.productId,
      t.provider,
      t.currency,
      t.interval,
    ),
    uniqueIndex("billing_prices_provider_ref_uq")
      .on(t.provider, t.providerPriceRef)
      .where(sql`${t.providerPriceRef} IS NOT NULL`),
  ],
);

export const organizationSubscriptions = pgTable(
  "organization_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("manual"),
    providerCustomerRef: text("provider_customer_ref"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    planCode: text("plan_code").references(() => plans.code),
    status: text("status").notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    lastProviderOccurredAt: timestamp("last_provider_occurred_at", {
      withTimezone: true,
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("organization_subscriptions_org_provider_uq").on(
      t.organizationId,
      t.provider,
    ),
    uniqueIndex("organization_subscriptions_provider_ref_uq")
      .on(t.provider, t.providerSubscriptionRef)
      .where(sql`${t.providerSubscriptionRef} IS NOT NULL`),
    index("organization_subscriptions_status_idx").on(
      t.status,
      t.currentPeriodEnd,
    ),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => organizationSubscriptions.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => billingProducts.id),
    priceId: uuid("price_id").references(() => billingPrices.id),
    providerItemRef: text("provider_item_ref"),
    quantity: integer("quantity").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_items_subscription_product_uq").on(
      t.subscriptionId,
      t.productId,
    ),
  ],
);

export const billingTransactions = pgTable(
  "billing_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(
      () => organizationSubscriptions.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    providerTransactionRef: text("provider_transaction_ref").notNull(),
    status: text("status").notNull(),
    currency: text("currency").notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "number" })
      .notNull()
      .default(0),
    taxMinor: bigint("tax_minor", { mode: "number" }).notNull().default(0),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull().default(0),
    invoiceNumber: text("invoice_number"),
    billedAt: timestamp("billed_at", { withTimezone: true }),
    providerOccurredAt: timestamp("provider_occurred_at", {
      withTimezone: true,
    }).notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("billing_transactions_provider_ref_uq").on(
      t.provider,
      t.providerTransactionRef,
    ),
  ],
);

export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("processing"),
    errorCode: text("error_code"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("billing_webhook_events_provider_event_uq").on(
      t.provider,
      t.providerEventId,
    ),
    index("billing_webhook_events_org_time_idx").on(
      t.organizationId,
      t.occurredAt,
    ),
  ],
);

export const usagePeriodCounters = pgTable(
  "usage_period_counters",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    periodStart: date("period_start").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "usage_period_counters_pkey",
      columns: [t.organizationId, t.metric, t.periodStart],
    }),
  ],
);

export const creditAccounts = pgTable("credit_accounts", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  totalPurchased: bigint("total_purchased", { mode: "number" })
    .notNull()
    .default(0),
  totalUsed: bigint("total_used", { mode: "number" }).notNull().default(0),
  autoRechargeEnabled: boolean("auto_recharge_enabled")
    .notNull()
    .default(false),
  autoRechargeThreshold: bigint("auto_recharge_threshold", { mode: "number" })
    .notNull()
    .default(100),
  autoRechargeAmount: bigint("auto_recharge_amount", { mode: "number" })
    .notNull()
    .default(1000),
  ...auditColumns,
});

export const creditLedgerEntries = pgTable(
  "credit_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entryKey: text("entry_key").notNull(),
    entryType: text("entry_type").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_ledger_entries_org_key_uq").on(
      t.organizationId,
      t.entryKey,
    ),
    index("credit_ledger_entries_org_time_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);
export const operationalMetrics = pgTable(
  "operational_metrics",
  {
    metricName: text("metric_name").notNull(),
    labelKey: text("label_key").notNull().default(""),
    metricValue: numeric("metric_value").notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "operational_metrics_pkey",
      columns: [t.metricName, t.labelKey],
    }),
  ],
);

export const organizationRetentionSettings = pgTable(
  "organization_retention_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageRetentionDays: integer("message_retention_days")
      .notNull()
      .default(365),
    mediaRetentionDays: integer("media_retention_days").notNull().default(180),
    rawWebhookRetentionDays: integer("raw_webhook_retention_days")
      .notNull()
      .default(30),
    auditRetentionDays: integer("audit_retention_days").notNull().default(365),
    syncLogRetentionDays: integer("sync_log_retention_days")
      .notNull()
      .default(90),
    deletedUserAnonymization: boolean("deleted_user_anonymization")
      .notNull()
      .default(true),
    legalHold: boolean("legal_hold").notNull().default(false),
    automaticPurgeEnabled: boolean("automatic_purge_enabled")
      .notNull()
      .default(false),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    requestType: text("request_type").notNull(),
    subjectReferenceHash: text("subject_reference_hash").notNull(),
    reason: text("reason"),
    status: text("status").notNull().default("requested"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    legalHoldConflict: boolean("legal_hold_conflict").notNull().default(false),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("privacy_requests_org_status_idx").on(
      t.organizationId,
      t.status,
      t.requestedAt,
    ),
  ],
);
export const privacyRequestEvents = pgTable("privacy_request_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  requestId: uuid("request_id")
    .notNull()
    .references(() => privacyRequests.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectReferenceHash: text("subject_reference_hash").notNull(),
    purpose: text("purpose").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex(
      "consent_records_organization_id_subject_reference_hash_purp_key",
    ).on(t.organizationId, t.subjectReferenceHash, t.purpose),
  ],
);
export const processingActivityLogs = pgTable("processing_activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  activityType: text("activity_type").notNull(),
  legalBasis: text("legal_basis").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const tenantProvisioningAudit = pgTable("tenant_provisioning_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  targetType: text("target_type"),
  targetId: uuid("target_id"),
  requestId: text("request_id"),
  ipAddress: inet("ip_address"),
  userAgent: text("user_agent"),
  reason: text("reason"),
  beforeState: jsonb("before_state").notNull().default({}),
  afterState: jsonb("after_state").notNull().default({}),
  severity: text("severity").notNull().default("info"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const platformAlerts = pgTable(
  "platform_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    safeMetadata: jsonb("safe_metadata").notNull().default({}),
    consecutiveHealthyScans: integer("consecutive_healthy_scans")
      .notNull()
      .default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    emailNotifiedAt: timestamp("email_notified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("platform_alerts_fingerprint_uq").on(t.fingerprint),
    index("platform_alerts_status_severity_idx").on(
      t.status,
      t.severity,
      t.lastSeenAt,
    ),
    index("platform_alerts_org_status_idx").on(
      t.organizationId,
      t.status,
      t.lastSeenAt,
    ),
  ],
);

export const workerInstances = pgTable(
  "worker_instances",
  {
    instanceId: text("instance_id").primaryKey(),
    service: text("service").notNull(),
    version: text("version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true })
      .notNull()
      .defaultNow(),
    currentJobs: integer("current_jobs").notNull().default(0),
    processedCount: bigint("processed_count", { mode: "number" })
      .notNull()
      .default(0),
    failedCount: bigint("failed_count", { mode: "number" })
      .notNull()
      .default(0),
    status: text("status").notNull().default("healthy"),
    safeMetadata: jsonb("safe_metadata").notNull().default({}),
  },
  (t) => [index("worker_instances_health_idx").on(t.service, t.lastHeartbeat)],
);
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => workerInstances.instanceId, { onDelete: "cascade" }),
    currentJobs: integer("current_jobs").notNull().default(0),
    status: text("status").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("worker_heartbeats_recent_idx").on(t.instanceId, t.recordedAt)],
);

// --- AI Agent Platform ---------------------------------------------------
// Mirrors migrations/0036_ai_agent_platform.sql. Agents follow the
// automation_rules / automation_rule_versions split: the container row holds
// draft/published version pointers, every runtime read resolves through an
// immutable ai_agent_versions snapshot. CHECK constraints live in SQL only,
// matching the post-0004 convention.

export const aiSettings = pgTable(
  "ai_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    apiKeyEncrypted: text("api_key_encrypted"),
    defaultModel: text("default_model"),
    fallbackModel: text("fallback_model"),
    dailyBudgetUsd: numeric("daily_budget_usd", { precision: 12, scale: 4 }),
    debounceMs: integer("debounce_ms").notNull().default(3000),
    config: jsonb("config").notNull().default({}),
    ...auditColumns,
  },
  (t) => [uniqueIndex("ai_settings_org_uq").on(t.organizationId)],
);

export const aiAgents = pgTable(
  "ai_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    draftVersionId: uuid("draft_version_id"),
    publishedVersionId: uuid("published_version_id"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_agents_org_name_uq").on(t.organizationId, t.name),
    index("ai_agents_org_status_idx").on(t.organizationId, t.status),
    index("ai_agents_draft_version_idx").on(t.draftVersionId),
    index("ai_agents_published_version_idx").on(t.publishedVersionId),
  ],
);

export const aiAgentVersions = pgTable(
  "ai_agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    mode: text("mode").notNull().default("copilot"),
    model: text("model").notNull().default(""),
    fallbackModel: text("fallback_model"),
    temperature: numeric("temperature", { precision: 3, scale: 2 })
      .notNull()
      .default("0.30"),
    maxSteps: integer("max_steps").notNull().default(6),
    maxCostPerRunUsd: numeric("max_cost_per_run_usd", {
      precision: 10,
      scale: 4,
    })
      .notNull()
      .default("0.25"),
    defaultLanguage: text("default_language").notNull().default("tr"),
    allowedLanguages: jsonb("allowed_languages").notNull().default([]),
    systemInstruction: text("system_instruction").notNull().default(""),
    businessObjective: text("business_objective").notNull().default(""),
    persona: jsonb("persona").notNull().default({}),
    behaviorRules: jsonb("behavior_rules").notNull().default([]),
    forbiddenTopics: jsonb("forbidden_topics").notNull().default([]),
    exampleResponses: jsonb("example_responses").notNull().default([]),
    handoffRules: jsonb("handoff_rules").notNull().default({}),
    confidenceThreshold: numeric("confidence_threshold", {
      precision: 3,
      scale: 2,
    })
      .notNull()
      .default("0.60"),
    workingHours: jsonb("working_hours").notNull().default({}),
    responseDelayMinMs: integer("response_delay_min_ms").notNull().default(0),
    responseDelayMaxMs: integer("response_delay_max_ms").notNull().default(0),
    toolPermissions: jsonb("tool_permissions").notNull().default({}),
    config: jsonb("config").notNull().default({}),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_agent_versions_agent_version_uq").on(t.agentId, t.version),
    index("ai_agent_versions_org_agent_idx").on(
      t.organizationId,
      t.agentId,
      t.version,
    ),
  ],
);

export const aiAgentChannelAssignments = pgTable(
  "ai_agent_channel_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    modeOverride: text("mode_override"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_agent_channel_assignments_org_channel_uq").on(
      t.organizationId,
      t.channelId,
    ),
    index("ai_agent_channel_assignments_agent_idx").on(t.agentId),
  ],
);

export const aiKnowledgeBases = pgTable(
  "ai_knowledge_bases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    scope: text("scope").notNull().default("workspace"),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_knowledge_bases_org_name_uq").on(t.organizationId, t.name),
    index("ai_knowledge_bases_channel_idx").on(t.channelId),
  ],
);

export const aiKnowledgeDocuments = pgTable(
  "ai_knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => aiKnowledgeBases.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull().default("text"),
    sourceRef: text("source_ref"),
    content: text("content").notNull().default(""),
    language: text("language"),
    status: text("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    chunkCount: integer("chunk_count").notNull().default(0),
    version: integer("version").notNull().default(1),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    index("ai_knowledge_documents_org_kb_idx").on(
      t.organizationId,
      t.knowledgeBaseId,
    ),
    index("ai_knowledge_documents_status_idx").on(t.organizationId, t.status),
  ],
);

export const aiKnowledgeChunks = pgTable(
  "ai_knowledge_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => aiKnowledgeDocuments.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => aiKnowledgeBases.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    documentVersion: integer("document_version").notNull().default(1),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull().default(0),
    embedding: jsonb("embedding"),
    embeddingModel: text("embedding_model"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_knowledge_chunks_doc_version_index_uq").on(
      t.documentId,
      t.documentVersion,
      t.chunkIndex,
    ),
    index("ai_knowledge_chunks_org_kb_idx").on(
      t.organizationId,
      t.knowledgeBaseId,
    ),
  ],
);

export const aiAgentKnowledge = pgTable(
  "ai_agent_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => aiKnowledgeBases.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_agent_knowledge_agent_kb_uq").on(
      t.agentId,
      t.knowledgeBaseId,
    ),
    index("ai_agent_knowledge_org_kb_idx").on(
      t.organizationId,
      t.knowledgeBaseId,
    ),
  ],
);

export const aiConversationSettings = pgTable(
  "ai_conversation_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => aiAgents.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    modeOverride: text("mode_override"),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    pausedBy: uuid("paused_by").references(() => users.id, {
      onDelete: "set null",
    }),
    humanTakeoverAt: timestamp("human_takeover_at", { withTimezone: true }),
    lastAiMessageAt: timestamp("last_ai_message_at", { withTimezone: true }),
    consecutiveAiMessages: integer("consecutive_ai_messages")
      .notNull()
      .default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_conversation_settings_conversation_uq").on(
      t.conversationId,
    ),
    index("ai_conversation_settings_org_status_idx").on(
      t.organizationId,
      t.status,
    ),
    index("ai_conversation_settings_agent_idx").on(t.agentId),
  ],
);

export const aiConversationSummaries = pgTable(
  "ai_conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    facts: jsonb("facts").notNull().default({}),
    coveredMessageCount: integer("covered_message_count").notNull().default(0),
    lastMessageId: uuid("last_message_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_conversation_summaries_conversation_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    index("ai_conversation_summaries_org_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  ],
);

export const aiCustomerMemory = pgTable(
  "ai_customer_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    memory: jsonb("memory").notNull().default({}),
    updatedByRunId: uuid("updated_by_run_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_customer_memory_org_contact_uq").on(
      t.organizationId,
      t.contactId,
    ),
  ],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => aiAgents.id, {
      onDelete: "set null",
    }),
    agentVersionId: uuid("agent_version_id").references(
      () => aiAgentVersions.id,
      { onDelete: "set null" },
    ),
    agentVersion: integer("agent_version"),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    triggerSource: text("trigger_source").notNull().default("incoming_message"),
    triggerMessageId: uuid("trigger_message_id"),
    triggerMessageIds: jsonb("trigger_message_ids").notNull().default([]),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: uuid("correlation_id"),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("running"),
    decision: text("decision"),
    model: text("model"),
    modelUsed: text("model_used"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    responseText: text("response_text"),
    finalText: text("final_text"),
    responseMeta: jsonb("response_meta").notNull().default({}),
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    requiresHuman: boolean("requires_human").notNull().default(false),
    handoffReason: text("handoff_reason"),
    knowledgeRefs: jsonb("knowledge_refs").notNull().default([]),
    toolCalls: jsonb("tool_calls").notNull().default([]),
    promptMeta: jsonb("prompt_meta").notNull().default({}),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    steps: integer("steps").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ai_runs_org_idempotency_uq").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    index("ai_runs_org_agent_started_idx").on(
      t.organizationId,
      t.agentId,
      t.startedAt,
    ),
    index("ai_runs_conversation_idx").on(t.conversationId, t.startedAt),
    index("ai_runs_org_started_idx").on(t.organizationId, t.startedAt),
    index("ai_runs_agent_version_idx").on(t.agentVersionId),
    index("ai_runs_channel_idx").on(t.channelId),
    index("ai_runs_contact_idx").on(t.contactId),
  ],
);

export const aiRunRequests = pgTable(
  "ai_run_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => aiAgents.id, {
      onDelete: "set null",
    }),
    messageIds: jsonb("message_ids").notNull().default([]),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    notBefore: timestamp("not_before", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    runId: uuid("run_id").references(() => aiRuns.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_run_requests_org_dedupe_uq").on(
      t.organizationId,
      t.dedupeKey,
    ),
    index("ai_run_requests_claim_idx")
      .on(t.nextAttemptAt)
      .where(sql`status IN ('pending','retry')`),
    uniqueIndex("ai_run_requests_processing_conversation_uq")
      .on(t.conversationId)
      .where(sql`status = 'processing'`),
    index("ai_run_requests_org_conversation_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt,
    ),
    index("ai_run_requests_run_idx").on(t.runId),
  ],
);

export const aiFeedback = pgTable(
  "ai_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    originalText: text("original_text"),
    finalText: text("final_text"),
    comment: text("comment"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_feedback_org_run_idx").on(t.organizationId, t.runId),
    index("ai_feedback_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const aiTrainingExamples = pgTable(
  "ai_training_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").references(() => aiRuns.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("pending"),
    customerMessage: text("customer_message").notNull(),
    contextSummary: text("context_summary"),
    aiOutput: text("ai_output"),
    humanOutput: text("human_output").notNull().default(""),
    intent: text("intent"),
    language: text("language"),
    notes: text("notes"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    promotedTo: text("promoted_to"),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("ai_training_examples_org_agent_status_idx").on(
      t.organizationId,
      t.agentId,
      t.status,
    ),
    index("ai_training_examples_source_run_idx").on(t.sourceRunId),
  ],
);

export const aiEvaluationDatasets = pgTable(
  "ai_evaluation_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => aiAgents.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_evaluation_datasets_org_name_uq").on(
      t.organizationId,
      t.name,
    ),
    index("ai_evaluation_datasets_agent_idx").on(t.agentId),
  ],
);

export const aiEvaluationCases = pgTable(
  "ai_evaluation_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => aiEvaluationDatasets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    input: jsonb("input").notNull().default([]),
    context: jsonb("context").notNull().default({}),
    expectations: jsonb("expectations").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("ai_evaluation_cases_dataset_name_uq").on(t.datasetId, t.name),
    index("ai_evaluation_cases_org_dataset_idx").on(
      t.organizationId,
      t.datasetId,
      t.position,
    ),
  ],
);

export const aiEvaluationRuns = pgTable(
  "ai_evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => aiEvaluationDatasets.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => aiAgents.id, {
      onDelete: "set null",
    }),
    agentVersionId: uuid("agent_version_id").references(
      () => aiAgentVersions.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("running"),
    totalCases: integer("total_cases").notNull().default(0),
    passedCases: integer("passed_cases").notNull().default(0),
    results: jsonb("results").notNull().default([]),
    score: numeric("score", { precision: 5, scale: 2 }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    requestedBy: uuid("requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("ai_evaluation_runs_org_dataset_idx").on(
      t.organizationId,
      t.datasetId,
      t.startedAt,
    ),
    index("ai_evaluation_runs_agent_version_idx").on(t.agentVersionId),
    index("ai_evaluation_runs_agent_idx").on(t.agentId),
  ],
);

export const aiUsageDaily = pgTable(
  "ai_usage_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => aiAgents.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    runs: integer("runs").notNull().default(0),
    suggested: integer("suggested").notNull().default(0),
    drafts: integer("drafts").notNull().default(0),
    autoSent: integer("auto_sent").notNull().default(0),
    handoffs: integer("handoffs").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_usage_daily_org_agent_day_uq").on(
      t.organizationId,
      t.agentId,
      t.day,
    ),
    index("ai_usage_daily_agent_idx").on(t.agentId),
  ],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    channelId: uuid("channel_id").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    content: jsonb("content").notNull(),
    requestKey: uuid("request_key").notNull(),
    contentHash: text("content_hash").notNull(),
    status: text("status").notNull().default("draft"),
    dryRunToken: uuid("dry_run_token"),
    dryRunAt: timestamp("dry_run_at", { withTimezone: true }),
    dryRunResult: jsonb("dry_run_result"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaigns_organization_id_id_key").on(t.organizationId, t.id),
    uniqueIndex("campaigns_organization_id_request_key_key").on(
      t.organizationId,
      t.requestKey,
    ),
    foreignKey({
      columns: [t.organizationId, t.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }),
    check("campaigns_name_check", sql`length(${t.name}) BETWEEN 1 AND 120`),
    check(
      "campaigns_status_check",
      sql`${t.status} IN ('draft','queued','processing','completed','canceled')`,
    ),
    index("campaigns_pending_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} IN ('queued','processing')`),
  ],
);

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    campaignId: uuid("campaign_id").notNull(),
    phone: text("phone").notNull(),
    name: text("name").notNull().default(""),
    clientMessageId: uuid("client_message_id").notNull().defaultRandom(),
    messageId: uuid("message_id"),
    status: text("status").notNull().default("pending"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("campaign_recipients_organization_id_id_key").on(
      t.organizationId,
      t.id,
    ),
    uniqueIndex("campaign_recipients_organization_id_campaign_id_phone_key").on(
      t.organizationId,
      t.campaignId,
      t.phone,
    ),
    uniqueIndex("campaign_recipients_organization_id_client_message_id_key").on(
      t.organizationId,
      t.clientMessageId,
    ),
    foreignKey({
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [campaigns.organizationId, campaigns.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.organizationId, t.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }),
    check(
      "campaign_recipients_phone_check",
      sql`${t.phone} ~ '^[+][1-9][0-9]{7,14}$'`,
    ),
    check("campaign_recipients_name_check", sql`length(${t.name})<=120`),
    check(
      "campaign_recipients_status_check",
      sql`${t.status} IN ('pending','queued','sent','failed','canceled')`,
    ),
    index("campaign_recipients_pending_idx").on(
      t.campaignId,
      t.status,
      t.createdAt,
    ),
  ],
);
