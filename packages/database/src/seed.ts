import { createDatabase } from "./index";
import { hashPassword } from "@brixchat/auth";
import { createHash } from "node:crypto";
import {
  channels,
  contacts,
  conversations,
  messages,
  organizationMembers,
  organizations,
  messageTemplateVariables,
  messageTemplates,
  quickReplies,
  userCredentials,
  users,
} from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, client } = createDatabase(url);
const organizationId = "00000000-0000-4000-8000-000000000001";

await db
  .insert(organizations)
  .values({
    id: organizationId,
    name: "Brix Dental Group",
    slug: "brix-dental",
  })
  .onConflictDoNothing();
await client`
  INSERT INTO organization_entitlements(organization_id,plan_id,trial_status)
  SELECT ${organizationId}::uuid,p.id,'inactive'
  FROM plans p
  WHERE p.code='development'
  ON CONFLICT(organization_id) DO NOTHING`;

const userRows = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    email: "owner@brixchat.local",
    passwordHash: "$2b$12$development-only-seed-hash",
    fullName: "Deniz Aksoy",
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    email: "ece@brixchat.local",
    passwordHash: "$2b$12$development-only-seed-hash",
    fullName: "Ece Kaya",
  },
];
await db.insert(users).values(userRows).onConflictDoNothing();
const developmentPasswordHash = await hashPassword("BrixChatDemo!2026");
await db
  .insert(userCredentials)
  .values(
    userRows.map((user) => ({
      userId: user.id,
      passwordHash: developmentPasswordHash,
    })),
  )
  .onConflictDoUpdate({
    target: userCredentials.userId,
    set: {
      passwordHash: developmentPasswordHash,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    },
  });
await client`UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id IN (${userRows[0]!.id}::uuid,${userRows[1]!.id}::uuid)`;
await db
  .insert(organizationMembers)
  .values([
    { organizationId, userId: userRows[0]!.id, role: "owner" },
    { organizationId, userId: userRows[1]!.id, role: "agent" },
  ])
  .onConflictDoNothing();

const channelId = "00000000-0000-4000-8000-000000000021";
await db
  .insert(channels)
  .values({
    id: channelId,
    publicId: "00000000-0000-4000-8000-000000000022",
    organizationId,
    name: "Clinic Europe",
    provider: "fake",
    phoneNumber: "+90 850 555 2400",
    phoneNumberId: "fake-phone-1",
  })
  .onConflictDoUpdate({
    target: channels.id,
    set: {
      publicId: "00000000-0000-4000-8000-000000000022",
      provider: "fake",
      phoneNumberId: "fake-phone-1",
      status: "connected",
    },
  });

await client`INSERT INTO channel_user_ownership(organization_id,channel_id,user_id,relationship_type,is_primary) VALUES(${organizationId}::uuid,${channelId}::uuid,${userRows[0]!.id}::uuid,'owner',true) ON CONFLICT(organization_id,channel_id,user_id) DO UPDATE SET is_primary=true,updated_at=now()`;

const contactId = "00000000-0000-4000-8000-000000000031";
await db
  .insert(contacts)
  .values({
    id: contactId,
    organizationId,
    firstName: "Elena",
    lastName: "Petrova",
    displayName: "Elena Petrova",
    normalizedPhone: "+447700900123",
    email: "elena@example.test",
    language: "en",
    country: "GB",
  })
  .onConflictDoNothing();

const conversationId = "10000000-0000-4000-8000-000000000001";
await db
  .insert(conversations)
  .values({
    id: conversationId,
    organizationId,
    contactId,
    channelId,
    assigneeId: userRows[1]!.id,
    status: "open",
    priority: "high",
    stage: "Fotoğraf Bekleniyor",
    unreadCount: 2,
    customerServiceWindowExpiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
  })
  .onConflictDoUpdate({
    target: conversations.id,
    set: {
      customerServiceWindowExpiresAt: new Date(
        Date.now() + 20 * 60 * 60 * 1000,
      ),
      assigneeId: userRows[1]!.id,
      stage: "Fotoğraf Bekleniyor",
      status: "open",
      priority: "high",
      unreadCount: 2,
      pinnedAt: null,
      mutedUntil: null,
      blockedAt: null,
    },
  });

await db
  .insert(messages)
  .values([
    {
      id: "20000000-0000-4000-8000-000000000001",
      organizationId,
      conversationId,
      channelId,
      contactId,
      direction: "inbound",
      type: "text",
      status: "read",
      body: "Hello, I am interested in an implant treatment. Could you share the next steps?",
      providerMessageId: "fake-in-1",
      providerTimestamp: new Date(Date.now() - 12 * 60 * 1000),
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      organizationId,
      conversationId,
      channelId,
      contactId,
      direction: "outbound",
      type: "text",
      status: "read",
      body: "Of course. Please send a panoramic X-ray and three clear photos.",
      senderId: userRows[1]!.id,
      clientMessageId: "20000000-0000-4000-8000-000000000012",
      providerMessageId: "fake-out-1",
      providerTimestamp: new Date(Date.now() - 7 * 60 * 1000),
    },
    {
      id: "20000000-0000-4000-8000-000000000003",
      organizationId,
      conversationId,
      channelId,
      contactId,
      direction: "inbound",
      type: "text",
      status: "delivered",
      body: "Thank you, I can send the photos this evening.",
      providerMessageId: "fake-in-2",
      providerTimestamp: new Date(Date.now() - 2 * 60 * 1000),
    },
  ])
  .onConflictDoNothing();

const closedContactId = "00000000-0000-4000-8000-000000000032";
await db
  .insert(contacts)
  .values({
    id: closedContactId,
    organizationId,
    firstName: "Mert",
    lastName: "Yılmaz",
    displayName: "Mert Yılmaz",
    normalizedPhone: "+905551112233",
    language: "tr",
    country: "TR",
  })
  .onConflictDoNothing();
await db
  .insert(conversations)
  .values({
    id: "10000000-0000-4000-8000-000000000002",
    organizationId,
    contactId: closedContactId,
    channelId,
    assigneeId: userRows[1]!.id,
    status: "open",
    priority: "normal",
    stage: "Takip",
    unreadCount: 0,
    customerServiceWindowExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
  })
  .onConflictDoUpdate({
    target: conversations.id,
    set: {
      customerServiceWindowExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      assigneeId: userRows[1]!.id,
      status: "open",
      priority: "normal",
      stage: "Takip",
      unreadCount: 0,
      pinnedAt: null,
      mutedUntil: null,
      blockedAt: null,
    },
  });
await db
  .insert(messages)
  .values({
    id: "20000000-0000-4000-8000-000000000004",
    organizationId,
    conversationId: "10000000-0000-4000-8000-000000000002",
    channelId,
    contactId: closedContactId,
    direction: "inbound",
    type: "text",
    status: "read",
    body: "Randevu hatırlatması alabilir miyim?",
    providerMessageId: "fake-in-closed-1",
    providerTimestamp: new Date(Date.now() - 26 * 60 * 60 * 1000),
  })
  .onConflictDoNothing();

const templateId = "30000000-0000-4000-8000-000000000001";
await db
  .insert(messageTemplates)
  .values({
    id: templateId,
    organizationId,
    channelId,
    provider: "fake",
    providerTemplateId: "fake-welcome-en",
    businessAccountId: `channel:${channelId}`,
    name: "welcome_patient",
    normalizedName: "welcome_patient",
    language: "en_US",
    category: "UTILITY",
    status: "approved",
    bodyText: "Hello {{1}}, your appointment is on {{2}}.",
    providerPayload: { source: "development-seed" },
  })
  .onConflictDoUpdate({
    target: [
      messageTemplates.channelId,
      messageTemplates.name,
      messageTemplates.language,
    ],
    set: {
      businessAccountId: `channel:${channelId}`,
      normalizedName: "welcome_patient",
      status: "approved",
      bodyText: "Hello {{1}}, your appointment is on {{2}}.",
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    },
  });
await db
  .insert(messageTemplateVariables)
  .values([
    {
      templateId,
      component: "body",
      position: 1,
      variableName: "patient_name",
      exampleValue: "Elena",
    },
    {
      templateId,
      component: "body",
      position: 2,
      variableName: "appointment_date",
      exampleValue: "July 24",
    },
  ])
  .onConflictDoNothing();
await db
  .insert(quickReplies)
  .values({
    id: "40000000-0000-4000-8000-000000000001",
    organizationId,
    title: "Greeting",
    shortcut: "hello",
    normalizedShortcut: "hello",
    familyKey: "hello",
    content:
      "Hello {{contact.first_name}}, I am {{agent.first_name}} from {{organization.name}}.",
    language: "en",
    scope: "organization",
    createdBy: userRows[0]!.id,
  })
  .onConflictDoNothing();

await client`
  INSERT INTO integration_connections(id,organization_id,public_id,provider,name,auth_mode,portal_url,status,settings,webhook_token_hash,created_by)
  VALUES('50000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'50000000-0000-4000-8000-000000000002'::uuid,'bitrix24','Bitrix24 Demo','fake','https://fake.bitrix24.local','connected',${JSON.stringify({ fakeScenario: "success", syncResponsible: true, timelineEnabled: true })}::jsonb,${createHash("sha256").update("local-bitrix-webhook-token-2026").digest("hex")},${userRows[0]!.id}::uuid)
  ON CONFLICT(id) DO UPDATE SET status='connected',settings=EXCLUDED.settings,webhook_token_hash=EXCLUDED.webhook_token_hash,updated_at=now()`;
await client`
  INSERT INTO crm_entity_links(id,organization_id,connection_id,conversation_id,contact_id,entity_type,external_id,match_source,match_confidence,created_by)
  VALUES('51000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,${conversationId}::uuid,${contactId}::uuid,'contact','501','phone',1,${userRows[0]!.id}::uuid)
  ON CONFLICT(id) DO UPDATE SET
    organization_id=EXCLUDED.organization_id,
    connection_id=EXCLUDED.connection_id,
    conversation_id=EXCLUDED.conversation_id,
    contact_id=EXCLUDED.contact_id,
    entity_type=EXCLUDED.entity_type,
    external_id=EXCLUDED.external_id,
    match_source=EXCLUDED.match_source,
    match_confidence=EXCLUDED.match_confidence,
    created_by=EXCLUDED.created_by,
    updated_at=now()`;
await client`
  INSERT INTO conversation_crm_context_cache(organization_id,conversation_id,connection_id,link_id,context,fetched_at,stale_at)
  VALUES(${organizationId}::uuid,${conversationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,'51000000-0000-4000-8000-000000000001'::uuid,${JSON.stringify({ entity: { entityType: "contact", externalId: "501", displayName: "Elena Petrova" }, responsible: { externalId: "101", name: "Ayşe Yılmaz", email: "ayse@example.test", active: true }, company: "Brix Dental", pipeline: "Satış", stage: "Yeni", fields: { SOURCE_ID: "WHATSAPP" } })}::jsonb,now(),now()+interval '15 minutes')
  ON CONFLICT(organization_id,conversation_id) DO UPDATE SET context=EXCLUDED.context,fetched_at=now(),stale_at=EXCLUDED.stale_at`;
await client`
  INSERT INTO crm_user_mappings(organization_id,connection_id,local_user_id,external_user_id,external_snapshot)
  VALUES(${organizationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,${userRows[1]!.id}::uuid,'101',${JSON.stringify({ name: "Ayşe Yılmaz", email: "ayse@example.test" })}::jsonb)
  ON CONFLICT(connection_id,external_user_id) DO UPDATE SET local_user_id=EXCLUDED.local_user_id,external_snapshot=EXCLUDED.external_snapshot,active=true,last_synced_at=now()`;
await client`
  INSERT INTO conversation_labels(
    id,organization_id,name,normalized_name,color,created_by
  ) VALUES
  ('52000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'VIP',normalize_conversation_label_name('VIP'),'#7c3aed',${userRows[0]!.id}::uuid),
  ('52000000-0000-4000-8000-000000000002'::uuid,${organizationId}::uuid,'Takip',normalize_conversation_label_name('Takip'),'#0ea5e9',${userRows[0]!.id}::uuid)
  ON CONFLICT(organization_id,normalized_name)
    WHERE deleted_at IS NULL AND status<>'merged'
  DO UPDATE SET color=EXCLUDED.color,updated_at=now()`;
await client`
  INSERT INTO conversation_label_assignments(
    organization_id,conversation_id,label_id,assigned_by,assigned_at
  )
  VALUES(${organizationId}::uuid,${conversationId}::uuid,'52000000-0000-4000-8000-000000000001'::uuid,${userRows[0]!.id}::uuid,now())
  ON CONFLICT(conversation_id,label_id) DO NOTHING`;
await client`
  INSERT INTO agent_capacity_status(organization_id,user_id,capacity,active_count,availability)
  VALUES(${organizationId}::uuid,${userRows[1]!.id}::uuid,20,1,'available')
  ON CONFLICT(organization_id,user_id) DO UPDATE SET capacity=EXCLUDED.capacity,active_count=EXCLUDED.active_count,availability=EXCLUDED.availability,updated_at=now()`;
await client`
  INSERT INTO saved_views(id,organization_id,owner_user_id,name,visibility,filters,sort,is_default)
  VALUES('53000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,${userRows[0]!.id}::uuid,'CRM bağlantılı','shared',${JSON.stringify({ crmLinked: true })}::jsonb,${JSON.stringify({ field: "lastMessageAt", direction: "desc" })}::jsonb,false)
  ON CONFLICT(organization_id,owner_user_id,name) DO UPDATE SET filters=EXCLUDED.filters,sort=EXCLUDED.sort,updated_at=now()`;

await client`UPDATE integration_connections SET bitrix_mode='both',open_channels_status='registered',settings=settings||${JSON.stringify({ openChannels: { incomingEnabled: true, outgoingEnabled: true, timelinePolicy: "session_summary" } })}::jsonb WHERE id='50000000-0000-4000-8000-000000000001'::uuid`;
await client`INSERT INTO bitrix_open_channel_connectors(id,organization_id,integration_connection_id,connector_id,line_id,status,settings) VALUES('60000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,'fake-connector','fake-line','active','{"incomingEnabled":true,"outgoingEnabled":true}'::jsonb) ON CONFLICT(integration_connection_id) DO UPDATE SET status='active',line_id='fake-line',updated_at=now()`;
await client`INSERT INTO bitrix_open_channel_bindings(organization_id,integration_connection_id,brixchat_channel_id,connector_id,line_id,status,settings,last_success_at) VALUES(${organizationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,${channelId}::uuid,'fake-connector','fake-line','active','{"incomingEnabled":true,"outgoingEnabled":true,"deliveryStatusSync":true,"sessionCloseSync":true,"autoCrmMode":"disabled","timelinePolicy":"session_summary"}'::jsonb,now()) ON CONFLICT(organization_id,brixchat_channel_id) DO UPDATE SET connector_id='fake-connector',line_id='fake-line',status='active',updated_at=now()`;
await client`INSERT INTO bitrix_open_channel_sessions(id,organization_id,integration_connection_id,conversation_id,connector_id,line_id,external_chat_id,external_session_id,external_user_code,status,last_synced_at) VALUES('61000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'50000000-0000-4000-8000-000000000001'::uuid,${conversationId}::uuid,'fake-connector','fake-line','fake-chat-seed','fake-session-seed','905551112233','open',now()) ON CONFLICT(integration_connection_id,conversation_id) DO UPDATE SET status='open',last_synced_at=now()`;
await client`INSERT INTO organization_retention_settings(organization_id,updated_by) VALUES(${organizationId}::uuid,${userRows[0]!.id}::uuid) ON CONFLICT(organization_id) DO NOTHING`;
await client`INSERT INTO automation_rules(id,organization_id,name,description,status,priority,created_by,updated_by,published_version,draft_version) VALUES('62000000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'Yeni mesaj triyajı','Fake acceptance rule','active',100,${userRows[0]!.id}::uuid,${userRows[0]!.id}::uuid,1,1) ON CONFLICT(id) DO UPDATE SET status='active',published_version=1,updated_at=now()`;
await client`INSERT INTO automation_rule_versions(id,organization_id,rule_id,version,status,permission_snapshot,created_by,published_at) VALUES('62100000-0000-4000-8000-000000000001'::uuid,${organizationId}::uuid,'62000000-0000-4000-8000-000000000001'::uuid,1,'published','{"role":"owner"}'::jsonb,${userRows[0]!.id}::uuid,now()) ON CONFLICT(rule_id,version) DO NOTHING`;
await client`INSERT INTO automation_rule_triggers(version_id,trigger_type) VALUES('62100000-0000-4000-8000-000000000001'::uuid,'message.received') ON CONFLICT DO NOTHING`;
await client`INSERT INTO automation_rule_conditions(version_id,position,field,operator,value) VALUES('62100000-0000-4000-8000-000000000001'::uuid,0,'channelId','equals',to_jsonb(${channelId}::text)) ON CONFLICT(version_id,position) DO NOTHING`;
await client`INSERT INTO automation_rule_actions(version_id,position,action_type,config) VALUES('62100000-0000-4000-8000-000000000001'::uuid,0,'add_label',${JSON.stringify({ labelId: "52000000-0000-4000-8000-000000000002" })}::jsonb),('62100000-0000-4000-8000-000000000001'::uuid,1,'assign_user',${JSON.stringify({ userId: userRows[1]!.id })}::jsonb) ON CONFLICT(version_id,position) DO NOTHING`;
await client`INSERT INTO operational_metrics(metric_name,label_key,metric_value) VALUES('outbox_pending','',0),('media_download_total','',0),('automation_run_total','',0),('open_channel_sync_failed','',0) ON CONFLICT(metric_name,label_key) DO NOTHING`;

await client.end();
