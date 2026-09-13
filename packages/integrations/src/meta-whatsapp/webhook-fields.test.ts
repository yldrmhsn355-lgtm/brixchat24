import { describe, expect, it } from "vitest";
import {
  META_WHATSAPP_UNSUBSCRIBED_FIELDS,
  META_WHATSAPP_WEBHOOK_FIELDS,
  extractMetaWebhookChanges,
  metaWebhookEventType,
  metaWebhookFieldFromEventType,
  metaWebhookRealtimeEventType,
  metaWebhookTargetsPhone,
  normalizeMetaWebhookField,
} from "./webhook-fields";

describe("Meta WhatsApp webhook field registry", () => {
  it("covers every v25.0 field and the current dashboard-unsubscribed field", () => {
    expect(META_WHATSAPP_WEBHOOK_FIELDS).toHaveLength(33);
    expect(META_WHATSAPP_UNSUBSCRIBED_FIELDS).toEqual(["message_echoes"]);
    expect(
      META_WHATSAPP_UNSUBSCRIBED_FIELDS.every((field) =>
        META_WHATSAPP_WEBHOOK_FIELDS.includes(field),
      ),
    ).toBe(true);
  });

  it.each(META_WHATSAPP_WEBHOOK_FIELDS)("normalizes and routes %s", (field) => {
    const [change] = extractMetaWebhookChanges({
      object: "whatsapp_business_account",
      entry: [{ id: "waba-1", changes: [{ field, value: { test: true } }] }],
    });
    expect(change).toMatchObject({
      field,
      knownField: true,
      phoneNumberIds: [],
    });
    expect(normalizeMetaWebhookField(field)).toBe(field);
    expect(metaWebhookEventType(field)).toBe(`meta.${field}`);
    expect(metaWebhookFieldFromEventType(`meta.${field}`)).toBe(field);
    expect(metaWebhookRealtimeEventType(field)).toBe(
      `whatsapp.webhook.${field}`,
    );
  });

  it("splits entries into independently deduplicated changes", () => {
    const changes = extractMetaWebhookChanges({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            { field: "account_settings_update", value: { setting: "calls" } },
            {
              field: "messages",
              value: { metadata: { phone_number_id: "phone-1" } },
            },
          ],
        },
      ],
    });

    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      entryIndex: 0,
      changeIndex: 0,
      entryId: "waba-1",
      field: "account_settings_update",
      knownField: true,
      phoneNumberIds: [],
    });
    expect(changes[1]?.phoneNumberIds).toEqual(["phone-1"]);
    expect((changes[0]?.payload.changes as Array<unknown>).length).toBe(1);
  });

  it("keeps future safe field names and quarantines unsafe names as unknown", () => {
    expect(normalizeMetaWebhookField("future_field")).toBe("future_field");
    expect(normalizeMetaWebhookField("messages;drop table")).toBe("unknown");
  });

  it("accepts WABA-level events without metadata and rejects explicit phone mismatches", () => {
    expect(metaWebhookTargetsPhone({ phoneNumberIds: [] }, "phone-1")).toBe(
      true,
    );
    expect(
      metaWebhookTargetsPhone({ phoneNumberIds: ["phone-1"] }, "phone-1"),
    ).toBe(true);
    expect(
      metaWebhookTargetsPhone({ phoneNumberIds: ["phone-2"] }, "phone-1"),
    ).toBe(false);
  });
});
