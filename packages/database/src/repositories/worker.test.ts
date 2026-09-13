import { describe, expect, it } from "vitest";
import {
  inboundAutomationEventTypes,
  nextStoredMessageStatus,
  WorkerRepository,
} from "./worker";
import type { DatabaseClient } from "../index";

interface QueryCall {
  text: string;
  values: unknown[];
}

type StubSql = ((first: unknown, ...values: unknown[]) => unknown) & {
  begin: (
    callback: (transaction: DatabaseClient) => Promise<unknown>,
  ) => Promise<unknown>;
  json: (value: unknown) => unknown;
};

function createSqlStub(responses: unknown[][] = []) {
  const calls: QueryCall[] = [];
  const stub = ((first: unknown, ...values: unknown[]) => {
    if (
      Array.isArray(first) &&
      Object.prototype.hasOwnProperty.call(first, "raw")
    ) {
      calls.push({ text: (first as string[]).join("?"), values });
      return Promise.resolve(responses.shift() ?? []);
    }
    return { values: first };
  }) as StubSql;
  stub.begin = async (callback) => callback(stub as unknown as DatabaseClient);
  stub.json = (value) => value;
  return { sql: stub as unknown as DatabaseClient, calls };
}

describe("WorkerRepository webhook channel health", () => {
  it("claims outbox work with a stale-lock lease and SKIP LOCKED", async () => {
    const { sql, calls } = createSqlStub([[]]);

    const claimed = await new WorkerRepository(sql).claimOutbox("worker-a");

    expect(claimed).toBeNull();
    expect(calls[0]?.text).toContain("FOR UPDATE OF o SKIP LOCKED");
    expect(calls[0]?.text).toContain("locked_at<now()-interval '2 minutes'");
    expect(calls[0]?.text).toContain("locked_by=");
    expect(calls[0]?.values).toContain("worker-a");
  });

  it("claims webhook work with a stale-lock lease and SKIP LOCKED", async () => {
    const { sql, calls } = createSqlStub([[]]);

    const claimed = await new WorkerRepository(sql).claimWebhook("worker-b");

    expect(claimed).toBeNull();
    expect(calls[0]?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]?.text).toContain("locked_at<now()-interval '2 minutes'");
    expect(calls[0]?.text).toContain("locked_by=");
    expect(calls[0]?.values).toContain("worker-b");
  });

  it("marks the latest webhook as processed when worker handling completes", async () => {
    const { sql, calls } = createSqlStub();

    await new WorkerRepository(sql).completeWebhook(
      "90000000-0000-4000-8000-000000000001",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("last_webhook_result='processed'");
    expect(calls[0]?.text).toContain(
      "c.last_webhook_at<=completed.received_at",
    );
  });

  it("marks terminal failures separately from retrying webhook work", async () => {
    const { sql, calls } = createSqlStub();

    await new WorkerRepository(sql).failWebhook(
      "90000000-0000-4000-8000-000000000001",
      "database unavailable",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("THEN 'failed'");
    expect(calls[0]?.text).toContain("ELSE 'retrying'");
    expect(calls[0]?.values).toContain("database unavailable");
  });
});

describe("WorkerRepository provider delivery ordering", () => {
  it("emits an automation event only for terminal delivery failures", async () => {
    const terminal = createSqlStub();
    await new WorkerRepository(terminal.sql).fail(
      {
        id: "80000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000001",
        messageId: "20000000-0000-4000-8000-000000000001",
        attemptCount: 5,
        maxAttempts: 5,
        traceId: "70000000-0000-4000-8000-000000000001",
        jobType: "message.send",
      },
      {
        code: "recipient_not_available",
        retryable: false,
        delay: null,
      },
    );

    const automationEvent = terminal.calls.find((call) =>
      call.text.includes("'message.delivery_failed'"),
    );
    expect(automationEvent?.text).toContain("jsonb_build_object");
    expect(automationEvent?.values).toContain("recipient_not_available");
    expect(automationEvent?.values).toContain("recipient_unavailable");
    expect(automationEvent?.values).toContain(true);

    const retrying = createSqlStub();
    await new WorkerRepository(retrying.sql).fail(
      {
        id: "80000000-0000-4000-8000-000000000002",
        organizationId: "00000000-0000-4000-8000-000000000001",
        messageId: "20000000-0000-4000-8000-000000000002",
        attemptCount: 1,
        maxAttempts: 5,
        traceId: "70000000-0000-4000-8000-000000000002",
        jobType: "message.send",
      },
      {
        code: "provider_timeout",
        retryable: true,
        delay: 1_000,
      },
    );
    expect(
      retrying.calls.some((call) =>
        call.text.includes("'message.delivery_failed'"),
      ),
    ).toBe(false);
  });

  it("does not regress delivered or read messages on late callbacks", () => {
    expect(nextStoredMessageStatus("sent", "failed")).toBe("failed");
    expect(nextStoredMessageStatus("delivered", "failed")).toBe("delivered");
    expect(nextStoredMessageStatus("read", "failed")).toBe("read");
    expect(nextStoredMessageStatus("failed", "read")).toBe("failed");
  });

  it("classifies failed delivery callbacks and emits an automation event", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          id: "20000000-0000-4000-8000-000000000001",
          conversation_id: "30000000-0000-4000-8000-000000000001",
          status: "sent",
        },
      ],
      [{ id: "90000000-0000-4000-8000-000000000001" }],
      [],
      [],
    ]);

    const result = await new WorkerRepository(sql).status({
      organizationId: "00000000-0000-4000-8000-000000000001",
      providerMessageId: "wamid.failed",
      status: "failed",
      providerTimestamp: new Date("2026-08-18T10:00:00.000Z"),
      eventKey: "meta-status-failed",
      payload: { errors: [{ code: 131026 }] },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "META_131026",
      failureCategory: "recipient_unavailable",
      customerRelated: true,
      automationEligible: true,
    });
    const automationEvent = calls.find((call) =>
      call.text.includes("'provider.delivery'"),
    );
    expect(automationEvent?.values).toContain("META_131026");
    expect(automationEvent?.values).toContain("recipient_unavailable");
  });

  it("replays a buffered failed callback into the delivery automation stream", async () => {
    const { sql, calls } = createSqlStub([
      [],
      [
        {
          status: "failed",
          provider_timestamp: "2026-08-18T10:00:00.000Z",
          payload: { errors: [{ code: 131050 }] },
          event_key: "status-failed-before-provider-id",
        },
      ],
      [{ id: "90000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const finalStatus = await new WorkerRepository(sql).complete(
      {
        id: "80000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000001",
        messageId: "20000000-0000-4000-8000-000000000001",
        attemptCount: 1,
        maxAttempts: 5,
        traceId: "70000000-0000-4000-8000-000000000001",
        jobType: "message.send",
      },
      "wamid.status-failed-before-provider-id",
    );

    expect(finalStatus).toBe("failed");
    const automationEvent = calls.find((call) =>
      call.text.includes("'provider.delivery'"),
    );
    expect(automationEvent?.values).toContain("META_131050");
    expect(automationEvent?.values).toContain("recipient_opted_out");
  });

  it("replays buffered callbacks when provider acknowledgement is persisted", async () => {
    const { sql, calls } = createSqlStub([
      [],
      [
        {
          status: "delivered",
          provider_timestamp: "2026-07-25T12:00:00.000Z",
          payload: { status: "delivered" },
          event_key: "status-before-provider-id",
        },
      ],
      [{ id: "90000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
      [],
      [],
    ]);

    const finalStatus = await new WorkerRepository(sql).complete(
      {
        id: "80000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000001",
        messageId: "20000000-0000-4000-8000-000000000001",
        attemptCount: 1,
        maxAttempts: 5,
        traceId: "70000000-0000-4000-8000-000000000001",
        jobType: "message.send",
      },
      "wamid.status-before-provider-id",
    );

    expect(finalStatus).toBe("delivered");
    expect(
      calls.some((call) =>
        call.text.includes("FROM pending_message_status_events"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.text.includes("UPDATE messages SET status=") &&
          call.values.includes("delivered"),
      ),
    ).toBe(true);
    expect(
      calls.some((call) =>
        call.text.includes("DELETE FROM pending_message_status_events"),
      ),
    ).toBe(true);
    const outgoingJob = calls.find((call) =>
      call.text.includes("'open_channels.outgoing'"),
    );
    expect(outgoingJob?.values).toContain(
      "outgoing-provider:wamid.status-before-provider-id",
    );
    expect(outgoingJob?.text).toContain(
      "m.metadata->>'origin' IS DISTINCT FROM 'bitrix_open_channels'",
    );
    expect(outgoingJob?.text).toContain("binding.settings->>'outgoingEnabled'");
  });

  it("prunes only old status callbacks that still have no matching message", async () => {
    const { sql, calls } = createSqlStub([
      [
        { id: "90000000-0000-4000-8000-000000000001" },
        { id: "90000000-0000-4000-8000-000000000002" },
      ],
    ]);

    const deleted = await new WorkerRepository(
      sql,
    ).pruneOrphanedPendingStatuses(72, 100);

    expect(deleted).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("pending.created_at < now()-");
    expect(calls[0]?.text).toContain("AND NOT EXISTS");
    expect(calls[0]?.text).toContain(
      "message.organization_id=pending.organization_id",
    );
    expect(calls[0]?.text).toContain(
      "message.provider_message_id=pending.provider_message_id",
    );
    expect(calls[0]?.text).toContain("FOR UPDATE OF pending SKIP LOCKED");
    expect(calls[0]?.values).toEqual([72, 100]);
  });
});

describe("WorkerRepository inbound automation events", () => {
  it("fans WhatsApp Web group messages out to group and mention triggers", () => {
    expect(
      inboundAutomationEventTypes({
        provider: "whatsapp_web",
        isGroup: true,
        hasMentions: true,
      }),
    ).toEqual([
      "message.received",
      "group.message.received",
      "group.keyword_matched",
      "group.mentioned",
    ]);
  });

  it("keeps direct and non-Web messages on the canonical event only", () => {
    expect(
      inboundAutomationEventTypes({
        provider: "meta",
        isGroup: true,
        hasMentions: true,
      }),
    ).toEqual(["message.received"]);
  });
});

describe("WorkerRepository provider-neutral delivery context", () => {
  it("uses the conversation channel adapter and provider-account credentials", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          message_id: "20000000-0000-4000-8000-000000000001",
          organization_id: "00000000-0000-4000-8000-000000000001",
          conversation_id: "10000000-0000-4000-8000-000000000001",
          channel_id: "00000000-0000-4000-8000-000000000022",
          body: "Merhaba",
          client_message_id: "70000000-0000-4000-8000-000000000001",
          type: "text",
          metadata: {},
          normalized_phone: "905551234567",
          provider: "meta",
          platform: "whatsapp",
          phone_number_id: "123456",
          business_account_id: "waba-1",
          credentials_encrypted: "encrypted",
        },
      ],
    ]);

    const context = await new WorkerRepository(sql).deliveryContext({
      id: "80000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000001",
      messageId: "20000000-0000-4000-8000-000000000001",
      attemptCount: 1,
      maxAttempts: 5,
      traceId: "90000000-0000-4000-8000-000000000001",
      jobType: "message.send",
    });

    expect(context).toMatchObject({
      provider: "meta",
      platform: "whatsapp",
      credentialsEncrypted: "encrypted",
    });
    expect(calls[0]?.text).toContain("provider_accounts");
    expect(calls[0]?.text).toContain("ch.connection_status");
  });
});

describe("WorkerRepository inbound conversation pointer", () => {
  it("stores a WhatsApp Web linked-device echo as outbound without creating inbound side effects", async () => {
    const providerTimestamp = new Date("2026-08-04T09:15:00.000Z");
    const { sql, calls } = createSqlStub([
      [{ id: "30000000-0000-4000-8000-000000000001" }],
      [],
      [{ id: "10000000-0000-4000-8000-000000000001", status: "open" }],
      [{ id: "20000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
      [],
    ]);

    await new WorkerRepository(sql).incoming({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      phone: "+351910873481",
      name: "lucy",
      text: "See you soon",
      type: "text",
      providerMessageId: "whatsapp-web-from-me-1",
      providerTimestamp,
      metadata: { provider: "whatsapp_web", fromMe: true },
      provider: "whatsapp_web",
      direction: "outbound",
      preserveContactName: true,
      traceId: "40000000-0000-4000-8000-000000000001",
    });

    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO messages"),
    );
    expect(insert?.values).toContain("outbound");
    expect(insert?.values).toContain("sent");

    const contactUpsert = calls.find((call) =>
      call.text.includes("INSERT INTO contacts"),
    );
    expect(contactUpsert?.values).toContain(true);
    expect(contactUpsert?.text).toContain("THEN contacts.display_name");

    const conversationUpdate = calls.find(
      (call) =>
        call.text.includes("UPDATE conversations") &&
        call.text.includes("last_message_id=CASE"),
    );
    expect(conversationUpdate?.text).toContain(
      "unread_count=unread_count+CASE WHEN",
    );
    expect(conversationUpdate?.values).toContain("outbound");

    const channelUpdate = calls.find((call) =>
      call.text.includes("UPDATE channels SET"),
    );
    expect(channelUpdate?.text).toContain("last_outbound_at=CASE");
    const flowEvent = calls.find((call) =>
      call.text.includes("INSERT INTO message_flow_events"),
    );
    expect(flowEvent?.values).toContain("provider.echo_processed");
    expect(
      calls.some((call) => call.text.includes("INSERT INTO automation_events")),
    ).toBe(false);
    expect(
      calls.some((call) => call.text.includes("open_channels.incoming")),
    ).toBe(false);
    const outgoingJob = calls.find((call) =>
      call.text.includes("'open_channels.outgoing'"),
    );
    expect(outgoingJob?.values).toContain(
      "outgoing-provider:whatsapp-web-from-me-1",
    );
    expect(JSON.stringify(outgoingJob?.values)).toContain(
      "channel:00000000-0000-4000-8000-000000000022:whatsapp_web:whatsapp-web-from-me-1",
    );
    expect(outgoingJob?.text).toContain("binding.settings->>'outgoingEnabled'");
  });

  it("reopens the archived conversation instead of splitting message history", async () => {
    const archivedConversationId = "10000000-0000-4000-8000-000000000001";
    const providerTimestamp = new Date("2026-07-25T19:35:00.000Z");
    const { sql, calls } = createSqlStub([
      [{ id: "30000000-0000-4000-8000-000000000001" }],
      [],
      [{ id: archivedConversationId, status: "archived" }],
      [],
      [{ id: "20000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
      [],
      [],
    ]);

    const result = await new WorkerRepository(sql).incoming({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      phone: "905076210286",
      name: "Hasan",
      text: "Yeni mesaj",
      type: "text",
      providerMessageId: "meta-archived-reopen-1",
      providerTimestamp,
      metadata: {},
      traceId: "40000000-0000-4000-8000-000000000001",
    });

    expect(result.conversationId).toBe(archivedConversationId);
    expect(result.conversationCreated).toBe(false);
    expect(
      calls.some((call) => call.text.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    const lookup = calls.find((call) =>
      call.text.includes("SELECT id,status FROM conversations"),
    );
    expect(lookup?.text).toContain("'archived'");
    expect(lookup?.text).toContain("conversation.canonicalized");
    expect(lookup?.text).toContain("FOR UPDATE");
    const reopen = calls.find(
      (call) =>
        call.text.includes("UPDATE conversations") &&
        call.text.includes("status='open'"),
    );
    expect(reopen?.text).toContain("closed_at=NULL");
    expect(
      calls.some((call) => call.text.includes("INSERT INTO conversations")),
    ).toBe(false);
    const crmJob = calls.find((call) =>
      call.text.includes("'open_channels.crm'"),
    );
    const incomingJobIndex = calls.findIndex((call) =>
      call.text.includes("'open_channels.incoming'"),
    );
    const crmJobIndex = calls.findIndex((call) =>
      call.text.includes("'open_channels.crm'"),
    );
    expect(incomingJobIndex).toBeGreaterThanOrEqual(0);
    expect(crmJobIndex).toBeGreaterThan(incomingJobIndex);
    expect(calls[incomingJobIndex]?.text).toContain(
      "binding.settings->>'incomingEnabled'",
    );
    expect(calls[incomingJobIndex]?.text).toContain(
      "binding.brixchat_channel_id",
    );
    expect(calls[incomingJobIndex]?.text).not.toContain("LIMIT 1");
    expect(crmJob?.values).toContain(
      `crm:${archivedConversationId}:20000000-0000-4000-8000-000000000001`,
    );
    expect(crmJob?.text).toContain("crm_contact_exclusions");
    expect(crmJob?.text).toContain("CRM_REVIEW_PENDING");
    expect(crmJob?.text).toContain("'manual_review'");
    expect(crmJob?.text).toContain("'dead_letter'");
    expect(crmJob?.text).toContain("ON CONFLICT DO NOTHING");
  });

  it("does not let a delayed Meta event regress the latest message or service window", async () => {
    const providerTimestamp = new Date("2026-07-20T20:29:34.000Z");
    const { sql, calls } = createSqlStub([
      [{ id: "30000000-0000-4000-8000-000000000001" }],
      [],
      [{ id: "10000000-0000-4000-8000-000000000001" }],
      [{ id: "20000000-0000-4000-8000-000000000001" }],
      [],
      [],
      [],
      [],
      [],
    ]);

    await new WorkerRepository(sql).incoming({
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelId: "00000000-0000-4000-8000-000000000022",
      phone: "447700900321",
      name: "Inbox Ordering",
      text: "Newest Meta message",
      type: "text",
      providerMessageId: "meta-message-1",
      providerTimestamp,
      metadata: {},
      traceId: "40000000-0000-4000-8000-000000000001",
    });

    const update = calls.find((call) =>
      call.text.includes("UPDATE conversations"),
    );
    expect(update?.text).toContain("last_message_id=CASE");
    expect(update?.text).toContain("last_message_at=CASE");
    expect(update?.text).toContain("last_message_at<=");
    expect(update?.text).toContain("GREATEST(");
    expect(update?.values).toContain(providerTimestamp);
    expect(update?.values).toContain("20000000-0000-4000-8000-000000000001");
  });
});

describe("WorkerRepository automation-triggered conversation resolution", () => {
  it("resolves an existing conversation for a phone number without creating a message", async () => {
    const { sql, calls } = createSqlStub([
      [{ id: "30000000-0000-4000-8000-000000000009" }],
      [],
      [{ id: "10000000-0000-4000-8000-000000000009", status: "open" }],
    ]);

    const result = await new WorkerRepository(sql).resolveConversationForPhone(
      {
        organizationId: "00000000-0000-4000-8000-000000000001",
        channelId: "00000000-0000-4000-8000-000000000021",
        phone: "+905551239999",
      },
    );

    expect(result).toEqual({
      contactId: "30000000-0000-4000-8000-000000000009",
      conversationId: "10000000-0000-4000-8000-000000000009",
    });
    expect(
      calls.some((call) => call.text.includes("INSERT INTO messages")),
    ).toBe(false);
  });

  it("creates a new conversation when none exists, falling back to the phone as the display name", async () => {
    const { sql, calls } = createSqlStub([
      [{ id: "30000000-0000-4000-8000-000000000010" }],
      [],
      [],
      [{ id: "10000000-0000-4000-8000-000000000010" }],
      [],
    ]);

    const result = await new WorkerRepository(sql).resolveConversationForPhone(
      {
        organizationId: "00000000-0000-4000-8000-000000000001",
        channelId: "00000000-0000-4000-8000-000000000021",
        phone: "+905551239999",
      },
    );

    expect(result).toEqual({
      contactId: "30000000-0000-4000-8000-000000000010",
      conversationId: "10000000-0000-4000-8000-000000000010",
    });
    const contactInsert = calls.find((call) =>
      call.text.includes("INSERT INTO contacts"),
    );
    expect(contactInsert?.values).toContain("+905551239999");
    expect(
      calls.some((call) => call.text.includes("INSERT INTO messages")),
    ).toBe(false);
  });
});
