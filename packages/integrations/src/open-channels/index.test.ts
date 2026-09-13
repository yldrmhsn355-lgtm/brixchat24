import { describe, expect, it, vi } from "vitest";
import { BitrixRestClient } from "../crm/bitrix-client";
import {
  BitrixRestOpenChannelsConnector,
  shouldFallbackToDirectCrmLead,
} from "./index";

function jsonResponse(result: unknown) {
  return new Response(JSON.stringify({ result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bitrixErrorResponse(
  error: string,
  errorDescription: string,
  status = 400,
) {
  return new Response(
    JSON.stringify({ error, error_description: errorDescription }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function methodName(call: Parameters<typeof fetch>) {
  return String(call[0]).match(/\/([^/]+)\.json$/)?.[1];
}

describe("Bitrix REST Open Channels connector", () => {
  it("registers the connector and all required events", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(true));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
        eventHandler: "https://api.example.test/webhook",
      },
    );

    await expect(
      connector.register({ name: "BrixChat WhatsApp" }),
    ).resolves.toEqual({ connectorId: "brixchat_org" });

    expect(fetcher).toHaveBeenCalledTimes(6);
    const registerBody = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(registerBody.get("ID")).toBe("brixchat_org");
    expect(registerBody.get("CHAT_GROUP")).toBe("false");
    const eventNames = fetcher.mock.calls
      .slice(1)
      .map((call) => (call[1]!.body as URLSearchParams).get("event"));
    expect(eventNames).toEqual([
      "OnImConnectorMessageAdd",
      "OnImConnectorDialogStart",
      "OnImConnectorDialogFinish",
      "OnImConnectorLineDelete",
      "OnImConnectorStatusDelete",
    ]);
  });

  it("lists lines and configures an active connector", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            ID: "12",
            LINE_NAME: "Sales",
            ACTIVE: "Y",
            CRM: "Y",
            CRM_CREATE: "deal",
            QUEUE: [7, 8],
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(
        jsonResponse({
          LINE: 12,
          CONNECTOR: "brixchat_org",
          CONFIGURED: true,
          STATUS: true,
          ERROR: false,
        }),
      );
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(connector.listLines()).resolves.toEqual([
      {
        id: "12",
        name: "Sales",
        active: true,
        crmEnabled: true,
        crmCreate: "deal",
        queueUserIds: ["7", "8"],
      },
    ]);
    await expect(
      connector.configure({
        connectorId: "brixchat_org",
        lineId: "12",
        channelId: "channel-1",
        channelName: "WhatsApp 0894",
        channelUrl: "https://www.example.test/app/channels",
      }),
    ).resolves.toMatchObject({ configured: true, active: true, error: false });

    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.config.list.get",
      "imconnector.activate",
      "imconnector.connector.data.set",
      "imconnector.status",
    ]);
    const activateBody = fetcher.mock.calls[1]![1]!.body as URLSearchParams;
    expect(activateBody.get("CONNECTOR")).toBe("brixchat_org");
    expect(activateBody.get("ACTIVE")).toBe("1");
    const dataBody = fetcher.mock.calls[2]![1]!.body as URLSearchParams;
    expect(dataBody.get("DATA[ID]")).toBe("channel-1");
    expect(dataBody.get("DATA[NAME]")).toBe("WhatsApp 0894");
  });

  it("deletes a newly-created line when provisioning must be compensated", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(true));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.deleteLine({ lineId: "126" }),
    ).resolves.toBeUndefined();

    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.config.delete",
    ]);
    const body = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("CONFIG_ID")).toBe("126");
  });

  it("sends the CRM-trackable phone payload and acknowledges delivery", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          SUCCESS: true,
          DATA: {
            RESULT: [
              {
                chat: { id: "external-chat-42" },
                session: { ID: "323", CHAT_ID: "1807" },
                message: { id: "external-message-42" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ SUCCESS: true, DATA: [] }));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.sendIncoming({
        connectorId: "brixchat_org",
        lineId: "12",
        externalUserCode: "905551112233",
        phone: "+905551112233",
        displayName: "Ada Lovelace",
        text: "Merhaba",
        sourceMarker: "channel:1:meta:message-1",
        timestamp: 1_738_065_600,
        managerUserId: "32",
      }),
    ).resolves.toEqual({
      chatId: "1807",
      sessionId: "323",
      messageId: "external-message-42",
    });

    const incomingBody = fetcher.mock.calls[0]![1]!.body as URLSearchParams;
    expect(incomingBody.get("MESSAGES[0][user][phone]")).toBe("+905551112233");
    expect(incomingBody.get("MESSAGES[0][user][name]")).toBe("Ada");
    expect(incomingBody.get("MESSAGES[0][user][last_name]")).toBe("Lovelace");
    expect(incomingBody.get("MESSAGES[0][message][user_id]")).toBe("32");
    expect(incomingBody.has("MESSAGES[0][message][disable_crm]")).toBe(false);

    await connector.acknowledgeDelivery({
      connectorId: "brixchat_org",
      lineId: "12",
      imChatId: "1807",
      imMessageId: "86497",
      externalChatId: "905551112233",
      externalMessageId: "provider-message-1",
      deliveredAt: 1_738_065_601,
    });
    const deliveryBody = fetcher.mock.calls[1]![1]!.body as URLSearchParams;
    expect(deliveryBody.get("MESSAGES[0][im][chat_id]")).toBe("1807");
    expect(deliveryBody.get("MESSAGES[0][message][id][0]")).toBe(
      "provider-message-1",
    );
  });

  it("rejects a non-numeric Bitrix manager id before sending", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.sendIncoming({
        connectorId: "brixchat_org",
        lineId: "12",
        externalUserCode: "905551112233",
        phone: "+905551112233",
        text: "Merhaba",
        sourceMarker: "channel:1:meta:message-1",
        managerUserId: "manager-32",
      }),
    ).rejects.toMatchObject({
      code: "BITRIX_MANAGER_USER_INVALID",
      retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  const sessionHistory = (leadId: string) =>
    jsonResponse({
      chatId: 1807,
      sessionId: 323,
      chat: {
        "1807": {
          entityData2: `LEAD|${leadId}|COMPANY|0|CONTACT|0|DEAL|0`,
        },
      },
    });

  it("reports a stale binding when the Bitrix chat points to a deleted lead", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionHistory("139636"))
      .mockResolvedValueOnce(bitrixErrorResponse("", "Not found"));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.ensureLeadForChat({ chatId: "1807", sessionId: "323" }),
    ).rejects.toMatchObject({
      code: "BITRIX_CRM_LINK_STALE",
      retryable: false,
    });
    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.session.history.get",
      "crm.lead.get",
    ]);
  });

  it("exposes a stale session lead so callers can try safe CRM fallback matching", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionHistory("139636"))
      .mockResolvedValueOnce(bitrixErrorResponse("", "Not found"));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.findLeadForChat({ chatId: "1807", sessionId: "323" }),
    ).resolves.toEqual({ status: "stale", externalId: "139636" });
    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.session.history.get",
      "crm.lead.get",
    ]);
  });

  it("finds an existing session lead without creating another lead", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionHistory("139636"))
      .mockResolvedValueOnce(jsonResponse({ ID: "139636" }));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.findLeadForChat({ chatId: "1807", sessionId: "323" }),
    ).resolves.toEqual({ status: "active", externalId: "139636" });
    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.session.history.get",
      "crm.lead.get",
    ]);
  });

  it("creates a lead from an unlinked Bitrix chat", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionHistory("0"))
      .mockResolvedValueOnce(jsonResponse(true))
      .mockResolvedValueOnce(sessionHistory("172337"))
      .mockResolvedValueOnce(jsonResponse({ ID: "172337" }))
      .mockResolvedValueOnce(jsonResponse(true));
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    await expect(
      connector.ensureLeadForChat({
        chatId: "1807",
        sessionId: "323",
        phone: "+905340384607",
      }),
    ).resolves.toEqual({ externalId: "172337" });
    expect(fetcher.mock.calls.map(methodName)).toEqual([
      "imopenlines.session.history.get",
      "imopenlines.crm.lead.create",
      "imopenlines.session.history.get",
      "crm.lead.get",
      "crm.lead.update",
    ]);
    expect(
      (fetcher.mock.calls[1]![1]!.body as URLSearchParams).get("CHAT_ID"),
    ).toBe("1807");
    const updateBody = fetcher.mock.calls[4]![1]!.body as URLSearchParams;
    expect(updateBody.get("fields[PHONE][0][VALUE]")).toBe("+905340384607");
    expect(updateBody.get("fields[PHONE][0][VALUE_TYPE]")).toBe("MOBILE");
  });

  it("falls back only when Bitrix rejects lead creation for a non-operator", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionHistory("0"))
      .mockResolvedValueOnce(
        bitrixErrorResponse(
          "ERROR_USER_NOT_OPERATOR",
          "The current user is not the session operator",
        ),
      );
    const connector = new BitrixRestOpenChannelsConnector(
      new BitrixRestClient({
        portalUrl: "https://portal.bitrix24.com.tr",
        accessToken: "token",
        fetcher,
      }),
      {
        connectorId: "brixchat_org",
        placementHandler: "https://api.example.test/placement",
      },
    );

    const error = await connector
      .ensureLeadForChat({ chatId: "1807", sessionId: "323" })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      code: "VALIDATION",
      providerCode: "ERROR_USER_NOT_OPERATOR",
    });
    expect(shouldFallbackToDirectCrmLead(error)).toBe(true);
    expect(
      shouldFallbackToDirectCrmLead({
        code: "VALIDATION",
        providerCode: "CHAT_ID",
      }),
    ).toBe(false);
  });
});
