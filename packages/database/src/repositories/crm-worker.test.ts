import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../index";
import {
  CrmWorkerRepository,
  normalizeBitrixOperatorMessage,
  type ClaimedCrmWebhook,
} from "./crm-worker";

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

const leadUpdateWebhook: ClaimedCrmWebhook = {
  id: "90000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000001",
  connectionId: "10000000-0000-4000-8000-000000000001",
  eventType: "ONCRMLEADUPDATE",
  payload: {},
  settings: {},
  authMode: "oauth",
  portalUrl: "https://example.bitrix24.com",
  credentialsEncrypted: "encrypted",
};

describe("CrmWorkerRepository webhook recovery", () => {
  it("reclaims stale processing work and records the worker lock", async () => {
    const { sql, calls } = createSqlStub([[]]);

    const claimed = await new CrmWorkerRepository(sql).claimWebhook(
      "worker-recovery-test",
    );

    expect(claimed).toBeNull();
    expect(calls[0]?.text).toContain("status='processing'");
    expect(calls[0]?.text).toContain("locked_at<now()-interval '2 minutes'");
    expect(calls[0]?.text).toContain("locked_at=now(),locked_by=");
    expect(calls[0]?.values).toContain("worker-recovery-test");
  });

  it("clears webhook locks on both success and retry", async () => {
    const { sql, calls } = createSqlStub();
    const repository = new CrmWorkerRepository(sql);

    await repository.completeWebhook(leadUpdateWebhook.id);
    await repository.failWebhook(leadUpdateWebhook.id, "temporary failure");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain("locked_at=NULL,locked_by=NULL");
    expect(calls[1]?.text).toContain("locked_at=NULL,locked_by=NULL");
  });
});

describe("CrmWorkerRepository responsible webhook mapping", () => {
  it("skips an external Bitrix user that has no local user mapping", async () => {
    const { sql, calls } = createSqlStub([[]]);

    const processed = await new CrmWorkerRepository(
      sql,
    ).processResponsibleWebhook(leadUpdateWebhook, {
      entityType: "lead",
      externalId: "172336",
      externalUserId: "32",
    });

    expect(processed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("m.local_user_id IS NOT NULL");
    expect(
      calls.some((call) => call.text.includes("UPDATE conversations")),
    ).toBe(false);
  });

  it("assigns the conversation when the external user has a local mapping", async () => {
    const localUserId = "20000000-0000-4000-8000-000000000001";
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const { sql, calls } = createSqlStub([
      [
        {
          conversation_id: conversationId,
          local_user_id: localUserId,
          assignee_id: null,
          operation_version: 4,
        },
      ],
      [],
      [],
    ]);

    const processed = await new CrmWorkerRepository(
      sql,
    ).processResponsibleWebhook(leadUpdateWebhook, {
      entityType: "lead",
      externalId: "172336",
      externalUserId: "32",
    });

    expect(processed).toBe(true);
    const assignmentUpdate = calls.find((call) =>
      call.text.includes("UPDATE conversations"),
    );
    expect(assignmentUpdate?.values).toContain(localUserId);
    expect(assignmentUpdate?.values).toContain(5);
    expect(
      calls.some((call) =>
        call.text.includes("INSERT INTO assignment_history"),
      ),
    ).toBe(true);
  });

  it("assigns every conversation linked to the same external CRM entity", async () => {
    const localUserId = "20000000-0000-4000-8000-000000000001";
    const firstConversationId = "30000000-0000-4000-8000-000000000001";
    const secondConversationId = "30000000-0000-4000-8000-000000000002";
    const { sql, calls } = createSqlStub([
      [
        {
          conversation_id: firstConversationId,
          local_user_id: localUserId,
          assignee_id: null,
          operation_version: 1,
        },
        {
          conversation_id: secondConversationId,
          local_user_id: localUserId,
          assignee_id: null,
          operation_version: 7,
        },
      ],
      [],
      [],
      [],
      [],
    ]);

    const processed = await new CrmWorkerRepository(
      sql,
    ).processResponsibleWebhook(leadUpdateWebhook, {
      entityType: "lead",
      externalId: "172336",
      externalUserId: "32",
    });

    expect(processed).toBe(true);
    const assignmentUpdates = calls.filter((call) =>
      call.text.includes("UPDATE conversations"),
    );
    expect(assignmentUpdates).toHaveLength(2);
    expect(assignmentUpdates[0]?.values).toContain(firstConversationId);
    expect(assignmentUpdates[1]?.values).toContain(secondConversationId);
    expect(
      calls.filter((call) =>
        call.text.includes("INSERT INTO assignment_history"),
      ),
    ).toHaveLength(2);
    expect(calls[0]?.text).not.toContain("LIMIT 1");
  });
});

describe("CrmWorkerRepository Open Channels settings", () => {
  it("converts Bitrix BBCode to WhatsApp formatting", () => {
    expect(
      normalizeBitrixOperatorMessage(
        "[b]Hasan Yıldırım:[/b] [br]Merhaba [i]Berivan[/i]",
      ),
    ).toBe("*Hasan Yıldırım:*\nMerhaba _Berivan_");
  });

  it("does not send a Bitrix media placeholder as a text message", () => {
    expect(
      normalizeBitrixOperatorMessage("[b]Hasan Yıldırım:[/b] [br][image]"),
    ).toBeNull();
  });

  it("keeps a caption while removing a Bitrix media placeholder", () => {
    expect(
      normalizeBitrixOperatorMessage(
        "[b]Hasan Yıldırım:[/b] [br][image] Tedavi planı ektedir",
      ),
    ).toBe("*Hasan Yıldırım:*\nTedavi planı ektedir");
  });

  it("rejects malformed non-text operator content", () => {
    expect(normalizeBitrixOperatorMessage({ text: "Merhaba" })).toBeNull();
  });

  const operatorWebhook: ClaimedCrmWebhook = {
    ...leadUpdateWebhook,
    id: "90000000-0000-4000-8000-000000000099",
    eventType: "ONIMCONNECTORMESSAGEADD",
    payload: {
      data: {
        CONNECTOR: "brixchat",
        LINE: "120",
        MESSAGES: [
          {
            chat: { id: "+18622183852" },
            im: { chat_id: "80128", message_id: "3255318" },
            message: { text: "Mirrored WhatsApp message", user_id: "32" },
          },
        ],
      },
    },
  };

  it("blocks operator delivery when the recipient is another organization WhatsApp line", async () => {
    const { sql, calls } = createSqlStub([[]]);

    const processed = await new CrmWorkerRepository(sql).processOperatorMessage(
      {
        ...leadUpdateWebhook,
        eventType: "ONIMCONNECTORMESSAGEADD",
        payload: {
          data: {
            CONNECTOR: "brixchat",
            LINE: "126",
            MESSAGES: [
              {
                chat: { id: "+905379524474" },
                message: { id: "3255574", text: "Merhaba" },
                im: { chat_id: "79878", message_id: "3255574" },
              },
            ],
          },
        },
      },
    );

    expect(processed).toBe(false);
    expect(calls[0]?.text).toContain("NOT EXISTS");
    expect(calls[0]?.text).toContain(
      "organization_channel.provider IN ('whatsapp_web','meta')",
    );
    expect(calls[0]?.text).toContain("right(regexp_replace");
    expect(calls[0]?.values).toContain("+905379524474");
    expect(
      calls.some((call) => call.text.includes("INSERT INTO messages")),
    ).toBe(false);
  });

  it("suppresses the Bitrix echo of a mirrored WhatsApp outbound message", async () => {
    const originalMessageId = "20000000-0000-4000-8000-000000000099";
    const { sql, calls } = createSqlStub([
      [
        {
          conversation_id: "30000000-0000-4000-8000-000000000099",
          channel_id: "40000000-0000-4000-8000-000000000099",
          contact_id: "50000000-0000-4000-8000-000000000099",
        },
      ],
      [{ local_message_id: originalMessageId }],
    ]);

    const processed = await new CrmWorkerRepository(sql).processOperatorMessage(
      operatorWebhook,
    );

    expect(processed).toBe(true);
    const suppression = calls.find((call) =>
      call.text.includes("status='echo_suppressed'"),
    );
    expect(suppression?.text).toContain("link.external_chat_id=");
    expect(suppression?.text).toContain("btrim(original.body)=");
    expect(suppression?.text).toContain(
      "right(?,length(btrim(original.body)))=btrim(original.body)",
    );
    expect(suppression?.text).toContain("webhook_event.received_at");
    expect(suppression?.text).toContain("link.status='echo_suppressed'");
    expect(suppression?.text).toContain("link.external_message_id=");
    expect(suppression?.text).toContain("LIMIT 1");
    expect(suppression?.values).toContain("80128");
    expect(suppression?.values).toContain("3255318");
    expect(
      calls.some((call) => call.text.includes("INSERT INTO messages")),
    ).toBe(false);
    expect(
      calls.some((call) => call.text.includes("INSERT INTO outbox_jobs")),
    ).toBe(false);
  });

  it("still sends a genuine Bitrix operator message to WhatsApp", async () => {
    const insertedMessageId = "20000000-0000-4000-8000-000000000100";
    const { sql, calls } = createSqlStub([
      [
        {
          conversation_id: "30000000-0000-4000-8000-000000000099",
          channel_id: "40000000-0000-4000-8000-000000000099",
          contact_id: "50000000-0000-4000-8000-000000000099",
        },
      ],
      [],
      [],
      [{ id: insertedMessageId }],
    ]);

    const processed = await new CrmWorkerRepository(sql).processOperatorMessage(
      {
        ...operatorWebhook,
        payload: {
          data: {
            CONNECTOR: "brixchat",
            LINE: "120",
            MESSAGES: [
              {
                chat: { id: "+18622183852" },
                im: { chat_id: "80128", message_id: "3255320" },
                message: { text: "New operator reply", user_id: "32" },
              },
            ],
          },
        },
      },
    );

    expect(processed).toBe(true);
    expect(
      calls.some((call) => call.text.includes("INSERT INTO messages")),
    ).toBe(true);
    expect(
      calls.some((call) => call.text.includes("INSERT INTO outbox_jobs")),
    ).toBe(true);
  });

  it("queues normalized operator text for an external customer", async () => {
    const messageId = "60000000-0000-4000-8000-000000000001";
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const { sql, calls } = createSqlStub([
      [
        {
          conversation_id: conversationId,
          channel_id: "70000000-0000-4000-8000-000000000001",
          contact_id: "80000000-0000-4000-8000-000000000001",
        },
      ],
      [],
      [],
      [{ id: messageId }],
      [],
      [],
      [],
    ]);

    const processed = await new CrmWorkerRepository(sql).processOperatorMessage(
      {
        ...leadUpdateWebhook,
        eventType: "ONIMCONNECTORMESSAGEADD",
        payload: {
          data: {
            CONNECTOR: "brixchat",
            LINE: "126",
            MESSAGES: [
              {
                chat: { id: "+905055120792" },
                message: {
                  id: "3255566",
                  text: "[b]Hasan Yıldırım:[/b] [br]Merhaba [image]",
                },
                im: { chat_id: "79924", message_id: "3255566" },
              },
            ],
          },
        },
      },
    );

    expect(processed).toBe(true);
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO messages"),
    );
    expect(insert?.values).toContain("*Hasan Yıldırım:*\nMerhaba");
    expect(insert?.values).not.toContain(
      "[b]Hasan Yıldırım:[/b] [br]Merhaba [image]",
    );
  });

  it("does not accept Bitrix operator messages when outgoing sync is disabled", async () => {
    const { sql, calls } = createSqlStub();

    const processed = await new CrmWorkerRepository(sql).processOperatorMessage(
      {
        ...leadUpdateWebhook,
        eventType: "ONIMCONNECTORMESSAGEADD",
        settings: { openChannels: { outgoingEnabled: false } },
        payload: {
          data: {
            CONNECTOR: "brixchat",
            LINE: "114",
            MESSAGES: [],
          },
        },
      },
    );

    expect(processed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("ignores dialog finish when session close sync is disabled", async () => {
    const { sql, calls } = createSqlStub();

    const processed = await new CrmWorkerRepository(
      sql,
    ).processOpenChannelSessionEvent({
      ...leadUpdateWebhook,
      eventType: "ONIMCONNECTORDIALOGFINISH",
      settings: { openChannels: { sessionCloseSync: false } },
    });

    expect(processed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("closes the matching local session on Bitrix dialog finish", async () => {
    const { sql, calls } = createSqlStub([
      [{ id: "40000000-0000-4000-8000-000000000001" }],
    ]);

    const processed = await new CrmWorkerRepository(
      sql,
    ).processOpenChannelSessionEvent({
      ...leadUpdateWebhook,
      eventType: "ONIMCONNECTORDIALOGFINISH",
      settings: { openChannels: { sessionCloseSync: true } },
      payload: {
        data: {
          CONNECTOR: "brixchat",
          LINE: "114",
          DATA: [
            {
              connector: {
                connector_id: "brixchat",
                line_id: 114,
                chat_id: 8,
                user_id: 905076210286,
              },
              session: { id: 3282, closed: "Y" },
              chat: { id: 8 },
              user: { id: 905076210286 },
            },
          ],
        },
      },
    });

    expect(processed).toBe(true);
    const sessionUpdate = calls.find((call) =>
      call.text.includes("UPDATE bitrix_open_channel_sessions"),
    );
    expect(sessionUpdate?.values).toContain("closed");
    expect(sessionUpdate?.values).toContain("3282");
    expect(sessionUpdate?.values).toContain("8");
  });

  it("closes a local session from Bitrix form-encoded dialog fields", async () => {
    const { sql, calls } = createSqlStub([
      [{ id: "40000000-0000-4000-8000-000000000001" }],
    ]);

    const processed = await new CrmWorkerRepository(
      sql,
    ).processOpenChannelSessionEvent({
      ...leadUpdateWebhook,
      eventType: "ONIMCONNECTORDIALOGFINISH",
      settings: { openChannels: { sessionCloseSync: true } },
      payload: {
        "data[CONNECTOR]": "brixchat",
        "data[LINE]": "114",
        "data[DATA][0][connector][chat_id]": "repair-chat",
        "data[DATA][0][connector][user_id]": "66090",
        "data[DATA][0][session][id]": "77944",
        "data[DATA][0][session][closed]": "Y",
        "data[DATA][0][chat][id]": "repair-chat",
        "data[DATA][0][user][id]": "66090",
      },
    });

    expect(processed).toBe(true);
    const sessionUpdate = calls.find((call) =>
      call.text.includes("UPDATE bitrix_open_channel_sessions"),
    );
    expect(sessionUpdate?.values).toContain("closed");
    expect(sessionUpdate?.values).toContain("77944");
    expect(sessionUpdate?.values).toContain("repair-chat");
    expect(sessionUpdate?.values).toContain("66090");
  });

  it("records the latest connector event for observability", async () => {
    const { sql, calls } = createSqlStub([
      [{ id: "50000000-0000-4000-8000-000000000001" }],
    ]);

    const touched = await new CrmWorkerRepository(sql).touchOpenChannelEvent({
      ...leadUpdateWebhook,
      eventType: "ONIMCONNECTORMESSAGEADD",
      payload: {
        data: {
          CONNECTOR: "brixchat",
          LINE: "114",
        },
      },
    });

    expect(touched).toBe(true);
    expect(calls[0]?.text).toContain("last_event_at=now()");
    expect(calls[0]?.values).toContain("brixchat");
    expect(calls[0]?.values).toContain("114");
  });
});

describe("CrmWorkerRepository timeline media context", () => {
  it("selects only stored clean attachments and reports pending media", async () => {
    const { sql, calls } = createSqlStub([
      [
        {
          entity_type: "lead",
          external_id: "172336",
          attachments: [],
          pending_attachment_count: 0,
        },
      ],
    ]);

    await new CrmWorkerRepository(sql).timelineContext({
      id: "80000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000001",
      connectionId: "10000000-0000-4000-8000-000000000001",
      jobType: "timeline.comment",
      aggregateId: "20000000-0000-4000-8000-000000000001",
      idempotencyKey: "timeline:message",
      payload: {},
      attemptCount: 1,
      maxAttempts: 5,
      authMode: "oauth",
      portalUrl: "https://example.bitrix24.com",
      credentialsEncrypted: "encrypted",
      settings: {},
      automationDefaultChannelId: null,
    });

    expect(calls[0]?.text).toContain("a.processing_status='stored'");
    expect(calls[0]?.text).toContain("a.scan_status='clean'");
    expect(calls[0]?.text).toContain("'mimeType'");
    expect(calls[0]?.text).toContain("pending_attachment_count");
    expect(calls[0]?.text).toContain("channel.phone_number AS channel_phone");
    expect(calls[0]?.text).toContain("channel.id=conversation.channel_id");
  });
});
