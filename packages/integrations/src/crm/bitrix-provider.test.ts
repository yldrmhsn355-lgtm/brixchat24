import { describe, expect, it, vi } from "vitest";
import { BitrixRestClient } from "./bitrix-client";
import {
  Bitrix24Provider,
} from "./bitrix-provider";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Bitrix24Provider pipelines", () => {
  it("reads nested categories and uses the default pipeline stage code", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            categories: [
              { id: 0, name: "General", isDefault: "Y" },
              { id: 7, name: "Renewals", isDefault: "N" },
            ],
          },
          total: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ STATUS_ID: "NEW", NAME: "New", SORT: 10 }],
          total: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ STATUS_ID: "C7:NEW", NAME: "New", SORT: 10 }],
          total: 1,
        }),
      );
    const client = new BitrixRestClient({
      portalUrl: "https://portal.bitrix24.com.tr",
      accessToken: "access-token",
      fetcher,
    });
    const provider = new Bitrix24Provider(
      client,
      "https://portal.bitrix24.com.tr",
    );

    await expect(provider.listPipelines()).resolves.toEqual([
      expect.objectContaining({
        externalId: "0",
        name: "General",
        stages: [expect.objectContaining({ externalId: "NEW" })],
      }),
      expect.objectContaining({
        externalId: "7",
        name: "Renewals",
        stages: [expect.objectContaining({ externalId: "C7:NEW" })],
      }),
    ]);

    const stageBodies = fetcher.mock.calls
      .slice(1)
      .map((call) => call[1]!.body as URLSearchParams);
    expect(stageBodies[0]!.get("filter[ENTITY_ID]")).toBe("DEAL_STAGE");
    expect(stageBodies[1]!.get("filter[ENTITY_ID]")).toBe("DEAL_STAGE_7");
    expect(stageBodies[0]!.get("order[SORT]")).toBe("ASC");
  });
});

describe("Bitrix24Provider phone matching", () => {
  it("uses Bitrix duplicate matching so legacy phone formatting is reused", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: { LEAD: [78642] } }))
      .mockResolvedValueOnce(
        jsonResponse({
          result: [{ ID: "78642", TITLE: "Existing converted lead" }],
          total: 1,
        }),
      );
    const provider = new Bitrix24Provider(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "access-token",
        fetcher,
      }),
      "https://portal.bitrix24.com.tr",
    );

    await expect(
      provider.findEntities({ phone: "+1 709-277-3599" }),
    ).resolves.toEqual([
      {
        entityType: "lead",
        externalId: "78642",
        displayName: "Existing converted lead",
        confidence: 0.95,
        source: "phone",
      },
    ]);

    expect(fetcher.mock.calls[0]?.[0]).toContain("crm.duplicate.findbycomm");
    const duplicateBody = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(duplicateBody.get("type")).toBe("PHONE");
    expect(duplicateBody.get("values[0]")).toBe("+17092773599");
    const listBody = fetcher.mock.calls[1]![1]!.body as URLSearchParams;
    expect(listBody.get("filter[@ID][0]")).toBe("78642");
  });

  it("returns every duplicate so ambiguous phones cannot create another lead", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ result: { CONTACT: [12], LEAD: [34] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ result: [{ ID: "12", NAME: "Existing contact" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ result: [{ ID: "34", TITLE: "Existing lead" }] }),
      );
    const provider = new Bitrix24Provider(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "access-token",
        fetcher,
      }),
      "https://portal.bitrix24.com.tr",
    );

    await expect(
      provider.findEntities({ phone: "+905551234567" }),
    ).resolves.toEqual([
      expect.objectContaining({ entityType: "contact", externalId: "12" }),
      expect.objectContaining({ entityType: "lead", externalId: "34" }),
    ]);
  });

  it("keeps duplicate IDs protective when detail hydration is unavailable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: { LEAD: [78642] } }))
      .mockResolvedValueOnce(jsonResponse({ result: [] }));
    const provider = new Bitrix24Provider(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "access-token",
        fetcher,
      }),
      "https://portal.bitrix24.com.tr",
    );

    await expect(
      provider.findEntities({ phone: "+17092773599" }),
    ).resolves.toEqual([
      expect.objectContaining({
        entityType: "lead",
        externalId: "78642",
        displayName: "Lead #78642",
      }),
    ]);
  });
});

describe("Bitrix24Provider timeline comments", () => {
  it("sends clean media as Bitrix timeline FILES", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: 62589 }));
    const provider = new Bitrix24Provider(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "access-token",
        fetcher,
      }),
      "https://portal.bitrix24.com.tr",
    );

    await expect(
      provider.addTimelineComment({
        entityType: "lead",
        externalId: "172336",
        text: "WhatsApp media",
        idempotencyKey: "message-with-media",
        attachments: [
          {
            filename: "photo.jpg",
            contentBase64: "aW1hZ2UtYnl0ZXM=",
          },
        ],
      }),
    ).resolves.toEqual({ externalId: "62589" });

    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("fields[FILES][0][0]")).toBe("photo.jpg");
    expect(body.get("fields[FILES][0][1]")).toBe("aW1hZ2UtYnl0ZXM=");
    expect(body.get("fields[COMMENT]")).toBe("WhatsApp media");
  });

  it("posts the comment verbatim without scanning the timeline first", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ result: 77 }));
    const provider = new Bitrix24Provider(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "access-token",
        fetcher,
      }),
      "https://portal.bitrix24.com.tr",
    );

    await expect(
      provider.addTimelineComment({
        entityType: "lead",
        externalId: "172336",
        text: "WhatsApp message",
        idempotencyKey: "message-1",
      }),
    ).resolves.toEqual({ externalId: "77" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "crm.timeline.comment.add",
    );
    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("fields[COMMENT]")).toBe("WhatsApp message");
    expect(body.get("fields[COMMENT]")).not.toContain("BrixChat-ID");
  });
});
