import { createHash } from "node:crypto";
import { BitrixRestClient } from "../crm/bitrix-client";
import { BitrixError } from "../crm/utils";
export type OpenChannelsScenario =
  "success" | "temporary_error" | "permanent_error" | "rate_limit";
export interface BitrixOpenLine {
  id: string;
  name: string;
  active: boolean;
  crmEnabled: boolean;
  crmCreate: "lead" | "deal" | "none";
  queueUserIds: string[];
}
export interface BitrixConnectorStatus {
  lineId: string;
  connectorId: string;
  configured: boolean;
  active: boolean;
  error: boolean;
}
export interface BitrixIncomingMessage {
  connectorId: string;
  lineId: string;
  externalUserCode: string;
  phone?: string;
  displayName?: string;
  text: string;
  sourceMarker: string;
  timestamp?: number;
  managerUserId?: string;
}
export type BitrixOpenChannelsLeadState =
  | { status: "active"; externalId: string }
  | { status: "unlinked" }
  | { status: "stale"; externalId: string };
export interface BitrixOpenChannelsConnector {
  register(i: { name: string }): Promise<{ connectorId: string }>;
  listLines(): Promise<BitrixOpenLine[]>;
  createLine(i: {
    name: string;
    queueUserIds: string[];
  }): Promise<{ lineId: string }>;
  deleteLine(i: { lineId: string }): Promise<void>;
  activate(i: { connectorId: string; lineId: string }): Promise<void>;
  configure(i: {
    connectorId: string;
    lineId: string;
    channelId: string;
    channelName: string;
    channelUrl: string;
  }): Promise<BitrixConnectorStatus>;
  status(i: {
    connectorId: string;
    lineId: string;
  }): Promise<BitrixConnectorStatus>;
  deactivate(i: { connectorId: string; lineId: string }): Promise<void>;
  sendIncoming(i: BitrixIncomingMessage): Promise<{
    chatId: string;
    sessionId: string;
    messageId: string;
  }>;
  findLeadForChat(i: {
    chatId: string;
    sessionId: string;
  }): Promise<BitrixOpenChannelsLeadState>;
  ensureLeadForChat(i: {
    chatId: string;
    sessionId: string;
    phone?: string;
  }): Promise<{ externalId: string }>;
  acknowledgeDelivery(i: {
    connectorId: string;
    lineId: string;
    imChatId: string;
    imMessageId: string;
    externalChatId: string;
    externalMessageId: string;
    deliveredAt?: number;
  }): Promise<void>;
  closeSession(i: { sessionId: string }): Promise<void>;
}

const CONNECTOR_EVENTS = [
  "OnImConnectorMessageAdd",
  "OnImConnectorDialogStart",
  "OnImConnectorDialogFinish",
  "OnImConnectorLineDelete",
  "OnImConnectorStatusDelete",
] as const;
const CONNECTOR_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5MCA5MCI+PHJlY3Qgd2lkdGg9IjkwIiBoZWlnaHQ9IjkwIiByeD0iMjAiIGZpbGw9IiMwMGExZTQiLz48cGF0aCBkPSJNMjIgMjZoNDZhNiA2IDAgMCAxIDYgNnYyNmE2IDYgMCAwIDEtNiA2SDQzbC0xMyAxMHYtMTBIMjJhNiA2IDAgMCAxLTYtNlYzMmE2IDYgMCAwIDEgNi02WiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";

const bitrixBoolean = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "Y";

export class BitrixRestOpenChannelsConnector implements BitrixOpenChannelsConnector {
  constructor(
    private readonly client: BitrixRestClient,
    private readonly options: {
      connectorId: string;
      placementHandler: string;
      eventHandler?: string;
    },
  ) {}

  async register(i: { name: string }) {
    await this.client.call("imconnector.register", {
      ID: this.options.connectorId,
      NAME: i.name,
      ICON: { DATA_IMAGE: CONNECTOR_ICON, COLOR: "#00a1e4", SIZE: "90%" },
      PLACEMENT_HANDLER: this.options.placementHandler,
      NEED_SIGNATURE: true,
      NEED_SYSTEM_MESSAGES: true,
      CHAT_GROUP: false,
    });
    const handler = this.options.eventHandler ?? this.options.placementHandler;
    for (const event of CONNECTOR_EVENTS)
      await this.client.call("event.bind", { event, handler });
    return { connectorId: this.options.connectorId };
  }

  async listLines(): Promise<BitrixOpenLine[]> {
    const response = await this.client.call<Array<Record<string, unknown>>>(
      "imopenlines.config.list.get",
      {
        PARAMS: {
          select: ["ID", "LINE_NAME", "ACTIVE", "CRM", "CRM_CREATE"],
          order: { LINE_NAME: "asc" },
          limit: 200,
          offset: 0,
        },
        OPTIONS: { QUEUE: "Y" },
      },
    );
    return (response.result ?? []).map((row) => {
      const crmCreate = String(row.CRM_CREATE ?? "").toLowerCase();
      return {
        id: String(row.ID),
        name: String(row.LINE_NAME ?? row.ID),
        active: bitrixBoolean(row.ACTIVE),
        crmEnabled: bitrixBoolean(row.CRM),
        crmCreate:
          crmCreate === "lead" || crmCreate === "deal" ? crmCreate : "none",
        queueUserIds: Array.isArray(row.QUEUE)
          ? row.QUEUE.map((value) => String(value))
          : [],
      };
    });
  }

  async createLine(i: { name: string; queueUserIds: string[] }) {
    if (!i.queueUserIds.length)
      throw new OpenChannelsError("OPEN_CHANNEL_QUEUE_REQUIRED", false);
    const response = await this.client.call<number>("imopenlines.config.add", {
      PARAMS: {
        LINE_NAME: i.name,
        ACTIVE: "Y",
        QUEUE: i.queueUserIds.map((userId) => ({
          ENTITY_TYPE: "user",
          ENTITY_ID: userId,
        })),
        QUEUE_TYPE: "all",
        QUEUE_TIME: 60,
        NO_ANSWER_TIME: 300,
        WELCOME_MESSAGE: "N",
        WORKTIME_ENABLE: "N",
        CRM: "N",
        CRM_CREATE: "none",
        LANGUAGE_ID: "tr",
      },
    });
    const lineId = String(response.result ?? "");
    if (!lineId)
      throw new OpenChannelsError("BITRIX_LINE_CREATE_FAILED", false);
    return { lineId };
  }

  async deleteLine(i: { lineId: string }) {
    await this.client.call("imopenlines.config.delete", {
      CONFIG_ID: Number(i.lineId),
    });
  }

  async activate(i: { connectorId: string; lineId: string }) {
    await this.client.call("imconnector.activate", {
      CONNECTOR: i.connectorId,
      LINE: Number(i.lineId),
      ACTIVE: 1,
    });
  }

  async configure(i: {
    connectorId: string;
    lineId: string;
    channelId: string;
    channelName: string;
    channelUrl: string;
  }) {
    await this.activate(i);
    await this.client.call("imconnector.connector.data.set", {
      CONNECTOR: i.connectorId,
      LINE: Number(i.lineId),
      DATA: {
        ID: i.channelId,
        URL: i.channelUrl,
        URL_IM: i.channelUrl,
        NAME: i.channelName,
      },
    });
    const status = await this.status(i);
    if (!status.configured || !status.active || status.error)
      throw new OpenChannelsError("OPEN_CHANNELS_NOT_READY", false);
    return status;
  }

  async status(i: { connectorId: string; lineId: string }) {
    const response = await this.client.call<Record<string, unknown>>(
      "imconnector.status",
      {
        CONNECTOR: i.connectorId,
        LINE: Number(i.lineId),
      },
    );
    const result = response.result ?? {};
    return {
      lineId: String(result.LINE ?? i.lineId),
      connectorId: String(result.CONNECTOR ?? i.connectorId),
      configured: bitrixBoolean(result.CONFIGURED),
      active: bitrixBoolean(result.STATUS),
      error: bitrixBoolean(result.ERROR),
    };
  }

  async deactivate(i: { connectorId: string; lineId: string }) {
    await this.client.call("imconnector.activate", {
      CONNECTOR: i.connectorId,
      LINE: Number(i.lineId),
      ACTIVE: 0,
    });
  }

  async sendIncoming(i: BitrixIncomingMessage) {
    if (i.managerUserId && !/^\d+$/.test(i.managerUserId))
      throw new OpenChannelsError("BITRIX_MANAGER_USER_INVALID", false);
    const displayName = (i.displayName ?? i.externalUserCode).trim();
    const [name, ...lastNameParts] = displayName.split(/\s+/);
    const user: Record<string, unknown> = {
      id: i.externalUserCode,
      name: name?.slice(0, 25) || "WhatsApp",
    };
    if (lastNameParts.length)
      user.last_name = lastNameParts.join(" ").slice(0, 25);
    if (i.phone) user.phone = i.phone;
    const response = await this.client.call<{
      DATA?: {
        RESULT?: Array<{
          chat?: { ID?: string; id?: string };
          session?: {
            ID?: string;
            id?: string;
            CHAT_ID?: string;
            chat_id?: string;
          };
          message?: { ID?: string; id?: string };
        }>;
      };
    }>("imconnector.send.messages", {
      CONNECTOR: i.connectorId,
      LINE: Number(i.lineId),
      MESSAGES: [
        {
          user,
          message: {
            id: i.sourceMarker,
            text: i.text,
            date: i.timestamp ?? Math.floor(Date.now() / 1000),
            ...(i.managerUserId ? { user_id: Number(i.managerUserId) } : {}),
          },
          chat: {
            id: i.externalUserCode,
            name: displayName || i.externalUserCode,
          },
        },
      ],
    });
    const item = response.result?.DATA?.RESULT?.[0];
    const chatId = item?.session?.CHAT_ID ?? item?.session?.chat_id;
    const sessionId = item?.session?.ID ?? item?.session?.id;
    const messageId = item?.message?.ID ?? item?.message?.id;
    if (!chatId || !sessionId || !messageId)
      throw new OpenChannelsError("BITRIX_INVALID_RESPONSE", false);
    return {
      chatId: String(chatId),
      sessionId: String(sessionId),
      messageId: String(messageId),
    };
  }

  private async sessionLead(i: { chatId: string; sessionId: string }) {
    const response = await this.client.call<Record<string, unknown>>(
      "imopenlines.session.history.get",
      {
        SESSION_ID: Number(i.sessionId),
      },
    );
    const result = response.result ?? {};
    const chatId = String(result.chatId ?? i.chatId);
    const chat = (
      (result.chat ?? {}) as Record<string, Record<string, unknown>>
    )[chatId];
    const entityData = String(chat?.entityData2 ?? chat?.ENTITY_DATA_2 ?? "");
    const tokens = entityData.split("|");
    const leadIndex = tokens.findIndex(
      (token) => token.toUpperCase() === "LEAD",
    );
    const leadId = leadIndex >= 0 ? tokens[leadIndex + 1] : undefined;
    return leadId && leadId !== "0" ? leadId : null;
  }

  async findLeadForChat(i: { chatId: string; sessionId: string }) {
    const linkedLeadId = await this.sessionLead(i);
    if (!linkedLeadId) return { status: "unlinked" as const };
    try {
      const existing = await this.client.call<Record<string, unknown>>(
        "crm.lead.get",
        { id: linkedLeadId },
      );
      if (existing.result)
        return { status: "active" as const, externalId: linkedLeadId };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (code !== "NOT_FOUND") throw error;
    }
    return { status: "stale" as const, externalId: linkedLeadId };
  }

  async ensureLeadForChat(i: {
    chatId: string;
    sessionId: string;
    phone?: string;
  }) {
    const normalizeLeadPhone = async (externalId: string) => {
      const mobilePhone = i.phone?.trim();
      if (!mobilePhone) return;
      await this.client.call("crm.lead.update", {
        id: externalId,
        fields: {
          PHONE: [{ VALUE: mobilePhone, VALUE_TYPE: "MOBILE" }],
        },
      });
    };
    const existingLead = await this.findLeadForChat(i);
    if (existingLead.status === "active") {
      await normalizeLeadPhone(existingLead.externalId);
      return { externalId: existingLead.externalId };
    }
    if (existingLead.status === "stale")
      throw new OpenChannelsError("BITRIX_CRM_LINK_STALE", false);
    await this.client.call<boolean>("imopenlines.crm.lead.create", {
      CHAT_ID: Number(i.chatId),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const createdLead = await this.findLeadForChat(i);
      if (createdLead.status === "active") {
        await normalizeLeadPhone(createdLead.externalId);
        return { externalId: createdLead.externalId };
      }
      if (createdLead.status === "stale")
        throw new OpenChannelsError("BITRIX_CRM_LINK_STALE", false);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new OpenChannelsError("BITRIX_CRM_LINK_MISSING", true);
  }

  async acknowledgeDelivery(i: {
    connectorId: string;
    lineId: string;
    imChatId: string;
    imMessageId: string;
    externalChatId: string;
    externalMessageId: string;
    deliveredAt?: number;
  }) {
    await this.client.call("imconnector.send.status.delivery", {
      CONNECTOR: i.connectorId,
      LINE: Number(i.lineId),
      MESSAGES: [
        {
          im: {
            chat_id: Number(i.imChatId),
            message_id: Number(i.imMessageId),
          },
          message: {
            id: [i.externalMessageId],
            date: i.deliveredAt ?? Math.floor(Date.now() / 1000),
          },
          chat: { id: i.externalChatId },
        },
      ],
    });
  }

  async closeSession() {
    // Bitrix exposes session closure through the open-line operator APIs; the
    // connector REST surface has no portable close method. Keep this explicit
    // no-op until a line-specific close operation is configured.
  }
}
export class OpenChannelsError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
  ) {
    super(code);
  }
}
export const shouldFallbackToDirectCrmLead = (error: unknown) =>
  error instanceof BitrixError &&
  error.providerCode === "ERROR_USER_NOT_OPERATOR";
export class FakeBitrixOpenChannelsConnector implements BitrixOpenChannelsConnector {
  constructor(private scenario: OpenChannelsScenario = "success") {}
  private ready() {
    if (this.scenario !== "success")
      throw new OpenChannelsError(
        this.scenario,
        this.scenario !== "permanent_error",
      );
  }
  private id(p: string, v: string) {
    return `${p}_${createHash("sha256").update(v).digest("hex").slice(0, 16)}`;
  }
  async register(i: { name: string }) {
    this.ready();
    return { connectorId: this.id("connector", i.name) };
  }
  async listLines() {
    this.ready();
    return [
      {
        id: "fake-line",
        name: "Fake Open Line",
        active: true,
        crmEnabled: true,
        crmCreate: "deal" as const,
        queueUserIds: ["1"],
      },
    ];
  }
  async createLine(i: { name: string; queueUserIds: string[] }) {
    this.ready();
    return { lineId: this.id("line", i.name) };
  }
  async deleteLine() {
    this.ready();
  }
  async activate() {
    this.ready();
  }
  async configure(i: { connectorId: string; lineId: string }) {
    this.ready();
    return {
      lineId: i.lineId,
      connectorId: i.connectorId,
      configured: true,
      active: true,
      error: false,
    };
  }
  async status(i: { connectorId: string; lineId: string }) {
    this.ready();
    return {
      lineId: i.lineId,
      connectorId: i.connectorId,
      configured: true,
      active: true,
      error: false,
    };
  }
  async deactivate() {
    this.ready();
  }
  async sendIncoming(i: {
    connectorId: string;
    lineId: string;
    externalUserCode: string;
    text: string;
    sourceMarker: string;
  }) {
    this.ready();
    return {
      chatId: this.id("chat", i.externalUserCode),
      sessionId: this.id("session", i.externalUserCode),
      messageId: this.id("message", i.sourceMarker),
    };
  }
  async closeSession() {
    this.ready();
  }
  async findLeadForChat() {
    this.ready();
    return { status: "unlinked" as const };
  }
  async ensureLeadForChat(i: { chatId: string }) {
    this.ready();
    return { externalId: this.id("lead", i.chatId) };
  }
  async acknowledgeDelivery() {
    this.ready();
  }
}
export const bothModeTimelinePolicy = (mode: string, configured?: string) =>
  mode === "both"
    ? (configured ?? "per_message")
    : mode === "open_channels"
      ? "disabled"
      : (configured ?? "per_message");
export * from "./auto-crm";
export * from "./responsibility";
