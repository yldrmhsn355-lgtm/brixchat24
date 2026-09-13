import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureTelegramWebhook,
  normalizeTelegramWebhookUpdate,
  TelegramBotProvider,
} from "./provider";

afterEach(() => vi.unstubAllGlobals());

describe("TelegramBotProvider", () => {
  it("configures a secret webhook after validating the bot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 42, username: "brix_bot" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      configureTelegramWebhook({
        accessToken: "token",
        callbackUrl: "https://api.example.test/webhooks/telegram/public",
        secretToken: "secret",
      }),
    ).resolves.toMatchObject({ id: 42, username: "brix_bot" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      secret_token: "secret",
      allowed_updates: ["message"],
    });
  });

  it("sends text to the numeric chat identity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 9, date: 1_700_000_000 },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new TelegramBotProvider().sendMessage({
        channelId: "channel",
        phoneNumberId: "42",
        recipient: "+12345678",
        text: "Merhaba",
        idempotencyKey: "key",
        accessToken: "token",
      }),
    ).resolves.toMatchObject({ providerMessageId: "12345678:9" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      chat_id: "12345678",
      text: "Merhaba",
    });
  });

  it("accepts only private text updates and builds a stable identity", () => {
    expect(
      normalizeTelegramWebhookUpdate({
        update_id: 77,
        message: {
          message_id: 9,
          date: 1_700_000_000,
          text: "Merhaba",
          chat: { id: 12345678, type: "private" },
          from: { id: 12345678, first_name: "Ada" },
        },
      }),
    ).toMatchObject({
      eventKey: "telegram:77",
      payload: {
        changes: [
          {
            value: {
              messages: [{ id: "12345678:9", from: "12345678" }],
            },
          },
        ],
      },
    });
    expect(
      normalizeTelegramWebhookUpdate({
        update_id: 78,
        message: {
          message_id: 1,
          text: "group",
          chat: { id: -1, type: "group" },
          from: { id: 1 },
        },
      }),
    ).toBeNull();
  });
});
